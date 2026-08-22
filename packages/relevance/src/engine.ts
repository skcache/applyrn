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
  FULL_TIME_MAX_WEEK_HOURS,
  MAX_EXPERIENCE_YEARS,
  NON_ENGINEERING_ROLE_MARKERS,
  NON_SOFTWARE_DISCIPLINES,
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

/**
 * Audit 2026-08-22 V2: hard cap on board-supplied description text used for
 * scoring. All relevance signals (skills, hours, YoE, markers) appear in the
 * first pages of any real posting; 64KB bounds the ~135 full-text scans per
 * job and prevents a hostile multi-MB description from wedging the cycle.
 */
export const DESCRIPTION_CAP = 64 * 1024;

export type RelevanceInput = {
  title: string;
  location?: string;
  employmentType?: string;
  department?: string;
  team?: string;
  descriptionPlain?: string;
};

/** PhD requirement is a hard body-signal regardless of level. */
const PHD_PATTERN = /\bph\.?d\s*(degree|required|preferred)?\b/i;

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
  if (m.includes("part-time") || m.includes("part time") || m.includes("hours")) {
    return "Part-time";
  }
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

/** Early-career signals: marker presence AND any stated years requirement,
 * computed independently — a contradicting requirement (e.g. an "internship"
 * that demands 5+ years) must still suppress. Hours-per-week phrasing
 * ("15-20 hours per week") counts as a part-time marker when the top of the
 * range is at most FULL_TIME_MAX_WEEK_HOURS. */
function earlyCareerSignal(input: RelevanceInput): { marker?: string; maxYears?: number } {
  const titleMarker = earlyCareerMarker(input.title);
  const descMarker = input.descriptionPlain ? earlyCareerMarker(input.descriptionPlain) : null;
  const hours = statedWeeklyHours(`${input.title} ${input.descriptionPlain ?? ""}`);
  const hoursMarker =
    hours !== null && hours <= FULL_TIME_MAX_WEEK_HOURS ? "part-time (hours)" : undefined;
  return {
    marker: titleMarker ?? descMarker ?? hoursMarker ?? undefined,
    maxYears: statedMaxYears(input) ?? undefined,
  };
}

/**
 * Highest weekly-hours figure stated in hours-per-week phrasing ("15-20
 * hours/week", "20 hrs per week", "up to 24 hours weekly"), or null when no
 * such phrase exists. Only hour RANGES/caps count: "40 hours" alone is a
 * full-time statement, not a marker.
 */
function statedWeeklyHours(text: string): number | null {
  const figures: number[] = [];
  const patterns = [
    /(\d{1,2})\s*-\s*(\d{1,2})\s*(?:hours?|hrs?)\b/gi,
    /(?:up to|max(?:imum)?|less than)\s+(\d{1,2})\s*(?:hours?|hrs?)\b/gi,
    /(\d{1,2})\s*(?:hours?|hrs?)\s*(?:\/|per)\s*(?:week|wk)\b/gi,
    /(\d{1,2})\s*(?:hours?|hrs?)\s+(?:weekly|a week)\b/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      if (m[1]) figures.push(Number(m[1]));
      if (m[2]) figures.push(Number(m[2]));
    }
  }
  // Audit 2026-08-22: Math.max(...figures) throws RangeError when a hostile
  // board packs ~150k matches into one description (spread exceeds the call
  // stack). Fold with a loop instead — O(n), constant stack.
  let max: number | null = null;
  for (const f of figures) if (max === null || f > max) max = f;
  return max;
}

/**
 * Highest years-of-experience requirement explicitly stated in the title or
 * description, or null when none is stated. Handles "3+ years", "5 years",
 * "2-4 years", "0-2 years X experience". Only a REQUIREMENT counts: prose
 * like "we are a 10-year-old company" must not suppress a junior role.
 */
function statedMaxYears(input: RelevanceInput): number | null {
  const text = `${input.title} ${input.descriptionPlain ?? ""}`;
  const requirements: number[] = [];
  const patterns = [
    /(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:professional|relevant|industry|work)?\s*experience/gi,
    /(\d{1,2})\s*-\s*(\d{1,2})\s*(?:years?|yrs?)\s+(?:of\s+)?experience/gi,
    /(?:minimum|require|requires|required)\s*(?:of\s*)?(\d{1,2})\s*(?:\+|to)?\s*(?:years?|yrs?)/gi,
    /at\s+least\s+(\d{1,2})\s*(?:years?|yrs?)/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      if (m[1]) requirements.push(Number(m[1]));
      if (m[2]) requirements.push(Number(m[2]));
    }
  }
  // Audit 2026-08-22: same spread-crash fix as statedWeeklyHours.
  let max: number | null = null;
  for (const r of requirements) if (max === null || r > max) max = r;
  return max;
}

