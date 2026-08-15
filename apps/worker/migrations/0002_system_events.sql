-- ApplyRN V0 schema, migration 2: system events (PRD Issue 11 observability).
-- Incident ledger for scheduler heartbeats and other system-level notices.
-- An open row (cleared_at IS NULL) is the dedupe key: the same incident is
-- only re-alerted after it has been cleared.

CREATE TABLE system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  message TEXT,
  cleared_at TEXT
);

CREATE INDEX idx_system_events_kind ON system_events(kind, occurred_at);
