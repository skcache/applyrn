import type { CompanyConfig, JobRecord, NormalizedJob } from "@applyrn/domain";
import { detectJobs, jobOf, shouldAlert, type DetectionDecision } from "@applyrn/detection";
import { jobId, contentHash } from "@applyrn/domain";
import { evaluateRelevance, type RelevanceResult } from "@applyrn/relevance";
import {
  AdapterError,
  isDetailCapable,
  type JobSourceAdapter,
  type SupportsJobDetail,
} from "@applyrn/adapters";
import {
  TelegramClient,
  alertButtons,
  buildSendMessagePayload,
  renderAlertText,
} from "@applyrn/telegram";
import { D1Repository } from "./repo.js";

/**
 * Poll cycle: one company = fetch -> normalize -> (detail enrich when the
 * source can provide authoritative timestamps) -> detect -> persist -> notify.
 *
 * Persist happens before notify: a Telegram failure must never lose a
 * detected job (PRD acceptance 11). Undelivered notifications are retried by
 * retryUndelivered() on later cycles.
 */

export type WorkerEnv = {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  /** Optional shared token gating the HTTP API (PRD 14 simple access layer). */
  DASHBOARD_TOKEN?: string;
};

export type PollOutcome = {
  companyId: string;
  ok: boolean;
  errorCode?: string;
  httpStatus?: number;
  newJobs: number;
  alertsSent: number;
};

const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_MAX_SECONDS = 60 * 60;

/**
 * Max undelivered-notification sends per invocation. The free-plan
 * subrequest cap is 50 total, and the poll phase already uses up to
 * MAX_FETCHES_PER_INVOCATION (40); retrying the entire backlog in one
 * burst would blow the cap and turn every send past it into a `network`
 * failure (observed in prod: 108 pending notifications, ~35-42 network
 * errors per cycle, only ~14 sends actually reached Telegram). Retries
 * trickle at this bound per cycle until the backlog drains.
 */
export const MAX_RETRY_SENDS_PER_INVOCATION = 10;

/** Minimum time between delivery attempts for the same notification. */
export const RETRY_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Reopen cooldown (audit 2026-08-21 §5.8): a job that flips inactive ->
 * reopened may only re-alert when it has been confirmed inactive for at
 * least this long. Genuine reposts (days later) always clear; churn noise
 * (drop + re-list within minutes) stays silent.
 */
export const REOPEN_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Hard per-invocation outbound-fetch ceiling (Cloudflare free plan: 50
 * subrequests). One list fetch per polled company is planned by the
 * scheduler (<= MAX_FETCHES_PER_INVOCATION); everything else — new-alert
 * sends, undelivered retries, detail enrichment — shares what is left.
 * Blowing the cap turns every fetch past it into a network error, which
 * silently kills the tail of the shard (the exact D-011 failure mode).
 */
export const SUBREQUEST_LIMIT_PER_INVOCATION = 50;

/**
 * Margin held back for incidental calls (staleness system alert, health
 * probes) so planned traffic never consumes the absolute last slots.
 */
const BUDGET_SAFETY_MARGIN = 2;

/**
 * Detail enrichment is the lowest-priority fetch user: it only upgrades
 * metadata (URL slug, description, authoritative timestamp). Without a cap
 * a first-poll burst on a huge board (CityOfNewYork ~1.8k postings) would
 * eat the whole extras pool and starve alert DELIVERY. Jobs whose
 * enrichment is skipped still persist and still alert — SmartRecruiters
 * bare-id URLs serve HTTP 200 directly, so the link works; the description
 * simply stays empty until... it never re-enriches (accepted tradeoff:
 * score loses the <=20-point description contribution, gates unaffected).
 */
export const MAX_DETAIL_ENRICH_PER_INVOCATION = 8;

/**
 * Shared fetch budget for one invocation. Single-threaded JS makes
 * check-and-decrement atomic across awaits, so concurrent company polls
 * (CONCURRENCY_LIMIT=4) can share one instance safely.
 */
export class FetchBudget {
  private remaining: number;
  private enrichUsed = 0;

