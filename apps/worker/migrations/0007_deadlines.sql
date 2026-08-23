-- 0007: V3 §5 — OA deadline tracking.
--
-- applications.deadline_at: when the latest assessment_invite stated an
-- explicit completion deadline (ISO). NULL = no deadline known; reminder
-- sweep skips those. Set/cleared by the promotion pipeline.
--
-- application_events.deadline_source: how the deadline was expressed
-- (relative_days | absolute_date | explicit_iso) — audit for "why does it
-- think this is due".

ALTER TABLE applications ADD COLUMN deadline_at TEXT;

ALTER TABLE application_events ADD COLUMN deadline_source TEXT;

ALTER TABLE applications ADD COLUMN deadline_reminded_at TEXT;
