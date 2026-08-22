-- 0003: per-trigger attribution for poll cycles.
--
-- Phase 2 (reliability hardening): the poll cycle can now be driven by three
-- independent triggers — the Cloudflare cron, the GitHub Actions fallback,
-- and an external free pinger (cron-job.org / UptimeRobot) hitting /api/tick.
-- Recording WHICH trigger drove each metrics row makes the soak verifiable:
-- "no alert gaps > 10 min" must hold even when any single trigger dies.
--
-- NULL counts as "cf-cron" in queries (COALESCE) because rows predating this
-- migration were all cron-driven.

ALTER TABLE poll_metrics ADD COLUMN trigger TEXT;

CREATE INDEX idx_poll_metrics_trigger ON poll_metrics(trigger, finished_at);
