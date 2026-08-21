import type { CompanyConfig } from "@applyrn/domain";
import { D1Repository } from "./repo.js";
import type { PollOutcome } from "./poll.js";
import { FetchBudget } from "./poll.js";
import { log } from "./logger.js";

/**
 * Poll scheduler: the two-minute cycle (PRD section 2.3 / Issue 5).
 *
 * Responsibilities:
 * - load enabled companies
 * - decide which companies are DUE this cycle (backoff + poll interval)
 * - fan out with BOUNDED concurrency (never more than CONCURRENCY_LIMIT
 *   in-flight source fetches)
 * - aggregate poll metrics per shard (data-driven shard key, no source-code
 *   company lists)
 * - retry undelivered notifications after the cycle
 *
 * The scheduler depends on the Poller contract, not on PollService directly,
 * so a future split into provider/shard Workers via service bindings can
 * implement the same interface without touching scheduler logic.
 */

/** A poller can run one company through the detect/persist/notify cycle. */
export interface Poller {
  pollCompany(
    company: CompanyConfig,
    now: string,
    opts?: { budget?: FetchBudget },
  ): Promise<PollOutcome>;
  retryUndelivered(now: string, opts?: { budget?: FetchBudget }): Promise<number>;
  /** System-level notice (e.g. scheduler staleness). Best-effort. */
  sendSystemAlert(message: string): Promise<boolean>;
}

/**
 * Data-driven shard key for a company. Today the provider IS the shard;
 * a future `shard` column on companies can override without source changes.
 * Keeping shard config in data, never in code (PRD Issue 5 acceptance).
 */
export function shardFor(company: CompanyConfig): string {
  return company.provider;
}

/** Max concurrent source fetches per scheduler cycle (free-tier safe). */
export const CONCURRENCY_LIMIT = 4;

/**
 * Max outbound fetches per invocation. Cloudflare's free plan caps
 * subrequests at 50 per invocation; one fetch per company per cycle would
 * exceed that at 63 companies and silently kill the tail of the watchlist
 * (observed in prod: exactly the last 13 companies failed with `network`).
 * runCycle rotates company shards across invocations so each invocation
 * stays under the cap while every company keeps its cadence.
 */
export const MAX_FETCHES_PER_INVOCATION = 40;

/**
 * Smallest shard count whose worst bucket stays within MAX_FETCHES_PER_INVOCATION.
 *
 * ceil(n / MAX) is a lower bound but NOT a guarantee: the company-id hash
 * is imperfect and can overfill a bucket (measured: 160 ids -> 41 in one
 * bucket, 240 -> 42), and detail-enrichment + retry fetches share the same
 * invocation budget. A cycle that exceeds the soft budget eats into the
 * free-plan 50-subrequest hard cap and can silently kill the watchlist tail
 * (the D-011 failure mode), so shard count must be computed from the real
 * distribution, not just the list length.
 */
export function shardCountFor(companies: readonly { id: string }[]): number {
  let k = Math.max(1, Math.ceil(companies.length / MAX_FETCHES_PER_INVOCATION));
  while (true) {
    const buckets = new Array<number>(k).fill(0);
    for (const c of companies) {
      const b = companyShard(c.id, k);
      const idx = b % k;
      buckets[idx] = (buckets[idx] ?? 0) + 1;
    }
    let worst = 0;
    for (const n of buckets) if (n > worst) worst = n;
    if (worst <= MAX_FETCHES_PER_INVOCATION) return k;
    k++; // one more shard reduces every bucket; iterate until within budget
  }
}

/** Stable bucket for a company: same id always lands in the same shard. */
export function companyShard(companyId: string, shardCount: number): number {
  let h = 0;
  for (let i = 0; i < companyId.length; i++) {
    h = (h * 31 + companyId.charCodeAt(i)) >>> 0;
  }
  return h % shardCount;
}

/** Which shard runs on this minute; 1-min cron rotates shards round-robin. */
export function minuteShard(now: string, shardCount: number): number {
  return Math.floor(new Date(now).getTime() / 60_000) % shardCount;
}

