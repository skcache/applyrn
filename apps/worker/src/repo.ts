import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  type ApplicationRecord,
  type ApplicationStatus,
  type CompanyConfig,
  type JobRecord,
  type JobStatus,
  type NotificationRecord,
  type SourceState,
} from "@applyrn/domain";

/**
 * D1 repository layer. All SQL lives here; the poll cycle and HTTP handlers
 * never write SQL directly.
 */

export type D1Row = Record<string, unknown>;

/**
 * How long an in-flight notification claim stays fresh (audit F6).
 * Longer than a Telegram send takes; short enough that a crashed isolate
 * does not wedge the row forever.
 */
export const CLAIM_TTL_MS = 5 * 60 * 1000;

/** One poll_metrics row (PRD 8.6). */
type PollMetricRow = {
  provider: string;
  shard: string;
  companies_polled: number | null;
  successful: number | null;
  failed: number | null;
  new_jobs: number | null;
  duration_ms: number | null;
  request_latency_p50_ms: number | null;
  request_latency_p95_ms: number | null;
  request_latency_p99_ms: number | null;
};

/** Inactive job with enough timing data to observe its posting lifetime. */
type LifetimeRow = {
  title: string;
  company_name: string;
  detected_at: string;
  confirmed_inactive_at: string | null;
  source_published_at: string | null;
  publication_time_kind: string;
};

/** system_events row. */
export type SystemEventRow = {
  id: number;
  kind: string;
  occurred_at: string;
  message: string | null;
  cleared_at: string | null;
};

/** 24h observability report shape (PRD Issue 11). */
export type ObservabilityReport = {
  windowStartedAt: string;
  cycles: number;
  companiesPolled: number;
  successful: number;
  failed: number;
  newJobs: number;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
  durationP99Ms: number | null;
  requestLatencyP50Ms: number | null;
  requestLatencyP95Ms: number | null;
  requestLatencyP99Ms: number | null;
  alertFailures: { error_code: string | null; n: number }[];
  inactiveConfirmations: number;
  duplicateNotifications: number;
  observedLifetimes: {
    title: string;
    companyName: string;
    detectedAt: string;
    confirmedInactiveAt: string;
    lifetimeMs: number;
  }[];
};

/** Nearest-rank percentile over a sorted array; null when empty. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? null;
}

/** Milliseconds between a posting's first appearance and its confirmation. */
export function lifetimeMs(firstSeenAt: string, confirmedInactiveAt: string): number {
  const ms = Date.parse(confirmedInactiveAt) - Date.parse(firstSeenAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

/** Job + company + application, for the dashboard tape and detail view. */
export type JobView = JobRecord & {
  companyName: string;
  applicationStatus?: ApplicationStatus;
  applicationAppliedAt?: string;
};

/** Company + source health row, for the dashboard SOURCES view. */
export type SourceHealthView = {
  companyId: string;
  name: string;
  provider: string;
  boardKey: string;
  enabled: boolean;
  pollIntervalSeconds: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  failureStreak: number;
  backoffUntil?: string;
  lastHttpStatus?: number;
  lastErrorCode?: string;
};

/** Application + job + company, for the dashboard APPLICATIONS view. */
export type ApplicationView = ApplicationRecord & {
  jobTitle: string;
  jobDetectedAt: string;
  jobProvider: string;
  companyName: string;
};

function rowToJobView(row: D1Row): JobView {
  return {
    ...rowToJob(row),
    companyName: String(row.company_name),
    applicationStatus: row.application_status
      ? (String(row.application_status) as ApplicationStatus)
      : undefined,
    applicationAppliedAt: row.application_applied_at
      ? String(row.application_applied_at)
      : undefined,
  };
}

function rowToCompany(row: D1Row): CompanyConfig {
  return {
    id: String(row.id),
    name: String(row.name),
    careersUrl: row.careers_url ? String(row.careers_url) : undefined,
    provider: String(row.provider),
    boardKey: String(row.board_key),
    enabled: Number(row.enabled) === 1,
    pollIntervalSeconds: Number(row.poll_interval_seconds),
    tags: row.tags ? (JSON.parse(String(row.tags)) as string[]) : undefined,
    createdAt: String(row.created_at),
  };
}

function rowToJob(row: D1Row): JobRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    provider: String(row.provider),
    externalJobId: String(row.external_job_id),
    title: String(row.title),
    location: row.location ? String(row.location) : undefined,
    employmentType: row.employment_type ? String(row.employment_type) : undefined,
    department: row.department ? String(row.department) : undefined,
    team: row.team ? String(row.team) : undefined,
    descriptionPlain: row.description_plain ? String(row.description_plain) : undefined,
    jobUrl: String(row.job_url),
    applyUrl: String(row.apply_url),
    compensationText: row.compensation_text ? String(row.compensation_text) : undefined,
    sourcePublishedAt: row.source_published_at ? String(row.source_published_at) : undefined,
    publicationTimeKind: String(row.publication_time_kind) as JobRecord["publicationTimeKind"],
    firstSeenAt: String(row.first_seen_at),
    detectedAt: String(row.detected_at),
    lastSeenAt: String(row.last_seen_at),
    confirmedInactiveAt: row.confirmed_inactive_at ? String(row.confirmed_inactive_at) : undefined,
    sourceUpdatedAt: row.source_updated_at ? String(row.source_updated_at) : undefined,
    contentHash: String(row.content_hash),
    matchScore:
      row.match_score !== null && row.match_score !== undefined
        ? Number(row.match_score)
        : undefined,
    matchReasonsJson: row.match_reasons_json ? String(row.match_reasons_json) : undefined,
    status: String(row.status) as JobStatus,
    absentCount: Number(row.absent_count),
  };
}

