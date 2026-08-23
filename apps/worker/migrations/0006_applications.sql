-- 0006: V3 §2 — applications + lifecycle events (the payoff sprint).
--
-- HISTORY: prod already had a V1-era `applications` table (job_id-keyed,
-- per-stage timestamp columns, 0 rows). It is renamed to
-- applications_v1_legacy and the V3-shape table takes the name.
--
-- applications: one row per real job application. Decoupled from `jobs`
-- (which tracks board postings, not applications): portals ApplyRN never
-- saw still get rows via email evidence or manual add. `status` is a
-- denormalized CACHE derived only through guarded transitions in
-- application_events (events are truth).
--
-- application_events: append-only audit trail ("which email did this").

ALTER TABLE applications RENAME TO applications_v1_legacy;

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  role TEXT,
  source TEXT NOT NULL DEFAULT 'email',     -- email | manual | applyrn_job
  applyrn_job_id TEXT,                      -- nullable link to jobs(id)
  company_domain TEXT,                      -- sender domain or careers URL host
  status TEXT NOT NULL DEFAULT 'APPLIED',   -- DETECTED|APPLIED|OA|INTERVIEW|OFFER|REJECTED|WITHDRAWN
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  event_class TEXT NOT NULL,                -- classifier class or 'manual_correction'
  email_event_id INTEGER,                   -- nullable FK to email_events(id)
  from_status TEXT,
  to_status TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_company ON applications(company);
CREATE INDEX IF NOT EXISTS idx_application_events_app ON application_events(application_id, occurred_at);
