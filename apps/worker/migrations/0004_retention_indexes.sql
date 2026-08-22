-- 0004: observability performance + data retention (audit 2026-08-22).
--
-- V7a/W7 findings: poll_metrics grew unbounded (~8.6k rows/day from
-- legitimate triggers alone), had NO index on finished_at while every
-- /api/status call runs MAX(finished_at) and /api/metrics scans a 24h
-- window. Notifications likewise never pruned.
--
-- 1. Index the heartbeat/window columns.
-- 2. Retention is enforced at runtime (repo.pruneOldData, called once per
--    cron cycle): poll_metrics 14 days (heartbeat + soak evidence),
--    terminal notifications 30 days, inactive jobs 90 days. D1 free tier
--    has no scheduled SQL; a runtime sweep on the 1-min cron is the only
--    lever that costs nothing.

CREATE INDEX IF NOT EXISTS idx_poll_metrics_finished_at ON poll_metrics(finished_at);
CREATE INDEX IF NOT EXISTS idx_notifications_attempted_at ON notifications(attempted_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
