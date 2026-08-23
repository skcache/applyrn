-- 0008: V3 §6 — interview scheduling from .ics attachments.
--
-- applications.interview_at: start time of the scheduled interview (ISO),
-- extracted from calendar attachments on interview_invite emails.
-- applications.interview_location: video link / office address as stated.

ALTER TABLE applications ADD COLUMN interview_at TEXT;
ALTER TABLE applications ADD COLUMN interview_location TEXT;