/**
 * Scheduler is considered stale when no cycle finished within this window.
 * Cadence is 2 minutes, so 15 minutes = 7 missed cycles (PRD Issue 11
 * heartbeat; catches a dead cron without false positives during quiet nights
 * where every company is in backoff).
 */
export const HEARTBEAT_STALE_MS = 15 * 60 * 1000;

/** Human-readable duration for stale-incident messages. */
export function formatAgeMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export type CycleSummary = {
  outcomes: PollOutcome[];
  skippedBackoff: number;
  skippedInterval: number;
  retried: number;
  durationMs: number;
};

export class PollScheduler implements Poller {
  constructor(
    private readonly repo: D1Repository,
    private readonly poller: Poller,
  ) {}

  /** Run one full cycle. Never throws: per-company failures are isolated. */
  async runCycle(now: string, opts?: { shard?: number }): Promise<CycleSummary> {
    const startedAt = Date.now();
    // Heartbeat baseline: capture the PREVIOUS cycle's finish before this
    // cycle writes its own metrics row, so staleness is measured against the
    // cycle that came before, not the one we just completed.
    const priorStatus = await this.repo.getSystemStatus();
    const companies = await this.repo.listEnabledCompanies();
    // Data-driven shard count: the smallest k whose worst bucket is within the
    // per-invocation fetch budget. ceil(n/40) is a lower bound but the id hash
    // can overfill (160 -> 41 in one bucket), which eats into the free-plan
    // 50-subrequest hard cap. shardCountFor guarantees the invariant.
    const shardCount = shardCountFor(companies);

    // Shard the watchlist across invocations (free-plan subrequest cap).
    // Companies are bucketed stably by id; the shard that runs rotates
    // every minute, so a company in shard 0 is polled on even minutes and
    // shard 1 on odd minutes -> every company keeps a ~2-minute cadence
    // while each invocation stays within MAX_FETCHES_PER_INVOCATION.
    // An explicit `shard` (from an external fallback trigger such as a
    // GitHub Actions poller) overrides the minute rotation so a coarser
    // schedule can still cover every shard deterministically.
    const shard =
      opts?.shard !== undefined && opts.shard >= 0 && opts.shard < shardCount
        ? opts.shard
        : minuteShard(now, shardCount);
    const candidates = companies.filter((c) => companyShard(c.id, shardCount) === shard);

    const due: CompanyConfig[] = [];
    let skippedBackoff = 0;
    let skippedInterval = 0;

    for (const company of candidates) {
      const state = await this.repo.getSourceState(company.id);
      if (state?.backoffUntil && state.backoffUntil > now) {
        skippedBackoff++;
        continue;
      }
      if (
        state &&
        !isDue(state.lastSuccessAt ?? state.lastFailureAt, company.pollIntervalSeconds, now)
      ) {
        skippedInterval++;
        continue;
      }
      due.push(company);
    }

    // One shared fetch budget for the whole invocation: list fetches are
    // planned (due.length), everything else — alert sends, undelivered
    // retries, detail enrichment — draws from what remains under the
    // free-plan 50-subrequest cap. Priority is encoded by who checks the
    // pool and when: sends gate before sending (deferring to the retry
    // queue when drained), retries stop when the pool is empty, and
    // enrichment is additionally capped at MAX_DETAIL_ENRICH_PER_INVOCATION
    // so a first-poll burst on a huge board cannot starve delivery.
    const budget = FetchBudget.afterListFetches(due.length);
    const outcomes = await mapWithConcurrency(due, CONCURRENCY_LIMIT, (company) =>
      this.poller.pollCompany(company, now, { budget }),
    );

    const retried = await this.poller.retryUndelivered(now, { budget });

    await this.recordMetrics(companies, outcomes, now, Date.now() - startedAt);

    const durationMs = Date.now() - startedAt;
    const summary: CycleSummary = {
      outcomes,
      skippedBackoff,
      skippedInterval,
      retried,
      durationMs,
    };

    // Structured cycle summary (PRD Issue 11: scheduler heartbeat). One JSON
    // line per cycle is the heartbeat: a missing line = a missed cron run.
    const ok = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.length - ok;
    log.info("cycle.completed", {
      companies: companies.length,
      polled: outcomes.length,
      ok,
      failed,
      skippedBackoff,
      skippedInterval,
      retried,
      durationMs,
      newJobs: outcomes.reduce((s, o) => s + o.newJobs, 0),
    });

    // Heartbeat staleness: if the previous cycle finished longer ago than
    // the staleness window, the cron may have stopped firing. Record an
    // incident once (deduped via the open system event); clear on recovery.
    //
    // 2026-08-21 (user): system events are DB + log ONLY — no Telegram.
    // The free-plan cron legitimately pauses for 15-60 min stretches
    // (verified: ~10 incidents/day in prod), so a staleness ping is pure
    // noise; real breakage shows up as missing job alerts, which still
    // deliver normally. The dashboard/EDN reads system_events for the ops
    // view, and the structured log keeps the observability trail.
    const status = priorStatus;
    if (status.lastPollAt) {
      const ageMs = Date.parse(now) - Date.parse(status.lastPollAt);
      const open = await this.repo.getOpenSystemEvent("scheduler-stale");
      if (Number.isFinite(ageMs) && ageMs > HEARTBEAT_STALE_MS && !open) {
        const message = `scheduler stale: last completed cycle ${formatAgeMs(ageMs)} ago`;
        await this.repo.recordSystemEvent("scheduler-stale", now, message);
        log.warn("scheduler.stale", { ageMs, lastPollAt: status.lastPollAt });
      } else if (open && Number.isFinite(ageMs) && ageMs <= HEARTBEAT_STALE_MS) {
        await this.repo.clearSystemEvents("scheduler-stale", now);
        log.info("scheduler.recovered", { lastPollAt: status.lastPollAt });
      }
    }

    return summary;
  }