  private constructor(limit: number) {
    this.remaining = Math.max(0, limit);
  }

  /** Build the budget left after `listFetches` planned list requests. */
  static afterListFetches(listFetches: number): FetchBudget {
    return new FetchBudget(SUBREQUEST_LIMIT_PER_INVOCATION - listFetches - BUDGET_SAFETY_MARGIN);
  }

  /** Reserve one subrequest for a send (alerts, retries). */
  tryConsume(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }

  /** Reserve one subrequest for detail enrichment (own cap + shared pool). */
  tryConsumeEnrichment(): boolean {
    if (this.enrichUsed >= MAX_DETAIL_ENRICH_PER_INVOCATION) return false;
    if (!this.tryConsume()) return false;
    this.enrichUsed++;
    return true;
  }

  get left(): number {
    return this.remaining;
  }

  get enrichmentCount(): number {
    return this.enrichUsed;
  }
}
/** Stop retrying a notification after this age; keep the row for audit. */
export const RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function backoffSeconds(failureStreak: number): number {
  const exp = Math.min(failureStreak, 7);
  const base = BACKOFF_BASE_SECONDS * 2 ** (exp - 1);
  const jitter = Math.floor(Math.random() * base * 0.2);
  return Math.min(base + jitter, BACKOFF_MAX_SECONDS);
}

