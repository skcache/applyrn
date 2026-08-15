/**
 * Provider-independent domain contracts for ApplyRN.
 *
 * Everything in this package is platform-neutral TypeScript: no Cloudflare,
 * no Node, no network. The Worker, adapters, detection engine, and dashboard
 * all speak these shapes.
 */

/** How confident we are in a job's publication time. */
export type PublicationTimeKind = "authoritative" | "observed";

/**
 * The single normalized shape every provider adapter must produce.
 * Mirrors PRD section 3 (Source Contracts).
 */
export type NormalizedJob = {
  /** Adapter provider id, e.g. "greenhouse". */
  provider: string;
  /** Company id from the watchlist (companies.id). */
  companyId: string;
  /** Provider-specific job id, stable across polls. */
  externalJobId: string;

  title: string;
  location?: string;
  employmentType?: string;
  department?: string;
  team?: string;

  descriptionPlain?: string;

  jobUrl: string;
  applyUrl: string;

  compensationText?: string;

  /** Authoritative publication timestamp if the source exposes one. */
  sourcePublishedAt?: string;
  sourceUpdatedAt?: string;
  publicationTimeKind: PublicationTimeKind;
};

/** A company in the watchlist (companies table row). */
export type CompanyConfig = {
  id: string;
  name: string;
  careersUrl?: string;
  /** Adapter provider id, e.g. "greenhouse". */
  provider: string;
  /** Provider-specific board key, e.g. a Greenhouse board token. */
  boardKey: string;
  enabled: boolean;
  pollIntervalSeconds: number;
  tags?: string[];
  createdAt: string;
};

/**
 * Lifecycle status of a job row.
 * baseline: persisted during the first successful poll, never alerted.
 * new:      unseen after baseline, alert pending or sent once.
 * active:   seen again after being new.
 * inactive: absent from 2 consecutive successful polls.
 * reopened: inactive job reappeared; alert again.
 */
export type JobStatus = "baseline" | "new" | "active" | "inactive" | "reopened";

/** Persisted job row (jobs table). */
export type JobRecord = {
  id: string;
  companyId: string;
  provider: string;
  externalJobId: string;

  title: string;
  location?: string;
  employmentType?: string;
  department?: string;
  team?: string;
  descriptionPlain?: string;

  jobUrl: string;
  applyUrl: string;
  compensationText?: string;

  sourcePublishedAt?: string;
  publicationTimeKind: PublicationTimeKind;
  firstSeenAt: string;
  detectedAt: string;
  lastSeenAt: string;
  confirmedInactiveAt?: string;

  sourceUpdatedAt?: string;
  contentHash: string;

  matchScore?: number;
  matchReasonsJson?: string;

  status: JobStatus;
  /** Consecutive successful polls where this job was absent. */
  absentCount: number;
};

/** Source health row (source_state table). */
export type SourceState = {
  companyId: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  failureStreak: number;
  backoffUntil?: string;
  lastHttpStatus?: number;
  lastErrorCode?: string;
  lastContentFingerprint?: string;
};

/** Application tracking row (applications table). */
export type ApplicationStatus =
  | "DETECTED"
  | "SAVED"
  | "APPLIED"
  | "OA"
  | "INTERVIEW"
  | "FINAL"
  | "OFFER"
  | "REJECTED"
  | "GHOSTED";

export type ApplicationRecord = {
  jobId: string;
  status: ApplicationStatus;
  savedAt?: string;
  appliedAt?: string;
  oaAt?: string;
  interviewAt?: string;
  finalAt?: string;
  offerAt?: string;
  rejectedAt?: string;
  ghostedAt?: string;
  notes?: string;
};

/** Notification attempt row (notifications table). */
export type NotificationRecord = {
  id: number;
  jobId: string;
  channel: string;
  attemptedAt: string;
  delivered: boolean;
  latencyMs?: number;
  errorCode?: string;
};

export const DEFAULT_POLL_INTERVAL_SECONDS = 120;