  /** Poller contract passthrough (single-company manual trigger). */
  pollCompany(
    company: CompanyConfig,
    now: string,
    opts?: { budget?: FetchBudget },
  ): Promise<PollOutcome> {
    return this.poller.pollCompany(company, now, opts);
  }

  retryUndelivered(now: string, opts?: { budget?: FetchBudget }): Promise<number> {
    return this.poller.retryUndelivered(now, opts);
  }

  sendSystemAlert(message: string): Promise<boolean> {
    return this.poller.sendSystemAlert(message);
  }

  private async recordMetrics(
    companies: CompanyConfig[],
    outcomes: PollOutcome[],
    now: string,
    durationMs: number,
  ): Promise<void> {
    const byShard = new Map<
      string,
      { successful: number; failed: number; newJobs: number; polled: number }
    >();
    for (const o of outcomes) {
      const company = companies.find((c) => c.id === o.companyId);
      const key = company ? shardFor(company) : "unknown";
      const agg = byShard.get(key) ?? { successful: 0, failed: 0, newJobs: 0, polled: 0 };
      agg.polled++;
      if (o.ok) agg.successful++;
      else agg.failed++;
      agg.newJobs += o.newJobs;
      byShard.set(key, agg);
    }
    for (const [shard, agg] of byShard) {
      await this.repo.insertPollMetric({
        provider: shard.split(":")[0]!,
        shard,
        startedAt: now,
        finishedAt: new Date().toISOString(),
        companiesPolled: agg.polled,
        successful: agg.successful,
        failed: agg.failed,
        newJobs: agg.newJobs,
        durationMs,
      });
    }
  }
}

/** True when the company should be polled now given its last poll time. */
export function isDue(
  lastPolledAt: string | undefined,
  intervalSeconds: number,
  now: string,
): boolean {
  if (!lastPolledAt) return true;
  const elapsed = Date.parse(now) - Date.parse(lastPolledAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return true;
  return elapsed >= intervalSeconds * 1000;
}

/** Run async work over a list with a max concurrency bound. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
