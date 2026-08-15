import type { CompanyConfig, NormalizedJob } from "@applyrn/domain";
import {
  detectJobs,
  jobOf,
  shouldAlert,
  shouldPersist,
  type DetectionDecision,
} from "@applyrn/detection";
import { jobId, contentHash } from "@applyrn/domain";
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

    const newJobs: NormalizedJob[] = [];
    for (const d of decisions) {
      if (shouldPersist(d)) {
        const job = jobOf(d);
        if (job) {
          await this.persistDecision(d, job, now);
          if (shouldAlert(d)) newJobs.push(job);
        }
      } else if (d.kind === "unchanged") {
        await this.repo.touchJobSeen(d.externalJobId, company.id, now);
      } else if (d.kind === "missing") {
        await this.repo.markJobAbsent(d.externalJobId, company.id, d.absentCount, now);
      }
    }

    await this.repo.recordSourceSuccess(company.id, now, 200, String(fetched.length));
    outcome.ok = true;
    outcome.newJobs = newJobs.length;
    outcome.alertsSent = await this.notifyNew(company, newJobs, now);
    return outcome;
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
  }

  /** Send alerts for new/reopened jobs. Failures persist as undelivered. */
  private async notifyNew(
    company: CompanyConfig,
    jobs: NormalizedJob[],
    now: string,
  ): Promise<number> {
    const token = this.env.TELEGRAM_BOT_TOKEN;
    const chatId = this.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      // Misconfiguration: record attempts as undelivered so nothing is lost.
      for (const job of jobs) {
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
    for (const job of jobs) {
      const id = await jobId(job.provider, job.companyId, job.externalJobId);

      // Duplicate-send guard: if a delivered notification row already exists
      // (e.g. a previous cycle sent it before a crash), do not send again.
      const prior = await this.repo.getNotification(id, "telegram");
      if (prior?.delivered) continue;

      const text = renderAlertText({ job, company, detectedAt: now });
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
      const client = new TelegramClient(token);
      const text = renderAlertText({
        job,
        company,
        detectedAt: job.detectedAt,
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
