-- ApplyRN V0 schema (PRD section 8). All timestamps UTC ISO-8601 TEXT.

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  careers_url TEXT,
  provider TEXT NOT NULL,
  board_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 120,
  tags TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_job_id TEXT NOT NULL,

  title TEXT NOT NULL,
  location TEXT,
  employment_type TEXT,
  department TEXT,
  team TEXT,
  description_plain TEXT,

  job_url TEXT NOT NULL,
  apply_url TEXT NOT NULL,
  compensation_text TEXT,

  source_published_at TEXT,
  publication_time_kind TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  confirmed_inactive_at TEXT,

  source_updated_at TEXT,
  content_hash TEXT,

  match_score INTEGER,
  match_reasons_json TEXT,

  status TEXT NOT NULL DEFAULT 'active',
  -- Consecutive successful polls where this job was absent (PRD 10.3 rule).
  absent_count INTEGER NOT NULL DEFAULT 0,

  UNIQUE(provider, company_id, external_job_id)
);

CREATE INDEX idx_jobs_company ON jobs(company_id, status);
CREATE INDEX idx_jobs_provider ON jobs(provider, status);

CREATE TABLE applications (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'DETECTED',

  saved_at TEXT,
  applied_at TEXT,
  oa_at TEXT,
  interview_at TEXT,
  final_at TEXT,
  offer_at TEXT,
  rejected_at TEXT,
  ghosted_at TEXT,

  notes TEXT
);

CREATE TABLE source_state (
  company_id TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_failure_at TEXT,
  failure_streak INTEGER NOT NULL DEFAULT 0,
  backoff_until TEXT,
  last_http_status INTEGER,
  last_error_code TEXT,
  last_content_fingerprint TEXT
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  delivered INTEGER NOT NULL,
  latency_ms INTEGER,
  error_code TEXT
);

CREATE INDEX idx_notifications_job ON notifications(job_id);
-- One attempt row per job per channel; retries UPDATE the same row so a
-- job can never produce more than one notification record.
CREATE UNIQUE INDEX idx_notifications_job_channel ON notifications(job_id, channel);

CREATE TABLE poll_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  shard TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  companies_polled INTEGER,
  successful INTEGER,
  failed INTEGER,
  new_jobs INTEGER,
  duration_ms INTEGER,
  request_latency_p50_ms INTEGER,
  request_latency_p95_ms INTEGER,
  request_latency_p99_ms INTEGER
);
