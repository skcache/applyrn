/**
 * Deterministic relevance engine (PRD section 5, revised V0).
 *
 * This is a convenience layer with HARD gates. A job outside the user's
 * stated scope — non-US location, wrong seniority level, or a non-software
 * role family — is suppressed: it still gets persisted in the dashboard,
 * but it never triggers the normal Telegram alert. Within-scope roles are
 * ranked by a title-weighted score.
 *
 * Scope (matches the user's stated V0 acceptance):
 *  - Geography: US only (remote-US or in-person-US).
 *  - Level: early-career only (internships, co-ops, apprenticeships, new
 *    grad, early career, entry level, work study).
 *  - Role family: software + data + ML engineering track only. Sales,
 *    marketing, design, PM, recruiting, operations, etc. are excluded even
 *    when the title contains "engineer".
 *
 * No LLM, no embeddings: purely deterministic keyword logic so the hot path
 * keeps working if every AI service dies.
 */

import {
  DESCRIPTION_STRONG_SKILLS,
  EARLY_CAREER_MARKERS,
  ENGINEERING_TRACK_MARKERS,
  NON_ENGINEERING_ROLE_MARKERS,
  NON_US_REGIONS,
  SENIORITY_MARKERS,
  TITLE_STRONG_SKILLS,
  US_STATE_CODES,
  US_STATES_AND_TERRITORIES,
  type RelevanceProfile,
} from "./profile.js";

export type RelevanceResult = {
  /** 0-100 normalized score. Ranks within-scope roles; gates below threshold. */
  score: number;
  /** Human-readable reasons for the score, e.g. "Internship", "Python". */
  reasons: string[];
  /** True when a hard mismatch suppresses the normal alert. */
  suppressed: boolean;
  /** Why it was suppressed, when suppressed. */
  suppressionReason?: string;
};

const DEFAULT_PROFILE: RelevanceProfile = {
  allowedCountries: ["US"],
  alertThreshold: 15,
};

export type RelevanceInput = {
  title: string;
  location?: string;
  employmentType?: string;
  department?: string;
  team?: string;
  descriptionPlain?: string;
};

/** Experience minimum / hard-level body signals (title + description). */
const BODY_HARD_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /(\d{1,2})\s*\+?\s*(years?|yrs?)\s+(of\s+)?(professional\s+)?experience/i,
    reason: "Years-of-experience minimum",
  },
  { pattern: /\bph\.?d\s*(degree|required|preferred)?\b/i, reason: "PhD requirement" },
];

/** Escape a literal for use inside a RegExp. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Nice display name for a skill token ("c++" -> "C++", "llm" -> "LLM", ...). */
function friendlySkill(skill: string): string {
  const s = skill.toLowerCase();
  if (s === "c++" || s === "cpp") return "C++";
  if (s === "c#") return "C#";
  if (["sql", "llm", "rag", "etl", "aws", "gcp", "ai", "ml", "go"].includes(s)) {
    return s.toUpperCase();
  }
  if (s === "accenture" || s === "azure") return "Azure";
  if (s.length === 0) return skill;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Word-boundary match of any literal in `list` against `text`. */
function hasAny(text: string, list: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const item of list) {
    if (new RegExp(`(^|[^a-z])${esc(item.toLowerCase())}([^a-z]|$)`).test(lower)) {
      return item;
    }
  }
  return null;
}

/** Friendly reason label for an early-career marker. */
function earlyCareerLabel(marker: string): string {
  const m = marker.toLowerCase();
  if (m.startsWith("intern") || m.startsWith("co-op") || m === "coop" || m === "campus") {
    return "Internship";
  }
  if (m.includes("apprentice")) return "Apprenticeship";
  if (m.startsWith("work")) return "Work study";
  return "Early career";
}

/** Specificity-ordered track labels; the first marker matched in this order
 * wins, so "Embedded Software Engineer" is labeled Embedded, not Software. */
