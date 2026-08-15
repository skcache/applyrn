import type { CompanyConfig, NormalizedJob } from "@applyrn/domain";
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

/** Minimum time between delivery attempts for the same notification. */
export const RETRY_MIN_INTERVAL_MS = 5 * 60 * 1000;
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

  /** Serialized entry point: concurrent cycles for the same company queue. */
  pollCompany(company: CompanyConfig, now: string): Promise<PollOutcome> {
    return this.gate.run(company.id, () => this.pollCompanyInner(company, now));
  }

  /**
   * Poll one company. Never throws: failures are recorded in source_state
   * and returned in the outcome so one bad source cannot break the cycle.
   */
  private async pollCompanyInner(company: CompanyConfig, now: string): Promise<PollOutcome> {
    const adapter = this.adapters.get(company.provider);
    const outcome: PollOutcome = { companyId: company.id, ok: false, newJobs: 0, alertsSent: 0 };
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

    // Detail enrichment: when a source exposes authoritative timestamps on a
    // per-job endpoint (Greenhouse first_published), upgrade NEW jobs before
    // detection so publication -> detection measurement starts clean.
    if (isDetailCapable(adapter)) {
      fetched = await this.enrichDetails(adapter, company, fetched);
    }

    const firstRun = !state?.lastSuccessAt;
    const existing = await this.repo.listJobsForCompany(company.id);
    const decisions = await detectJobs({ company, fetched, existing, firstRun });

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
      for (const d of decisions) {
        // Missing decisions carry no job: they must be dispatched BEFORE the
        // persist branch, which is keyed on jobOf(d) being non-null. Doing it
        // the other way silently dropped them (audit F3) and the inactive
        // lifecycle never advanced, so reposted jobs never re-alerted.
        if (d.kind === "missing") {
          await this.repo.markJobAbsent(d.externalJobId, company.id, d.absentCount, now);
          continue;
        }
        if (d.kind === "unchanged") {
          await this.repo.touchJobSeen(d.externalJobId, company.id, now);
          continue;
        }
        const job = jobOf(d);
        if (!job) continue;
        const relevance = shouldAlert(d) ? evaluateRelevance(job) : undefined;
        await this.persistDecision(d, job, now, relevance);
        if (shouldAlert(d) && relevance && !relevance.suppressed) {
          alertable.push({ job, relevance, kind: d.kind === "reopened" ? "reopened" : "new" });
        }
      }

      await this.repo.recordSourceSuccess(company.id, now, 200, String(fetched.length));
      outcome.ok = true;
      outcome.newJobs = alertable.length;
      outcome.alertsSent = await this.notifyNew(company, alertable, now);
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

  private async enrichDetails(
    adapter: JobSourceAdapter & SupportsJobDetail,
    company: CompanyConfig,
    fetched: NormalizedJob[],
  ): Promise<NormalizedJob[]> {
    const out: NormalizedJob[] = [];
    for (const job of fetched) {
      if (job.publicationTimeKind === "authoritative") {
        out.push(job);
        continue;
      }
      try {
        const detail = await adapter.fetchJobDetail(company, job.externalJobId);
        const enriched = await adapter.normalizeDetail(company, detail, job.externalJobId);
        out.push(enriched ?? job);
      } catch {
        // Detail fetch is best-effort; the list entry remains usable.
        out.push(job);
      }
    }
    return out;
  }

  private async persistDecision(
    d: DetectionDecision,
    job: NormalizedJob,
    now: string,
    relevance?: RelevanceResult,
  ): Promise<void> {
    const id = await jobId(job.provider, job.companyId, job.externalJobId);
    const hash = await contentHash(job);
    const existing = await this.repo.getJobById(id);
    const isReopen = d.kind === "reopened";

    await this.repo.upsertJob({
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
    });

    // A reopened job is a NEW posting: the old delivered notification row
    // (from the first run) must not suppress the fresh alert (audit F4).
    if (isReopen) {
      await this.repo.resetNotificationDelivery(id, "telegram");
    }
  }

  /** Send alerts for new/reopened jobs. Failures persist as undelivered. */
  private async notifyNew(
    company: CompanyConfig,
    jobs: { job: NormalizedJob; relevance: RelevanceResult; kind: "new" | "reopened" }[],
    now: string,
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
  async retryUndelivered(now: string): Promise<number> {
    const token = this.env.TELEGRAM_BOT_TOKEN;
    const chatId = this.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return 0;
    const undelivered = await this.repo.listUndeliveredNotifications();
    const nowMs = Date.parse(now);
    let retried = 0;
    for (const n of undelivered) {
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
          channel: "telegram",
          attemptedAt: now,
          delivered: true,
          latencyMs: result.latencyMs,
        });
        retried++;
      } catch {
        // Keep the row undelivered; next cycle tries again (throttled).
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