/** True when a source state shows the company should be polled now. */
export function isPollDue(
  state: { lastSuccessAt?: string | null; lastFailureAt?: string | null },
  intervalSeconds: number,
  now: string,
): boolean {
  const lastPolledAt = state.lastSuccessAt ?? state.lastFailureAt;
  if (!lastPolledAt) return true;
  const elapsed = Date.parse(now) - Date.parse(lastPolledAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return true;
  return elapsed >= intervalSeconds * 1000;
}

/**
 * Serialize poll cycles PER COMPANY so two concurrent runs for the same
 * company cannot double-notify. Different companies still run in parallel
 * (the scheduler relies on that for bounded concurrency).
 */
class CycleGate {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive even when a cycle rejects.
    this.tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

export class PollService {
  private readonly gate = new CycleGate();

  constructor(
    private readonly repo: D1Repository,
    private readonly adapters: Map<string, JobSourceAdapter>,
    private readonly env: WorkerEnv,
  ) {}

  /**
   * Serialized entry point: concurrent cycles for the same company queue.
   * `opts.budget` lets the scheduler share one per-invocation fetch pool
   * across all companies polled in this invocation; absent (manual
   * single-company trigger), the company gets a fresh near-full budget.
   */
  pollCompany(
    company: CompanyConfig,
    now: string,
    opts?: { budget?: FetchBudget },
  ): Promise<PollOutcome> {
    return this.gate.run(company.id, () => this.pollCompanyInner(company, now, opts));
  }

  /**
   * Poll one company. Never throws: failures are recorded in source_state
   * and returned in the outcome so one bad source cannot break the cycle.
   */
  private async pollCompanyInner(
    company: CompanyConfig,
    now: string,
    opts?: { budget?: FetchBudget },
  ): Promise<PollOutcome> {
    const adapter = this.adapters.get(company.provider);
    const outcome: PollOutcome = { companyId: company.id, ok: false, newJobs: 0, alertsSent: 0 };
    // Shared per-invocation fetch pool (undefined on manual single-company
    // triggers, which get a fresh near-full budget instead).
    const budget = opts?.budget ?? FetchBudget.afterListFetches(1);
    if (!adapter) {
      outcome.errorCode = "no_adapter";
      await this.repo.recordSourceFailure(company.id, now, "no_adapter");
      return outcome;
    }

    const state = await this.repo.getSourceState(company.id);
    if (state?.backoffUntil && state.backoffUntil > now) {
      outcome.errorCode = "backoff";
      return outcome;
    }

    // Enforce the poll interval here (not just in the scheduler) so the
    // manual API triggers cannot hammer a company (audit F2). The scheduler
    // filters due companies before calling, so this is a no-op there.
    if (state && !isPollDue(state, company.pollIntervalSeconds, now)) {
      outcome.errorCode = "not_due";
      return outcome;
    }

    let raw: unknown;
    try {
      raw = await adapter.fetchBoard(company);
    } catch (err) {
      return this.fail(company, now, err, outcome, state?.failureStreak ?? 0);
    }

    let fetched: NormalizedJob[];
    try {
      fetched = await adapter.normalize(company, raw);
    } catch (err) {
      return this.fail(company, now, err, outcome, state?.failureStreak ?? 0);
    }

    const firstRun = !state?.lastSuccessAt;
    const existing = await this.repo.listJobsForCompany(company.id);
    const decisions = (await detectJobs({ company, fetched, existing, firstRun })).filter((d) => {
      // Partial-board adapters (workday/smartrecruiters/taleo fetch only the
      // newest page) cannot WITNESS absence: a tracked job pushed off page 1
      // by churn is still live. Marking it missing here falsely inactivated
      // it after ~8 min and re-alerted on the next churn cycle (the
      // "Databricks vanished then reappeared" episode, audit 2026-08-21 §4).
      if (!adapter.partialBoardScan && d.kind === "missing") return false;
      return true;
    });

    // Post-fetch zone: everything here talks to D1 or Telegram. A failure
    // must NOT escape into runCycle and kill the other companies' work or
    // the undelivered-notification retries (audit F5). We record a source
    // failure so backoff applies and the cycle stays alive.
    try {
      // Relevance is a convenience layer, not a gate: score every alertable
      // job, persist the score + reasons, and suppress only hard mismatches.
      const alertable: {
        job: NormalizedJob;
        relevance: RelevanceResult;
        kind: "new" | "reopened";
      }[] = [];
      // D1 subrequest budget: Cloudflare caps per-invocation API calls
      // (default ~1000). Per-job round trips blow that on first baseline
      // (thousands of jobs), so all row writes are collected and flushed
      // in batches of 100 statements per API call.
      const existingById = new Map(existing.map((j) => [j.id, j]));
      const upserts: JobRecord[] = [];
      const touches: { externalJobId: string; companyId: string; seenAt: string }[] = [];
      const absents: {
        externalJobId: string;
        companyId: string;
        absentCount: number;
        now: string;
      }[] = [];
      const reopenIds: string[] = [];
      for (const d of decisions) {
        // Missing decisions carry no job: they must be dispatched BEFORE the
        // persist branch, which is keyed on jobOf(d) being non-null. Doing it
        // the other way silently dropped them (audit F3) and the inactive
        // lifecycle never advanced, so reposted jobs never re-alerted.
        if (d.kind === "missing") {
          absents.push({
            externalJobId: d.externalJobId,
            companyId: company.id,
            absentCount: d.absentCount,
            now,
          });
          continue;
        }
        if (d.kind === "unchanged") {
          touches.push({ externalJobId: d.externalJobId, companyId: company.id, seenAt: now });
          continue;
        }
        const job = jobOf(d);
        if (!job) continue;
        // Detail enrichment applies only to jobs we persist (new/edited/
        // reopened). Baseline jobs are historical: nothing was "detected"
        // this run, so authoritative first_published would be noise. Doing
        // it here instead of over the whole board keeps cycles at cadence
        // for large boards (one detail fetch per alertable job, not per
        // job on the board).
        //
        // Budgeted: enrichment is the lowest-priority fetch user. When the
        // shared invocation pool is drained, the job persists and alerts
        // with list-level metadata only (SmartRecruiters bare-id URLs serve
        // 200 directly; Greenhouse already has URLs on the list payload).
        let toPersist = job;
        if (
          isDetailCapable(adapter) &&
          d.kind !== "baseline" &&
          (!budget || budget.tryConsumeEnrichment())
        ) {
          toPersist = await this.enrichJob(
            adapter as JobSourceAdapter & SupportsJobDetail,
            company,
            job,
          );
        }
        const relevance = shouldAlert(d) ? evaluateRelevance(toPersist) : undefined;
        upserts.push(await this.buildJobRecord(d, toPersist, now, relevance, existingById));
        let suppressReopen = false;
        if (d.kind === "reopened") {
          // Reopen cooldown (audit 2026-08-21 §5.8): a repost is alertable
          // again only after REOPEN_COOLDOWN_MS since it was confirmed
          // inactive. Boards that briefly drop and re-list the same posting
          // within minutes must not double-ping. The job still returns to
          // active tracking (status 'reopened'); it just stays quiet.
          const prev = existingById.get(
            await jobId(job.provider, job.companyId, job.externalJobId),
          );
          const inactiveAt = prev?.confirmedInactiveAt ? Date.parse(prev.confirmedInactiveAt) : NaN;
          suppressReopen =
            !Number.isNaN(inactiveAt) && Date.parse(now) - inactiveAt < REOPEN_COOLDOWN_MS;
          if (!suppressReopen) {
            reopenIds.push(prev!.id);
          }
        }
        if (shouldAlert(d) && relevance && !relevance.suppressed && !suppressReopen) {
          alertable.push({
            job: toPersist,
            relevance,
            kind: d.kind === "reopened" ? "reopened" : "new",
          });
        }
      }

      // Flush everything in as few D1 API calls as possible.
      await this.repo.batchUpsertJobs(upserts);
      await this.repo.batchTouchJobSeen(touches);
      await this.repo.batchMarkJobAbsent(absents);
      for (const id of reopenIds) {
        // A reopened job is a NEW posting: the old delivered notification row
        // (from the first run) must not suppress the fresh alert (audit F4).
        await this.repo.resetNotificationDelivery(id, "telegram");
      }

      await this.repo.recordSourceSuccess(company.id, now, 200, String(fetched.length));
      outcome.ok = true;
      outcome.newJobs = alertable.length;
      outcome.alertsSent = await this.notifyNew(company, alertable, now, budget);
      return outcome;
    } catch {
      outcome.errorCode = "persist_error";
      // Best-effort failure bookkeeping; never let the escape hatch throw.
      try {
        await this.repo.recordSourceFailure(company.id, now, "persist_error");
      } catch {
        // DB is down too; nothing more we can do.
      }
      return outcome;
    }
  }

  /** Best-effort authoritative timestamp for one job (Greenhouse first_published). */
  private async enrichJob(
    adapter: JobSourceAdapter & SupportsJobDetail,
    company: CompanyConfig,
    job: NormalizedJob,
  ): Promise<NormalizedJob> {
    if (job.publicationTimeKind === "authoritative") return job;
    try {
      const detail = await adapter.fetchJobDetail(company, job.externalJobId);
      const enriched = await adapter.normalizeDetail(company, detail, job.externalJobId);
      return enriched ?? job;
    } catch {
      // Detail fetch is best-effort; the list entry remains usable.
      return job;
    }
  }

  /** Build the JobRecord row for a decision (persist happens via batch). */
  private async buildJobRecord(
    d: DetectionDecision,
    job: NormalizedJob,
    now: string,
    relevance: RelevanceResult | undefined,
    existingById: Map<string, JobRecord>,
  ): Promise<JobRecord> {
    const id = await jobId(job.provider, job.companyId, job.externalJobId);
    const hash = await contentHash(job);
    const existing = existingById.get(id);
    const isReopen = d.kind === "reopened";

    return {
      id,
      companyId: job.companyId,
      provider: job.provider,
      externalJobId: job.externalJobId,
      title: job.title,
      location: job.location,
      employmentType: job.employmentType,
      department: job.department,
      team: job.team,
      descriptionPlain: job.descriptionPlain,
      jobUrl: job.jobUrl,
      applyUrl: job.applyUrl,
      compensationText: job.compensationText,
      sourcePublishedAt: job.sourcePublishedAt,
      publicationTimeKind: job.publicationTimeKind,
      firstSeenAt: existing?.firstSeenAt ?? now,
      detectedAt: existing?.detectedAt ?? now,
      lastSeenAt: now,
      confirmedInactiveAt: existing?.confirmedInactiveAt,
      sourceUpdatedAt: job.sourceUpdatedAt,
      contentHash: hash,
      matchScore: relevance?.score,
      matchReasonsJson: relevance ? JSON.stringify(relevance.reasons) : undefined,
      status:
        d.kind === "baseline"
          ? "baseline"
          : isReopen
            ? "reopened"
            : d.kind === "new"
              ? "new"
              : "active",
      absentCount: 0,
    };
  }

  /**
   * Send alerts for new/reopened jobs. Failures persist as undelivered.
   *
   * Budgeted: each send is an outbound subrequest. When the shared
   * invocation pool is drained, the send is DEFERRED — recorded as an
   * undelivered notification with errorCode `budget_deferred` — so the
   * existing retryUndelivered path picks it up on a later cycle. A job is
   * never dropped for lack of budget; delivery just moves to the next
   * invocation (persist-before-notify, PRD acceptance 11).
   */
  private async notifyNew(
    company: CompanyConfig,
    jobs: { job: NormalizedJob; relevance: RelevanceResult; kind: "new" | "reopened" }[],
    now: string,
    budget?: FetchBudget,
  ): Promise<number> {
    const token = this.env.TELEGRAM_BOT_TOKEN;
    const chatId = this.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      // Misconfiguration: record attempts as undelivered so nothing is lost.
      for (const { job } of jobs) {
        const id = await jobId(job.provider, job.companyId, job.externalJobId);
        await this.repo.recordNotificationAttempt({
          jobId: id,
          channel: "telegram",
          attemptedAt: now,
          delivered: false,
          errorCode: "misconfigured",
        });
      }
      return 0;
    }

    const client = new TelegramClient(token);
    let sent = 0;
    for (const { job, relevance, kind } of jobs) {
      const id = await jobId(job.provider, job.companyId, job.externalJobId);

      // Atomic claim (audit F6): the single-statement upsert is the
      // duplicate-send guard. Only the isolate that wins the claim sends;
      // a delivered row, or another isolate's in-flight send, refuses it.
      const claimed = await this.repo.claimNotificationSend(id, "telegram", now);
      if (!claimed) continue;

      // Budget gate AFTER the claim: if the invocation pool is drained we
      // record a deferred attempt (D1 write, no fetch), which leaves the
      // row undelivered for retryUndelivered on a later cycle.
      if (budget && !budget.tryConsume()) {
        await this.repo.recordNotificationAttempt({
          jobId: id,
          channel: "telegram",
          attemptedAt: now,
          delivered: false,
          errorCode: "budget_deferred",
        });
        continue;
      }

      const text = renderAlertText({
        job,
        company,
        detectedAt: now,
        match: { score: relevance.score, reasons: relevance.reasons },
        kind,
      });
      const payload = buildSendMessagePayload(chatId, text, alertButtons(job));
      try {
        const result = await client.sendMessage(chatId, payload);
        await this.repo.recordNotificationAttempt({
          jobId: id,
          channel: "telegram",
          attemptedAt: now,
          delivered: true,
          latencyMs: result.latencyMs,
        });
        sent++;
      } catch (err) {
        const code =
          err instanceof Error && "errorCode" in err
            ? String((err as { errorCode: string }).errorCode)
            : "unknown";
        await this.repo.recordNotificationAttempt({
          jobId: id,
          channel: "telegram",
          attemptedAt: now,
          delivered: false,
          errorCode: code,
        });
      }
    }
    return sent;
  }

  /**
   * Retry undelivered notifications from earlier cycles.
   * Bounded: at most one attempt per notification per RETRY_MIN_INTERVAL_MS,
   * and notifications older than RETRY_MAX_AGE_MS are left for manual review
   * (the row stays, marked delivered=0, so the detection is never lost).
   */
  async retryUndelivered(now: string, opts?: { budget?: FetchBudget }): Promise<number> {
    const token = this.env.TELEGRAM_BOT_TOKEN;
    const chatId = this.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return 0;
    const undelivered = await this.repo.listUndeliveredNotifications();
    const nowMs = Date.parse(now);
    let retried = 0;
    let attempts = 0;
    for (const n of undelivered) {
      // Bound: never ATTEMPT more than MAX_RETRY_SENDS_PER_INVOCATION in
      // one invocation (free-plan subrequest cap; the poll phase already
      // used its budget). Every send is a subrequest whether it succeeds
      // or fails, so the bound counts attempts, not deliveries. The rest
      // stay queued and trickle out on later cycles.
      if (attempts >= MAX_RETRY_SENDS_PER_INVOCATION) break;
      // Shared invocation pool: when the scheduler's budget is drained by
      // list fetches + new-alert sends, retries stop and stay queued.
      if (opts?.budget && !opts.budget.tryConsume()) break;
      const lastAttemptMs = Date.parse(n.attemptedAt);
      if (!Number.isFinite(lastAttemptMs)) continue;
      if (nowMs - lastAttemptMs < RETRY_MIN_INTERVAL_MS) continue; // throttle
      if (nowMs - lastAttemptMs > RETRY_MAX_AGE_MS) continue; // too old, stop
      const job = await this.repo.getJobById(n.jobId);
      if (!job) continue;
      const company = await this.repo.getCompany(job.companyId);
      if (!company) continue;
      // Claim before sending (audit F6): two isolates retrying the same row
      // must not both send. A fresh 'sending' marker (crashed peer) is also
      // refused until it ages out.
      const claimed = await this.repo.claimNotificationSend(n.jobId, n.channel, now);
      if (!claimed) continue;
      attempts++; // a real send follows (claimed); counts against the cap
      const client = new TelegramClient(token);
      const storedMatch =
        job.matchScore !== undefined
          ? {
              score: job.matchScore,
              reasons: job.matchReasonsJson ? (JSON.parse(job.matchReasonsJson) as string[]) : [],
            }
          : undefined;
      const text = renderAlertText({
        job,
        company,
        detectedAt: job.detectedAt,
        match: storedMatch,
      });
      const payload = buildSendMessagePayload(chatId, text, alertButtons(job));
      try {
        const result = await client.sendMessage(chatId, payload);
        await this.repo.recordNotificationAttempt({
          jobId: job.id,
          channel: n.channel,
          attemptedAt: now,
          delivered: true,
          latencyMs: result.latencyMs,
        });
        retried++;
      } catch (err) {
        // Record the failure (observability + soak evidence). The row stays
        // undelivered and the next cycle tries again (throttled). Audited
        // code path: F6's claim already ensures only one isolate sends.
        const code =
          err instanceof Error && "errorCode" in err
            ? String((err as { errorCode: string }).errorCode)
            : "unknown";
        await this.repo.recordNotificationAttempt({
          jobId: job.id,
          channel: n.channel,
          attemptedAt: now,
          delivered: false,
          errorCode: code,
        });
      }
    }
    return retried;
  }

  /**
   * System-level notice (scheduler staleness, etc). Best-effort: returns
   * false when Telegram is not configured or the send fails; never throws.
   */
  async sendSystemAlert(message: string): Promise<boolean> {
    const token = this.env.TELEGRAM_BOT_TOKEN;
    const chatId = this.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return false;
    try {
      const client = new TelegramClient(token);
      const payload = buildSendMessagePayload(chatId, message, []);
      const result = await client.sendMessage(chatId, payload);
      return result.ok;
    } catch {
      return false;
    }
  }

  private async fail(
    company: CompanyConfig,
    now: string,
    err: unknown,
    outcome: PollOutcome,
    failureStreak: number,
  ): Promise<PollOutcome> {
    if (err instanceof AdapterError) {
      outcome.errorCode = err.code;
      outcome.httpStatus = err.status;
      const backoff =
        err.code === "rate_limited" || err.code === "server_error"
          ? backoffSeconds(failureStreak + 1)
          : 0;
      const backoffUntil =
        backoff > 0 ? new Date(Date.now() + backoff * 1000).toISOString() : undefined;
      await this.repo.recordSourceFailure(company.id, now, err.code, err.status, backoffUntil);
    } else {
      outcome.errorCode = "unknown";
      await this.repo.recordSourceFailure(company.id, now, "unknown");
    }
    return outcome;
  }
}