const TRACK_LABEL_PRIORITY: [string, string][] = [
  ["ml", "ML / AI"],
  ["machine learning", "ML / AI"],
  ["ai", "ML / AI"],
  ["nlp", "ML / AI"],
  ["data", "Data"],
  ["embedded", "Embedded"],
  ["firmware", "Embedded"],
  ["test", "Test / automation"],
  ["testing", "Test / automation"],
  ["qa", "Test / automation"],
  ["quality assurance", "Test / automation"],
  ["automation", "Test / automation"],
  ["developer tools", "Developer tools"],
  ["devtools", "Developer tools"],
  ["infra", "Infrastructure / cloud"],
  ["cloud", "Infrastructure / cloud"],
  ["infrastructure", "Infrastructure / cloud"],
  ["sre", "DevOps / SRE"],
  ["devops", "DevOps / SRE"],
  ["backend", "Backend"],
  ["back end", "Backend"],
  ["frontend", "Frontend"],
  ["front end", "Frontend"],
  ["full-stack", "Full-stack"],
  ["fullstack", "Full-stack"],
  ["platform", "Systems / platform"],
  ["systems", "Systems / platform"],
];

/**
 * Best-fit engineering-track family for a title: returns the highest-priority
 * label among all marker matches (falling back to generic software).
 */
function engineeringFamilyFor(title: string): string | null {
  const lower = title.toLowerCase();
  for (const [marker, label] of TRACK_LABEL_PRIORITY) {
    if (new RegExp(`(^|[^a-z])${esc(marker.toLowerCase())}([^a-z]|$)`).test(lower)) {
      return label;
    }
  }
  return hasAny(title, ENGINEERING_TRACK_MARKERS) ? "Software engineering" : null;
}

/** Is the location US (explicit US text, state, or state code after comma)? */
function looksUS(location: string | undefined): boolean {
  if (!location) return true; // unknown; do not hard-suppress on absence
  const loc = location.toLowerCase();
  const explicitUS = /\bus\b|\busa\b|\bu\.s\b|\bu\.s\.a\.\b|\bunited states\b/.test(loc);
  const remoteUSOnly = /(remote[^a-z](us|usa|us only|united states))|(us[^a-z]remote)/.test(loc);
  if (explicitUS || remoteUSOnly) return true;
  if (hasAny(loc, US_STATES_AND_TERRITORIES)) return true;
  // US state codes can collide with real words; only treat a two-letter code
  // as a state when it follows a comma ("City, ST").
  const m = location.match(/, *([A-Za-z]{2})\b/);
  if (m && (US_STATE_CODES as readonly string[]).includes(m[1]!.toUpperCase())) {
    return true;
  }
  return false;
}

/** US-only gate: suppress when an explicit non-US region is detected. */
function nonUSRegion(location: string | undefined): string | null {
  if (!location) return null;
  const detected = hasAny(location, NON_US_REGIONS);
  if (!detected) return null;
  // A US state/city next to the region (e.g. "Paris, TX" or "London, KY") is
  // a real US location and must not be suppressed.
  return looksUS(location) ? null : detected;
}

/** Early-career scope gate: an intern/co-op/new-grad-style marker is required. */
function earlyCareerMarker(title: string): string | null {
  return hasAny(title, EARLY_CAREER_MARKERS);
}

/** Seniority gate: suppress lead/senior/staff/manager/director titles. */
function seniorityMarker(title: string): string | null {
  return hasAny(title, SENIORITY_MARKERS);
}

/**
 * Role-family gate: only software + data + ML engineering-track roles.
 * Explicit non-engineering families (sales/marketing/design/PM/recruiter/...)
 * WIN over an "engineer" substring, per the user's stated scope — a "Sales
 * Engineer" or "Design Engineer" is out of scope even though it says engineer.
 * An early-career title with NO explicit family (e.g. "Summer Intern") is
 * IN scope: missing a plausible internship is worse than surfacing a mediocre
 * one (PRD), and the user's exclusion list is explicit rather than an
 * allow-list.
 */
function roleFamilyOutOfScope(title: string, department?: string, team?: string): string | null {
  const roleText = (department ? `${title} ${department}` : title) + (team ? ` ${team}` : "");
  const nonEng = hasAny(roleText, NON_ENGINEERING_ROLE_MARKERS);
  return nonEng ?? null; // null → within scope (no excluded family matched)
}

/**
 * Title-weighted score (0-100). Title signals weigh ~3x description signals,
 * and description contribution is capped so a job description stuffed with
 * buzzwords cannot inflate a role that the title itself does not support.
 */
