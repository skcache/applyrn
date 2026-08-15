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
    };
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
    await this.db
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
      )
      .run();
  }

  /** Touch last_seen only; no content changes. */
  async touchJobSeen(externalJobId: string, companyId: string, seenAt: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE jobs SET last_seen_at = ?, absent_count = 0
         WHERE company_id = ? AND external_job_id = ?`,
      )
      .bind(seenAt, companyId, externalJobId)
      .run();
  }

  async markJobAbsent(
    externalJobId: string,
    companyId: string,
    absentCount: number,
    now: string,
  ): Promise<void> {
    const nowInactive = absentCount >= 2;
    await this.db
      .prepare(
        `UPDATE jobs SET absent_count = ?,
           confirmed_inactive_at = CASE WHEN ? THEN ? ELSE confirmed_inactive_at END,
           status = CASE WHEN ? THEN 'inactive' ELSE status END,
           last_seen_at = last_seen_at
         WHERE company_id = ? AND external_job_id = ?`,
      )
      .bind(absentCount, nowInactive ? 1 : 0, now, nowInactive ? 1 : 0, companyId, externalJobId)
      .run();
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