export class D1Repository {
  constructor(private readonly db: D1Database) {}

  async listEnabledCompanies(): Promise<CompanyConfig[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM companies WHERE enabled = 1 ORDER BY id")
      .all();
    return results.map(rowToCompany);
  }

  async getCompany(id: string): Promise<CompanyConfig | null> {
    const row = await this.db.prepare("SELECT * FROM companies WHERE id = ?").bind(id).first();
    return row ? rowToCompany(row) : null;
  }

  async upsertCompany(c: CompanyConfig): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO companies (id, name, careers_url, provider, board_key, enabled, poll_interval_seconds, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           careers_url = excluded.careers_url,
           provider = excluded.provider,
           board_key = excluded.board_key,
           enabled = excluded.enabled,
           poll_interval_seconds = excluded.poll_interval_seconds,
           tags = excluded.tags`,
      )
      .bind(
        c.id,
        c.name,
        c.careersUrl ?? null,
        c.provider,
        c.boardKey,
        c.enabled ? 1 : 0,
        c.pollIntervalSeconds,
        c.tags ? JSON.stringify(c.tags) : null,
        c.createdAt,
      )
      .run();
  }

  async listJobsForCompany(companyId: string): Promise<JobRecord[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM jobs WHERE company_id = ? ORDER BY external_job_id")
      .bind(companyId)
      .all();
    return results.map(rowToJob);
  }

  async listJobs(limit = 100, status?: JobStatus): Promise<JobRecord[]> {
    if (status) {
      const { results } = await this.db
        .prepare("SELECT * FROM jobs WHERE status = ? ORDER BY first_seen_at DESC LIMIT ?")
        .bind(status, limit)
        .all();
      return results.map(rowToJob);
    }
    const { results } = await this.db
      .prepare("SELECT * FROM jobs ORDER BY first_seen_at DESC LIMIT ?")
      .bind(limit)
      .all();
    return results.map(rowToJob);
  }

  /** Job + company name + application status, for the dashboard tape. */
  async listJobViews(limit = 100): Promise<JobView[]> {
    const { results } = await this.db
      .prepare(
        `SELECT j.*, c.name AS company_name, a.status AS application_status, a.applied_at AS application_applied_at
         FROM jobs j
         JOIN companies c ON c.id = j.company_id
         LEFT JOIN applications a ON a.job_id = j.id
         ORDER BY j.first_seen_at DESC
         LIMIT ?`,
      )
      .bind(limit)
      .all();
    return results.map(rowToJobView);
  }

  async getJobView(id: string): Promise<JobView | null> {
    const row = await this.db
      .prepare(
        `SELECT j.*, c.name AS company_name, a.status AS application_status, a.applied_at AS application_applied_at
         FROM jobs j
         JOIN companies c ON c.id = j.company_id
         LEFT JOIN applications a ON a.job_id = j.id
         WHERE j.id = ?`,
      )
      .bind(id)
      .first();
    return row ? rowToJobView(row) : null;
  }

  /** Companies + source health, for the dashboard SOURCES view. */
  async listSourceHealth(): Promise<SourceHealthView[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.name, c.provider, c.board_key, c.enabled, c.poll_interval_seconds,
                s.last_success_at, s.last_failure_at, s.failure_streak, s.backoff_until,
                s.last_http_status, s.last_error_code
         FROM companies c
         LEFT JOIN source_state s ON s.company_id = c.id
         ORDER BY c.name`,
      )
      .all();
    return results.map((row) => ({
      companyId: String(row.id),
      name: String(row.name),
      provider: String(row.provider),
      boardKey: String(row.board_key),
      enabled: Number(row.enabled) === 1,
      pollIntervalSeconds: Number(row.poll_interval_seconds),
      lastSuccessAt: row.last_success_at ? String(row.last_success_at) : undefined,
      lastFailureAt: row.last_failure_at ? String(row.last_failure_at) : undefined,
      failureStreak: Number(row.failure_streak ?? 0),
      backoffUntil: row.backoff_until ? String(row.backoff_until) : undefined,
      lastHttpStatus:
        row.last_http_status !== null && row.last_http_status !== undefined
          ? Number(row.last_http_status)
          : undefined,
      lastErrorCode: row.last_error_code ? String(row.last_error_code) : undefined,
    }));
  }

  /** System status: enabled company count, cadence, last successful poll. */
  async getSystemStatus(): Promise<{
    companyCount: number;
    cadenceSeconds: number;
    lastPollAt?: string;
    shardCount: number;
  }> {
    const count = await this.db
      .prepare("SELECT COUNT(*) AS n FROM companies WHERE enabled = 1")
      .first();
    const cadence = await this.db
      .prepare("SELECT MIN(poll_interval_seconds) AS c FROM companies WHERE enabled = 1")
      .first();
    const last = await this.db.prepare("SELECT MAX(finished_at) AS t FROM poll_metrics").first();
    return {
      companyCount: Number(count?.n ?? 0),
      cadenceSeconds: Number(cadence?.c ?? DEFAULT_POLL_INTERVAL_SECONDS),
      lastPollAt: last?.t ? String(last.t) : undefined,
      // Free-plan subrequest cap: shard count = ceil(companies / fetch budget),
      // so external fallback triggers know how many shards to cover.
      // Mirrors MAX_FETCHES_PER_INVOCATION in scheduler.ts (repo can't import
      // it without a scheduler -> repo cycle).
      shardCount: Math.max(1, Math.ceil(Number(count?.n ?? 0) / 40)),
    };
  }

  /**
   * 24h observability report (PRD Issue 11): cycle volume, latency
   * percentiles, alert failures, inactive confirmations, and observed
   * posting lifetimes. Also duplicate-notification count: with the unique
   * (job_id, channel) index this should always be 0; the soak asserts it.
   */
  async getObservability(since: string): Promise<ObservabilityReport> {
    const [rows, failures, inactive, lifetimes, duplicates] = await Promise.all([
      this.db
        .prepare(
          `SELECT provider, shard, companies_polled, successful, failed, new_jobs,
                  duration_ms, request_latency_p50_ms, request_latency_p95_ms,
                  request_latency_p99_ms
           FROM poll_metrics WHERE finished_at >= ? ORDER BY finished_at`,
        )
        .bind(since)
        .all<PollMetricRow>(),
      this.db
        .prepare(
          `SELECT error_code, COUNT(*) AS n
           FROM notifications WHERE delivered = 0 AND attempted_at >= ?
           GROUP BY error_code ORDER BY n DESC`,
        )
        .bind(since)
        .all<{ error_code: string | null; n: number }>(),
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM jobs
           WHERE confirmed_inactive_at IS NOT NULL AND confirmed_inactive_at >= ?`,
        )
        .bind(since)
        .first<{ n: number }>(),
      this.db
        .prepare(
          `SELECT j.title, j.detected_at, j.confirmed_inactive_at,
                  j.source_published_at, j.publication_time_kind, c.name AS company_name
           FROM jobs j JOIN companies c ON c.id = j.company_id
           WHERE j.confirmed_inactive_at IS NOT NULL AND j.confirmed_inactive_at >= ?
           ORDER BY j.confirmed_inactive_at DESC LIMIT 20`,
        )
        .bind(since)
        .all<LifetimeRow>(),
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT job_id, channel, COUNT(*) AS c
             FROM notifications WHERE delivered = 1 AND attempted_at >= ?
             GROUP BY job_id, channel HAVING c > 1
           )`,
        )
        .bind(since)
        .first<{ n: number }>(),
    ]);

    const durationMs = rows.results
      .map((r) => r.duration_ms)
      .filter((v): v is number => v !== null && v !== undefined)
      .sort((a, b) => a - b);
    const p50 = percentile(durationMs, 0.5);
    const p95 = percentile(durationMs, 0.95);
    const p99 = percentile(durationMs, 0.99);

    // Latest shard row's request-latency percentiles are the freshest view.
    const latest = rows.results[rows.results.length - 1];

    return {
      windowStartedAt: since,
      cycles: rows.results.length,
      companiesPolled: rows.results.reduce((s, r) => s + (r.companies_polled ?? 0), 0),
      successful: rows.results.reduce((s, r) => s + (r.successful ?? 0), 0),
      failed: rows.results.reduce((s, r) => s + (r.failed ?? 0), 0),
      newJobs: rows.results.reduce((s, r) => s + (r.new_jobs ?? 0), 0),
      durationP50Ms: p50,
      durationP95Ms: p95,
      durationP99Ms: p99,
      requestLatencyP50Ms: latest?.request_latency_p50_ms ?? null,
      requestLatencyP95Ms: latest?.request_latency_p95_ms ?? null,
      requestLatencyP99Ms: latest?.request_latency_p99_ms ?? null,
      alertFailures: failures.results,
      inactiveConfirmations: Number(inactive?.n ?? 0),
      duplicateNotifications: Number(duplicates?.n ?? 0),
      observedLifetimes: lifetimes.results.map((r) => ({
        title: String(r.title),
        companyName: String(r.company_name),
        detectedAt: String(r.detected_at),
        confirmedInactiveAt: String(r.confirmed_inactive_at),
        // Observed posting lifetime (PRD 10.3/9.2): prefer the source's own
        // publication time when it exists, else our first-seen time.
        lifetimeMs: lifetimeMs(r.source_published_at ?? r.detected_at, r.confirmed_inactive_at!),
      })),
    };
  }

  /** Open (un-cleared) system event of a kind, for incident dedupe. */
  async getOpenSystemEvent(kind: string): Promise<SystemEventRow | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM system_events WHERE kind = ? AND cleared_at IS NULL
         ORDER BY occurred_at DESC LIMIT 1`,
      )
      .bind(kind)
      .first<SystemEventRow>();
    return row ?? null;
  }

  /** Record a system event (incident open or notice). */
  async recordSystemEvent(kind: string, occurredAt: string, message?: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO system_events (kind, occurred_at, message, cleared_at)
         VALUES (?, ?, ?, NULL)`,
      )
      .bind(kind, occurredAt, message ?? null)
      .run();
  }

  /** Clear all open events of a kind (incident recovered). */
  async clearSystemEvents(kind: string, clearedAt: string): Promise<void> {
    await this.db
      .prepare(`UPDATE system_events SET cleared_at = ? WHERE kind = ? AND cleared_at IS NULL`)
      .bind(clearedAt, kind)
      .run();
  }

  /** Applications joined with job + company, for the APPLICATIONS view. */
  async listApplicationViews(): Promise<ApplicationView[]> {
    const { results } = await this.db
      .prepare(
        `SELECT a.*, j.title AS job_title, j.detected_at AS job_detected_at,
                j.provider AS job_provider, c.name AS company_name
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         JOIN companies c ON c.id = j.company_id
         ORDER BY a.applied_at IS NULL, a.applied_at DESC, j.detected_at DESC`,
      )
      .all();
    return results.map((row) => ({
      jobId: String(row.job_id),
      status: String(row.status) as ApplicationStatus,
      savedAt: row.saved_at ? String(row.saved_at) : undefined,
      appliedAt: row.applied_at ? String(row.applied_at) : undefined,
      oaAt: row.oa_at ? String(row.oa_at) : undefined,
      interviewAt: row.interview_at ? String(row.interview_at) : undefined,
      finalAt: row.final_at ? String(row.final_at) : undefined,
      offerAt: row.offer_at ? String(row.offer_at) : undefined,
      rejectedAt: row.rejected_at ? String(row.rejected_at) : undefined,
      ghostedAt: row.ghosted_at ? String(row.ghosted_at) : undefined,
      notes: row.notes ? String(row.notes) : undefined,
      jobTitle: String(row.job_title),
      jobDetectedAt: String(row.job_detected_at),
      jobProvider: String(row.job_provider),
      companyName: String(row.company_name),
    }));
  }

  async upsertJob(job: JobRecord): Promise<void> {
    await this.upsertJobStmt(job).run();
  }

  /**
   * Batched upsert: D1 `batch()` executes up to 100 statements in ONE API
   * call. Without this, a baseline run (thousands of jobs across 63 boards)
   * burned one D1 subrequest per job and tripped Cloudflare's per-invocation
   * request cap (~1000), silently killing the cycle before metrics landed.
   */
  async batchUpsertJobs(jobs: JobRecord[]): Promise<void> {
    for (let i = 0; i < jobs.length; i += 100) {
      await this.db.batch(jobs.slice(i, i + 100).map((j) => this.upsertJobStmt(j)));
    }
  }

  private upsertJobStmt(job: JobRecord) {
    return this.db
      .prepare(
        `INSERT INTO jobs (
           id, company_id, provider, external_job_id,
           title, location, employment_type, department, team, description_plain,
           job_url, apply_url, compensation_text,
           source_published_at, publication_time_kind,
           first_seen_at, detected_at, last_seen_at, confirmed_inactive_at,
           source_updated_at, content_hash,
           match_score, match_reasons_json,
           status, absent_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, company_id, external_job_id) DO UPDATE SET
           id = excluded.id,
           title = excluded.title,
           location = excluded.location,
           employment_type = excluded.employment_type,
           department = excluded.department,
           team = excluded.team,
           description_plain = excluded.description_plain,
           job_url = excluded.job_url,
           apply_url = excluded.apply_url,
           compensation_text = excluded.compensation_text,
           source_published_at = excluded.source_published_at,
           publication_time_kind = excluded.publication_time_kind,
           detected_at = excluded.detected_at,
           last_seen_at = excluded.last_seen_at,
           confirmed_inactive_at = excluded.confirmed_inactive_at,
           source_updated_at = excluded.source_updated_at,
           content_hash = excluded.content_hash,
           match_score = excluded.match_score,
           match_reasons_json = excluded.match_reasons_json,
           status = excluded.status,
           absent_count = excluded.absent_count`,
      )
      .bind(
        job.id,
        job.companyId,
        job.provider,
        job.externalJobId,
        job.title,
        job.location ?? null,
        job.employmentType ?? null,
        job.department ?? null,
        job.team ?? null,
        job.descriptionPlain ?? null,
        job.jobUrl,
        job.applyUrl,
        job.compensationText ?? null,
        job.sourcePublishedAt ?? null,
        job.publicationTimeKind,
        job.firstSeenAt,
        job.detectedAt,
        job.lastSeenAt,
        job.confirmedInactiveAt ?? null,
        job.sourceUpdatedAt ?? null,
        job.contentHash,
        job.matchScore ?? null,
        job.matchReasonsJson ?? null,
        job.status,
        job.absentCount,
      );
  }

  /** Touch last_seen only; no content changes. */
  async touchJobSeen(externalJobId: string, companyId: string, seenAt: string): Promise<void> {
    await this.touchJobSeenStmt(externalJobId, companyId, seenAt).run();
  }

  /** Batched variant of touchJobSeen (one D1 API call per 100 rows). */
  async batchTouchJobSeen(
    entries: { externalJobId: string; companyId: string; seenAt: string }[],
  ): Promise<void> {
    for (let i = 0; i < entries.length; i += 100) {
      await this.db.batch(
        entries
          .slice(i, i + 100)
          .map((e) => this.touchJobSeenStmt(e.externalJobId, e.companyId, e.seenAt)),
      );
    }
  }

  private touchJobSeenStmt(externalJobId: string, companyId: string, seenAt: string) {
    return this.db
      .prepare(
        `UPDATE jobs SET last_seen_at = ?, absent_count = 0
         WHERE company_id = ? AND external_job_id = ?`,
      )
      .bind(seenAt, companyId, externalJobId);
  }

  async markJobAbsent(
    externalJobId: string,
    companyId: string,
    absentCount: number,
    now: string,
  ): Promise<void> {
    await this.markJobAbsentStmt(externalJobId, companyId, absentCount, now).run();
  }

  /** Batched variant of markJobAbsent (one D1 API call per 100 rows). */
  async batchMarkJobAbsent(
    entries: { externalJobId: string; companyId: string; absentCount: number; now: string }[],
  ): Promise<void> {
    for (let i = 0; i < entries.length; i += 100) {
      await this.db.batch(
        entries
          .slice(i, i + 100)
          .map((e) => this.markJobAbsentStmt(e.externalJobId, e.companyId, e.absentCount, e.now)),
      );
    }
  }

  private markJobAbsentStmt(
    externalJobId: string,
    companyId: string,
    absentCount: number,
    now: string,
  ) {
    const nowInactive = absentCount >= 2;
    return this.db
      .prepare(
        `UPDATE jobs SET absent_count = ?,
           confirmed_inactive_at = CASE WHEN ? THEN ? ELSE confirmed_inactive_at END,
           status = CASE WHEN ? THEN 'inactive' ELSE status END,
           last_seen_at = last_seen_at
         WHERE company_id = ? AND external_job_id = ?`,
      )
      .bind(absentCount, nowInactive ? 1 : 0, now, nowInactive ? 1 : 0, companyId, externalJobId);
  }

  async getSourceState(companyId: string): Promise<SourceState | null> {
    const row = await this.db
      .prepare("SELECT * FROM source_state WHERE company_id = ?")
      .bind(companyId)
      .first();
    if (!row) return null;
    return {
      companyId: String(row.company_id),
      lastSuccessAt: row.last_success_at ? String(row.last_success_at) : undefined,
      lastFailureAt: row.last_failure_at ? String(row.last_failure_at) : undefined,
      failureStreak: Number(row.failure_streak),
      backoffUntil: row.backoff_until ? String(row.backoff_until) : undefined,
      lastHttpStatus: row.last_http_status !== null ? Number(row.last_http_status) : undefined,
      lastErrorCode: row.last_error_code ? String(row.last_error_code) : undefined,
      lastContentFingerprint: row.last_content_fingerprint
        ? String(row.last_content_fingerprint)
        : undefined,
    };
  }

  async recordSourceSuccess(
    companyId: string,
    now: string,
    httpStatus?: number,
    fingerprint?: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO source_state (company_id, last_success_at, last_failure_at, failure_streak, backoff_until, last_http_status, last_error_code, last_content_fingerprint)
         VALUES (?, ?, NULL, 0, NULL, ?, NULL, ?)
         ON CONFLICT(company_id) DO UPDATE SET
           last_success_at = excluded.last_success_at,
           failure_streak = 0,
           backoff_until = NULL,
           last_http_status = excluded.last_http_status,
           last_error_code = NULL,
           last_content_fingerprint = excluded.last_content_fingerprint`,
      )
      .bind(companyId, now, httpStatus ?? null, fingerprint ?? null)
      .run();
  }

  async recordSourceFailure(
    companyId: string,
    now: string,
    code: string,
    httpStatus?: number,
    backoffUntil?: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO source_state (company_id, last_success_at, last_failure_at, failure_streak, backoff_until, last_http_status, last_error_code, last_content_fingerprint)
         VALUES (?, NULL, ?, 1, ?, ?, ?, NULL)
         ON CONFLICT(company_id) DO UPDATE SET
           last_failure_at = excluded.last_failure_at,
           failure_streak = failure_streak + 1,
           backoff_until = excluded.backoff_until,
           last_http_status = excluded.last_http_status,
           last_error_code = excluded.last_error_code`,
      )
      .bind(companyId, now, backoffUntil ?? null, httpStatus ?? null, code)
      .run();
  }

  /** Upsert a notification attempt; one row per (job, channel). */
  async recordNotificationAttempt(attempt: {
    jobId: string;
    channel: string;
    attemptedAt: string;
    delivered: boolean;
    latencyMs?: number;
    errorCode?: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO notifications (job_id, channel, attempted_at, delivered, latency_ms, error_code)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id, channel) DO UPDATE SET
           attempted_at = excluded.attempted_at,
           delivered = excluded.delivered,
           latency_ms = excluded.latency_ms,
           error_code = excluded.error_code`,
      )
      .bind(
        attempt.jobId,
        attempt.channel,
        attempt.attemptedAt,
        attempt.delivered ? 1 : 0,
        attempt.latencyMs ?? null,
        attempt.errorCode ?? null,
      )
      .run();
  }

  /**
   * Clear the delivered flag for a job/channel (audit F4). Used when a job
   * reopens or its content changes: the old delivered row must not suppress
   * a fresh alert for the new posting.
   */
  async resetNotificationDelivery(jobId: string, channel: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE notifications SET delivered = 0, error_code = 'superseded'
         WHERE job_id = ? AND channel = ? AND delivered = 1`,
      )
      .bind(jobId, channel)
      .run();
  }

  /**
   * Atomically claim the right to send a notification (audit F6).
   *
   * Cross-instance duplicate sends happened because the old guard was
   * read-then-send: two isolates could both see "no delivered row" and both
   * send. This single-statement upsert is the claim:
   * - no row          -> inserted as in-flight ('sending'), claim succeeds
   * - delivered row   -> conflict, WHERE fails, claim fails (duplicate guard)
   * - in-flight row   -> claim fails while the marker is fresh (another
   *                      isolate is sending); stale markers (crash) expire
   *                      after CLAIM_TTL_MS and the claim succeeds again
   *
   * Returns true only for the isolate that won the claim; that isolate
   * must call recordNotificationAttempt with the final state afterwards.
   */
  async claimNotificationSend(
    jobId: string,
    channel: string,
    attemptedAt: string,
  ): Promise<boolean> {
    const staleBefore = new Date(Date.parse(attemptedAt) - CLAIM_TTL_MS).toISOString();
    const res = await this.db
      .prepare(
        `INSERT INTO notifications (job_id, channel, attempted_at, delivered, latency_ms, error_code)
         VALUES (?, ?, ?, 0, NULL, 'sending')
         ON CONFLICT(job_id, channel) DO UPDATE SET
           attempted_at = excluded.attempted_at,
           delivered = 0,
           latency_ms = NULL,
           error_code = 'sending'
         WHERE notifications.delivered = 0
           AND NOT (notifications.error_code = 'sending' AND notifications.attempted_at > ?)`,
      )
      .bind(jobId, channel, attemptedAt, staleBefore)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  async listUndeliveredNotifications(): Promise<NotificationRecord[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM notifications WHERE delivered = 0 ORDER BY attempted_at")
      .all();
    return results.map((row) => ({
      id: Number(row.id),
      jobId: String(row.job_id),
      channel: String(row.channel),
      attemptedAt: String(row.attempted_at),
      delivered: Number(row.delivered) === 1,
      latencyMs: row.latency_ms !== null ? Number(row.latency_ms) : undefined,
      errorCode: row.error_code ? String(row.error_code) : undefined,
    }));
  }

  /** Read the latest notification row for a job/channel (duplicate-send guard). */
  async getNotification(jobId: string, channel: string): Promise<NotificationRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM notifications WHERE job_id = ? AND channel = ?")
      .bind(jobId, channel)
      .first();
    if (!row) return null;
    return {
      id: Number(row.id),
      jobId: String(row.job_id),
      channel: String(row.channel),
      attemptedAt: String(row.attempted_at),
      delivered: Number(row.delivered) === 1,
      latencyMs: row.latency_ms !== null ? Number(row.latency_ms) : undefined,
      errorCode: row.error_code ? String(row.error_code) : undefined,
    };
  }

  async getJobById(jobId: string): Promise<JobRecord | null> {
    const row = await this.db.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first();
    return row ? rowToJob(row) : null;
  }

  async getApplication(jobId: string): Promise<ApplicationRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM applications WHERE job_id = ?")
      .bind(jobId)
      .first();
    if (!row) return null;
    return {
      jobId: String(row.job_id),
      status: String(row.status) as ApplicationStatus,
      savedAt: row.saved_at ? String(row.saved_at) : undefined,
      appliedAt: row.applied_at ? String(row.applied_at) : undefined,
      oaAt: row.oa_at ? String(row.oa_at) : undefined,
      interviewAt: row.interview_at ? String(row.interview_at) : undefined,
      finalAt: row.final_at ? String(row.final_at) : undefined,
      offerAt: row.offer_at ? String(row.offer_at) : undefined,
      rejectedAt: row.rejected_at ? String(row.rejected_at) : undefined,
      ghostedAt: row.ghosted_at ? String(row.ghosted_at) : undefined,
      notes: row.notes ? String(row.notes) : undefined,
    };
  }

  async upsertApplication(app: ApplicationRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO applications (job_id, status, saved_at, applied_at, oa_at, interview_at, final_at, offer_at, rejected_at, ghosted_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           status = excluded.status,
           saved_at = excluded.saved_at,
           applied_at = excluded.applied_at,
           oa_at = excluded.oa_at,
           interview_at = excluded.interview_at,
           final_at = excluded.final_at,
           offer_at = excluded.offer_at,
           rejected_at = excluded.rejected_at,
           ghosted_at = excluded.ghosted_at,
           notes = excluded.notes`,
      )
      .bind(
        app.jobId,
        app.status,
        app.savedAt ?? null,
        app.appliedAt ?? null,
        app.oaAt ?? null,
        app.interviewAt ?? null,
        app.finalAt ?? null,
        app.offerAt ?? null,
        app.rejectedAt ?? null,
        app.ghostedAt ?? null,
        app.notes ?? null,
      )
      .run();
  }

  /**
   * Set an application status, stamping the corresponding timestamp column
   * (PRD 8.3). Previously set timestamps are preserved, so moving from
   * APPLIED to INTERVIEW keeps applied_at.
   */
  async setApplicationStatus(jobId: string, status: ApplicationStatus, now: string): Promise<void> {
    const existing = await this.getApplication(jobId);
    const base: ApplicationRecord = {
      jobId,
      status,
      savedAt: existing?.savedAt,
      appliedAt: existing?.appliedAt,
      oaAt: existing?.oaAt,
      interviewAt: existing?.interviewAt,
      finalAt: existing?.finalAt,
      offerAt: existing?.offerAt,
      rejectedAt: existing?.rejectedAt,
      ghostedAt: existing?.ghostedAt,
      notes: existing?.notes,
    };
    switch (status) {
      case "SAVED":
        base.savedAt ??= now;
        break;
      case "APPLIED":
        base.appliedAt ??= now;
        break;
      case "OA":
        base.oaAt ??= now;
        break;
      case "INTERVIEW":
        base.interviewAt ??= now;
        break;
      case "FINAL":
        base.finalAt ??= now;
        break;
      case "OFFER":
        base.offerAt ??= now;
        break;
      case "REJECTED":
        base.rejectedAt ??= now;
        break;
      case "GHOSTED":
        base.ghostedAt ??= now;
        break;
      case "DETECTED":
        break;
    }
    await this.upsertApplication(base);
  }

  async insertPollMetric(m: {
    provider: string;
    shard: string;
    startedAt: string;
    finishedAt: string;
    companiesPolled: number;
    successful: number;
    failed: number;
    newJobs: number;
    durationMs: number;
    latencyPercentiles?: { p50: number; p95: number; p99: number };
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO poll_metrics (provider, shard, started_at, finished_at, companies_polled, successful, failed, new_jobs, duration_ms, request_latency_p50_ms, request_latency_p95_ms, request_latency_p99_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        m.provider,
        m.shard,
        m.startedAt,
        m.finishedAt,
        m.companiesPolled,
        m.successful,
        m.failed,
        m.newJobs,
        m.durationMs,
        m.latencyPercentiles?.p50 ?? null,
        m.latencyPercentiles?.p95 ?? null,
        m.latencyPercentiles?.p99 ?? null,
      )
      .run();
  }
}
