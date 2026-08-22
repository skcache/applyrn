/**
 * ApplyRN V2 — application profile (human-supervised application execution).
 *
 * PRD §22: detected → user approves → browser agent opens form →
 * known factual fields filled → unknown/sensitive fields pause for user →
 * final review → submit.
 *
 * The profile is the resume-as-data the agent fills from. It is gitignored
 * personal data (config/private/profile.json) — never committed, never sent
 * anywhere except into form fields on boards the user approved.
 *
 * Everything here is pure: no browser, no network, fully testable.
 */

/** A single answer the agent is allowed to fill into a form field. */
export type ProfileAnswer = {
  /** Canonical field key, e.g. "first_name", "email", "resume_path". */
  key: string;
  /** The value to type/select/upload. */
  value: string;
  /**
   * Classification drives the human gate (PRD §22):
   * - factual:    objective data from the profile (name, email, phone,
   *               links, education, experience). Auto-filled.
   * - statement:  generated-but-reviewed text (cover letter, "why us").
   *               Filled only when the user pre-approved the text; else pause.
   * - sensitive:  never auto-filled (SSN, work authorization documents,
   *               salary expectations, demographics). Always pause.
   */
  kind: "factual" | "statement" | "sensitive";
};

export type ApplicationProfile = {
  /** Profile version for forward-compatible migrations. */
  version: 1;
  answers: ProfileAnswer[];
  /**
   * Global pause switches. Even "factual" answers are skipped when their
   * category is paused; the field then falls to the human queue.
   */
  pausedCategories: string[];
  /**
   * Hard stop-list: substrings (lowercased) that force a pause when they
   * appear in a field's label, regardless of mapping confidence.
   */
  labelStopList: string[];
};

/** Canonical keys the mapper understands, with common label synonyms. */
export const FIELD_SYNONYMS: Record<string, string[]> = {
  first_name: ["first name", "given name", "fname"],
  last_name: ["last name", "surname", "family name", "lname"],
  full_name: ["full name", "your name", "name"],
  email: ["email", "e-mail", "email address"],
  phone: ["phone", "mobile", "cell", "telephone", "phone number"],
  location: ["location", "city", "where are you located", "current location"],
  linkedin: ["linkedin", "linkedin profile", "linkedin url"],
  github: ["github", "github profile", "github url", "portfolio (github)"],
  portfolio: ["portfolio", "website", "personal website", "homepage"],
  resume: ["resume", "cv", "attach resume", "upload resume", "resume/cv"],
  school: ["school", "university", "college", "education", "institution"],
  degree: ["degree", "highest degree", "level of education"],
  grad_year: ["graduation year", "grad year", "expected graduation"],
  years_experience: [
    "years of experience",
    "how many years",
    "years experience",
    "experience (years)",
  ],
  work_authorization: ["work authorization", "authorized to work", "legally authorized"],
  sponsorship: ["sponsorship", "require sponsorship", "visa sponsorship"],
  salary: ["salary", "compensation expectations", "desired salary", "pay expectations"],
  start_date: ["start date", "available start", "earliest start date"],
  why_company: ["why do you want to work", "why this company", "why us"],
  cover_letter: ["cover letter", "cover note"],
};

/** Labels that ALWAYS pause, even if a synonym matches (defense-in-depth). */
export const DEFAULT_LABEL_STOP_LIST = [
  "ssn",
  "social security",
  "date of birth",
  "dob",
  "gender",
  "race",
  "ethnicity",
  "veteran",
  "disability",
  "salary",
  "compensation",
  "signature",
];

/** Map a form label to a canonical key, or null when unknown. */
export function canonicalKeyForLabel(label: string): string | null {
  const norm = label.toLowerCase().replace(/[*_:]/g, " ").replace(/\s+/g, " ").trim();
  for (const [key, synonyms] of Object.entries(FIELD_SYNONYMS)) {
    if (synonyms.some((s) => norm === s || norm.includes(s))) return key;
  }
  return null;
}

/** Classify a canonical key. */
export function classifyKey(key: string): ProfileAnswer["kind"] {
  if (["salary", "work_authorization", "sponsorship"].includes(key)) return "sensitive";
  if (["why_company", "cover_letter"].includes(key)) return "statement";
  return "factual";
}

export type FieldPlan =
  | { action: "fill"; key: string; value: string }
  | { action: "pause"; key: string | null; reason: string };

/**
 * Decide what to do with ONE form field (PRD §22 flow):
 * fill when confidently mapped to an allowed factual answer;
 * pause for unknown labels, sensitive topics, or paused categories.
 */
export function planField(
  field: { label: string; required: boolean },
  profile: ApplicationProfile,
): FieldPlan {
  const lowerLabel = field.label.toLowerCase();
  if (profile.labelStopList.some((s) => lowerLabel.includes(s))) {
    return { action: "pause", key: null, reason: `stop-list label: "${field.label}"` };
  }
  const key = canonicalKeyForLabel(field.label);
  if (!key) {
    return {
      action: "pause",
      key: null,
      reason: `unknown field: "${field.label}"${field.required ? " (required)" : ""}`,
    };
  }
  const kind = classifyKey(key);
  if (kind === "sensitive") {
    return { action: "pause", key, reason: `sensitive: ${key}` };
  }
  if (profile.pausedCategories.includes(kind)) {
    return { action: "pause", key, reason: `category paused: ${kind}` };
  }
  const answer = profile.answers.find((a) => a.key === key && a.kind === kind);
  if (!answer) {
    return { action: "pause", key, reason: `no profile answer for ${key}` };
  }
  return { action: "fill", key, value: answer.value };
}
