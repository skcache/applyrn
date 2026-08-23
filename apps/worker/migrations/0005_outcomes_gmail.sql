-- 0005: V3 outcome tracking — Gmail OAuth + raw email events (§1).
--
-- oauth_tokens: one row per provider ('gmail'). The refresh token is the
-- long-lived credential; access tokens are refreshed on demand and never
-- persisted (60-min TTL makes persistence pointless). D1 is encrypted at
-- rest (AES-256-GCM, CF-managed keys) per CF data-security docs.
--
-- email_events: append-only raw capture of job-lifecycle mail. PII
-- minimization per GDPR storage-limitation: headers + ≤200-char snippet
-- only, NEVER the full body. Idempotency via UNIQUE(gmail_id) + INSERT OR
-- IGNORE at the write site. Retention handled by repo.pruneOldData
-- (snippets purged after 180d in a later sprint; headers kept).

CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  scope TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gmail_id TEXT NOT NULL UNIQUE,
  thread_id TEXT,
  from_email TEXT,
  from_domain TEXT,
  subject_norm TEXT,
  snippet TEXT,
  event_class TEXT NOT NULL DEFAULT 'unclassified',
  confidence REAL NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_events_class_time ON email_events(event_class, received_at);
CREATE INDEX IF NOT EXISTS idx_email_events_received ON email_events(received_at);