function scoreRole(input: RelevanceInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  let descriptionPoints = 0;

  const level = earlyCareerMarker(input.title);
  if (level) {
    reasons.push(earlyCareerLabel(level));
    score += 30;
  } else if (input.descriptionPlain) {
    const descLevel = hasAny(input.descriptionPlain, EARLY_CAREER_MARKERS);
    if (descLevel) {
      reasons.push(earlyCareerLabel(descLevel));
      score += 10;
    }
  }

  const track = engineeringFamilyFor(input.title);
  if (track) {
    reasons.push(track);
    score += 30;
  } else if (input.descriptionPlain) {
    const descTrack = hasAny(input.descriptionPlain, ENGINEERING_TRACK_MARKERS);
    if (descTrack) {
      reasons.push("Engineering-related");
      descriptionPoints += 10;
    }
  }

  // Title skills weigh full; description skills are capped at 20 total.
  const addSkill = (skill: string) => {
    const label = friendlySkill(skill);
    if (!reasons.includes(label)) reasons.push(label);
  };
  for (const skill of TITLE_STRONG_SKILLS) {
    if (hasAny(input.title, [skill])) {
      addSkill(skill);
      score += 15;
    }
  }
  if (input.descriptionPlain) {
    for (const skill of DESCRIPTION_STRONG_SKILLS) {
      if (hasAny(input.descriptionPlain, [skill])) {
        addSkill(skill);
        descriptionPoints += 5;
      }
    }
  }
  descriptionPoints = Math.min(descriptionPoints, 20);

  // Location: US base + remote.
  const locationText = (input.location ?? "").toLowerCase();
  if (looksUS(input.location) && /remote/.test(locationText)) {
    reasons.push("Remote");
    score += 10;
  } else if (looksUS(input.location)) {
    reasons.push("US");
    score += 10;
  } else if (/remote/.test(locationText)) {
    // Non-US remote is gated earlier; this branch is defense-in-depth.
    reasons.push("Remote");
    descriptionPoints += 5;
  } else if (hasAny(locationText, ["hybrid", "in-office", "on-site"])) {
    reasons.push("US");
    score += 5;
  }

  return { score: Math.min(100, score + descriptionPoints), reasons };
}

export function evaluateRelevance(
  input: RelevanceInput,
  profile: RelevanceProfile = DEFAULT_PROFILE,
): RelevanceResult {
  // --- Hard gates: any hit suppresses the normal alert (job still persisted). ---

  // 1. US-only location.
  const foreign = nonUSRegion(input.location);
  if (foreign) {
    return {
      score: 0,
      reasons: [],
      suppressed: true,
      suppressionReason: `Outside US (${foreign})`,
    };
  }

  // 2. Seniority / leadership: the user's scope is early-career only.
  const senior = seniorityMarker(input.title);
  if (senior) {
    return {
      score: 0,
      reasons: [],
      suppressed: true,
      suppressionReason: `Senior/leadership level (${senior})`,
    };
  }

  // 3. Role family: software + data + ML engineering-track only.
  const nonEng = roleFamilyOutOfScope(input.title, input.department, input.team);
  if (nonEng) {
    return {
      score: 0,
      reasons: [],
      suppressed: true,
      suppressionReason: `Non-engineering role (${nonEng})`,
    };
  }

  // 4. Early-career scope (title marker required; description marker is a
  //    weak secondary that still alerts, matching "ranks don't hide broadly
  //    relevant early-career roles").
  const titleLevel = earlyCareerMarker(input.title);
  const descLevel = input.descriptionPlain
    ? hasAny(input.descriptionPlain, EARLY_CAREER_MARKERS)
    : null;
  if (!titleLevel && !descLevel) {
    return {
      score: 0,
      reasons: [],
      suppressed: true,
      suppressionReason: "Not early-career scope (missing intern/co-op/new-grad signal)",
    };
  }

  // 5. Years-of-experience and PhD bodies.
  for (const rule of BODY_HARD_PATTERNS) {
    if (rule.pattern.test(input.title) || rule.pattern.test(input.descriptionPlain ?? "")) {
      return {
        score: 0,
        reasons: [],
        suppressed: true,
        suppressionReason: rule.reason,
      };
    }
  }

  const { score, reasons } = scoreRole(input);
  if (score < profile.alertThreshold) {
    return {
      score,
      reasons,
      suppressed: true,
      suppressionReason: `Below alert threshold (${score} < ${profile.alertThreshold})`,
    };
  }

  return { score, reasons, suppressed: false };
}