/**
 * Role-family gate: only software + data + ML engineering-track roles.
 * Explicit non-engineering families (sales/marketing/design/PM/recruiter/...)
 * WIN over an "engineer" substring, per the user's stated scope — a "Sales
 * Engineer" or "Design Engineer" is out of scope even though it says engineer.
 *
 * 2026-08-21 hardening: the title itself must carry an explicit
 * SOFTWARE/eng-track signal (software/swe/developer/backend/data/ml/infra/
 * security-engineer/quant/... or a real tech skill like python/rust). A bare
 * "Store Executive Intern" or "Culinary Service Associate" has none and is
 * suppressed even though its description says "university"/"student".
 */
function titleHasSoftwareSignal(title: string): string | null {
  if (engineeringFamilyFor(title)) return engineeringFamilyFor(title);
  // Real tech skills in the title also count ("Python Developer Intern",
  // "React Engineer Intern").
  return hasAny(title, TITLE_STRONG_SKILLS);
}

function roleFamilyOutOfScope(title: string, department?: string, team?: string): string | null {
  // 1. Explicit non-software engineering disciplines win first ("Bridge
  //    Engineer", "Process Engineer Intern") unless the title also carries a
  //    software-specific marker ("Embedded Software Engineer" stays in).
  if (hasAny(title, NON_SOFTWARE_DISCIPLINES)) {
    // "Software"/"data"/"ml"/"backend" etc. override the discipline hit only
    // when the software marker is itself explicit in the title.
    const explicitSoftwareWord = hasAny(title, [
      "software",
      "swe",
      "developer",
      "programmer",
      "backend",
      "back end",
      "frontend",
      "front end",
      "full-stack",
      "fullstack",
      "data engineer",
      "data science",
      "machine learning",
      "ml engineer",
      "firmware",
    ]);
    if (!explicitSoftwareWord) return "non-software engineering discipline";
  }
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
  // Audit 2026-08-22 V2: board-supplied descriptions are unbounded (Ashby
  // boards embed full JDs; a hostile board can send megabytes). Cap BEFORE
  // any scanning: every keyword/skill a relevance engine cares about appears
  // in the first pages of a posting, so 64KB preserves legitimate scoring
  // while bounding CPU (~135 full-text scans) and memory per job.
  const descriptionPlain = input.descriptionPlain?.slice(0, DESCRIPTION_CAP);

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

  // 3. Role family: software + data + ML engineering-track only. The TITLE
  //    itself must carry the software signal (2026-08-21): descriptions are
  //    not consulted here, so "Store Executive Intern" (description: "for
  //    university students!") cannot ride an early-career marker into scope.
  const nonEng = roleFamilyOutOfScope(input.title, input.department, input.team);
  if (nonEng) {
    return {
      score: 0,
      reasons: [],
      suppressed: true,
      suppressionReason: `Non-engineering role (${nonEng})`,
    };
  }
  if (!titleHasSoftwareSignal(input.title)) {
    return {
      score: 0,
      reasons: [],
      suppressed: true,
      suppressionReason: "No software/engineering signal in title (scope: SWE/data/ML only)",
    };
  }

  // 4. Experience/scope gate. The user's scope is BOTH internships AND
  //    full-time, capped at 0-2 YoE. A role is in-scope when it has an
  //    early-career marker (intern/co-op/new-grad/entry-level/junior/level-I), OR
  //    its stated years-of-experience requirement is at most 2. This admits
  //    full-time roles the moment their posting shows 0-1/0-2 YoE ("0-2 years
  //    experience", "new grad", "Software Engineer I") while NOT re-flooding
  //    with bare mid-level "Software Engineer" titles that carry no junior
  //    signal — the exact noise the user asked to kill. A stated requirement
  //    OVER the cap suppresses regardless of any marker (an "internship that
  //    demands 5+ years" is contradictory and out).
  const early = earlyCareerSignal(input);

  if (early.maxYears !== undefined && early.maxYears > MAX_EXPERIENCE_YEARS) {
    return {
      score: 0,
      reasons: [],
      suppressed: true,
      suppressionReason: `Requires ${early.maxYears}+ years of experience (over 0-${MAX_EXPERIENCE_YEARS} YoE scope)`,
    };
  }
  if (early.marker === undefined && early.maxYears === undefined) {
    return {
      score: 0,
      reasons: [],
      suppressed: true,
      suppressionReason:
        "Not 0-2 YoE scope (no intern/new-grad marker and no stated experience requirement)",
    };
  }

  // 5. PhD is a hard body-signal regardless of level/marker.
  if (PHD_PATTERN.test(input.title) || PHD_PATTERN.test(descriptionPlain ?? "")) {
    return {
      score: 0,
      reasons: [],
      suppressed: true,
      suppressionReason: "PhD requirement",
    };
  }

  const { score, reasons } = scoreRole({ ...input, descriptionPlain });
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
