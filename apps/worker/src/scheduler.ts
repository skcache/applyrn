import type { CompanyConfig } from "@applyrn/domain";
import { D1Repository } from "./repo.js";
import type { PollOutcome } from "./poll.js";

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
  pollCompany(company: CompanyConfig, now: string): Promise<PollOutcome>;
  retryUndelivered(now: string): Promise<number>;
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
  async runCycle(now: string): Promise<CycleSummary> {
    const startedAt = Date.now();
    const companies = await this.repo.listEnabledCompanies();

    const due: CompanyConfig[] = [];
    let skippedBackoff = 0;
    let skippedInterval = 0;

    for (const company of companies) {
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

    const outcomes = await mapWithConcurrency(due, CONCURRENCY_LIMIT, (company) =>
      this.poller.pollCompany(company, now),
    );

    const retried = await this.poller.retryUndelivered(now);

    await this.recordMetrics(companies, outcomes, now, Date.now() - startedAt);

    return {
      outcomes,
      skippedBackoff,
      skippedInterval,
      retried,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Poller contract passthrough (single-company manual trigger). */
  pollCompany(company: CompanyConfig, now: string): Promise<PollOutcome> {
    return this.poller.pollCompany(company, now);
  }

  retryUndelivered(now: string): Promise<number> {
    return this.poller.retryUndelivered(now);
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
