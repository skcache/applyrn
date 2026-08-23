-- 0009: V3 §7 — resume-version tracking.
--
-- applications.resume_label: which resume variant was sent (e.g. "backend",
-- "fullstack", "infra"). Free-text, human-assigned at apply time or later.
-- The V2 agent stamps it automatically from APPLYRN_RESUME_LABEL when it
-- submits; manual rows can set it via PATCH.

ALTER TABLE applications ADD COLUMN resume_label TEXT;
