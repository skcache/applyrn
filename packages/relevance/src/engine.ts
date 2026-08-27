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
  US_METRO_IDENTIFIERS,
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
  /** Board-provided publish time (freshness signal; optional). */
  sourcePublishedAt?: string;
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
  if (hasAny(loc, US_METRO_IDENTIFIERS)) return true;
  // US state codes can collide with real words; only treat a two-letter code
  // as a state when it follows a comma ("City, ST").
  const m = location.match(/, *([A-Za-z]{2})\b/);
  if (m && (US_STATE_CODES as readonly string[]).includes(m[1]!.toUpperCase())) {
    return true;
  }
  return false;
}

/**
 * V3 audit fix A: non-US detection now covers the whole world by COUNTRY
 * name plus major non-US cities/regions (the old list missed entire
 * continents — Malaysia and the Philippines leaked through). Matched only
 * against word boundaries via hasAny.
 */
const NON_US_COUNTRIES = [
  // Americas (non-US)
  "canada",
  "mexico",
  "brazil",
  "argentina",
  "chile",
  "colombia",
  "peru",
  "uruguay",
  "paraguay",
  "bolivia",
  "ecuador",
  "venezuela",
  "guyana",
  "suriname",
  "panama",
  "costa rica",
  "guatemala",
  "honduras",
  "nicaragua",
  "el salvador",
  "belize",
  "cuba",
  "dominican republic",
  "haiti",
  "jamaica",
  "puerto rico",
  // Europe
  "uk",
  "united kingdom",
  "england",
  "scotland",
  "wales",
  "northern ireland",
  "ireland",
  "france",
  "germany",
  "spain",
  "portugal",
  "italy",
  "netherlands",
  "belgium",
  "switzerland",
  "austria",
  "sweden",
  "norway",
  "denmark",
  "finland",
  "iceland",
  "poland",
  "czech",
  "slovakia",
  "hungary",
  "romania",
  "bulgaria",
  "greece",
  "croatia",
  "serbia",
  "slovenia",
  "estonia",
  "latvia",
  "lithuania",
  "ukraine",
  "belarus",
  "russia",
  "turkey",
  "malta",
  "cyprus",
  "luxembourg",
  "monaco",
  // Middle East
  "israel",
  "uae",
  "united arab emirates",
  "dubai",
  "abu dhabi",
  "saudi arabia",
  "qatar",
  "kuwait",
  "bahrain",
  "oman",
  "jordan",
  "lebanon",
  "iraq",
  "iran",
  // Africa
  "egypt",
  "south africa",
  "nigeria",
  "kenya",
  "ghana",
  "morocco",
  "tunisia",
  "ethiopia",
  "uganda",
  "tanzania",
  "algeria",
  // Asia — South
  "india",
  "pakistan",
  "bangladesh",
  "sri lanka",
  "nepal",
  // Asia — Southeast (V3 audit: these were missing entirely)
  "philippines",
  "philippine",
  "manila",
  "laguna",
  "binan",
  "biñan",
  "cebu",
  "quezon",
  "makati",
  "taguig",
  "malaysia",
  "malaysian",
  "kuala lumpur",
  "penang",
  "george town",
  "petaling jaya",
  "selangor",
  "bayan lepas",
  "johor",
  "ipoh",
  "singapore",
  "indonesia",
  "jakarta",
  "vietnam",
  "viet nam",
  "ho chi minh",
  "hanoi",
  "thailand",
  "bangkok",
  "cambodia",
  "myanmar",
  "laos",
  // Asia — East
  "china",
  "beijing",
  "shanghai",
  "shenzhen",
  "beijing",
  "hangzhou",
  "suzhou",
  "taiwan",
  "taipei",
  "hong kong",
  "macau",
  "japan",
  "tokyo",
  "osaka",
  "kyoto",
  "yokohama",
  "south korea",
  "korea",
  "seoul",
  "busan",
  "mongolia",
  // Oceania
  "australia",
  "sydney",
  "melbourne",
  "brisbane",
  "perth",
  "new zealand",
  "auckland",
  "wellington",
];

/**
 * Non-US region detection for the allowlist gate: country names + major
 * cities worldwide. A hit suppresses UNLESS a US state/city is also present
 * ("Paris, TX" case).
 */
function nonUSRegion(location: string | undefined): string | null {
  if (!location) return null;
  const detected = hasAny(location, NON_US_REGIONS) ?? hasAny(location, NON_US_COUNTRIES);
  if (!detected) return null;
  // A US state/city next to the region (e.g. "Paris, TX" or "London, KY") is
  // a real US location and must not be suppressed. R2-4 (sec audit run-2):
  // overriding a DETECTED COUNTRY requires strong US evidence — a state name
  // or comma state code ("Los Angeles, Chile" must stay suppressed); the
  // informal metro list alone is not enough.
  const loc = location.toLowerCase();
  const strongUS =
    hasAny(loc, US_STATES_AND_TERRITORIES) !== null ||
    (/, *([A-Za-z]{2})\b/.test(location) &&
      (US_STATE_CODES as readonly string[]).includes(
        (location.match(/, *([A-Za-z]{2})\b/) ?? [])[1]?.toUpperCase() ?? "",
      ));
  return strongUS ? null : detected;
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
/**
 * Positive software-signal check used by both the gate and the scorer.
 *
 * 2026-08-26 fix (gate-leakage audit): the bare "engineer"/"engineering"
 * tokens are NO LONGER a positive signal by themselves. Previously
 * `engineeringFamilyFor` returned truthy for any "Engineer"/"Engineering"
 * title, so "Materials Engineering Intern" / "Nuclear Engineer I" passed the
 * role-family gate on the generic word alone — leaking ~30% of live alerts
 * (physical-world engineering). A title now needs an EXPLICIT software-family
 * word (software/data/ml/backend/frontend/swe/developer/infra/systems/
 * embedded/quant) OR a strong tech skill (python/react/go/...) to count as
 * in-scope. "Embedded Software Engineer" still passes; "Hardware Engineer
 * Intern" no longer does.
 */
function titleHasSoftwareSignal(title: string): string | null {
  // An explicit software-family word wins (every entry in
  // ENGINEERING_TRACK_MARKERS EXCEPT the generic "engineer"/"engineering"
  // tokens). The bare "engineer"/"engineering" tokens are deliberately NOT a
  // signal here — 2026-08-26 fix for ~30% gate-leakage (physical-world
  // engineering roles like "Materials Engineering Intern" rode the generic
  // word into scope). So "Software/Backend/Data/ML/Embedded/Computer Vision
  // Engineering Intern" passes; "Hardware/Materials/Nuclear Engineering
  // Intern" does not.
  const EXPLICIT_FAMILY = ENGINEERING_TRACK_MARKERS.filter(
    (m) => m !== "engineer" && m !== "engineering",
  );
  // Add computer-vision / robotics / graphics tracks (core SWE/ML, but not
  // in the generic marker list).
  const FAMILY_EXTRA = [
    "computer vision",
    "cv",
    "robotics",
    "graphics",
    "algorithm",
    "deep learning",
    "neural",
    "compiler",
    "distributed systems",
    "reliability", // Site Reliability Engineer — unambiguous SWE infra
  ];
  if (hasAny(title, [...EXPLICIT_FAMILY, ...FAMILY_EXTRA])) return "software family";
  // Real tech skills in the title also count ("Python Developer Intern",
  // "React Engineer Intern").
  const skill = hasAny(title, TITLE_STRONG_SKILLS);
  return skill ? "strong skill" : null;
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
    // "engineer"/"engineering" alone is NOT a software signal (2026-08-26 fix);
    // a discipline hit must win unless a specific software-family word above
    // is present, so "Materials Engineering Intern" is suppressed.
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
/**
 * 2026-08-25 rescoring (user request: "add more depth to the score out of
 * 100"). The old additive checklist had a floor of ~70 for every passer
 * (+30 intern, +30 eng-track, +10 US were guaranteed by the gates), so the
 * number carried no ranking signal. The redesign keeps the SAME gates and
 * pass/fail behavior — only the number changes:
 *
 *   title relevance   0-40   MAX of matched specificity tiers, not a sum
 *   skills            0-25   overlap ratio over canonical skill ids
 *   career level      0-15   explicit markers rank; desc-only marker partial
 *   freshness         0-10   newer postings score higher (intern-pipeline
 *                            aware: never punishes early posts hard)
 *   location          0-10   US+remote > US > hybrid
 *
 * Missing descriptions are NEUTRAL (skills default to a modest midpoint from
 * title alone), not zero — boards that don't serve JDs shouldn't be punished.
 */
function scoreRole(input: RelevanceInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // --- Title relevance: 0-40, MAX tier wins --------------------------------
  // Specificity-ordered: an exact family+level title outranks a generic one.
  const titleLower = input.title.toLowerCase();
  let titleScore = 12; // passed gates ⇒ some software signal exists in title
  const trackLabel = engineeringFamilyFor(input.title);
  if (trackLabel) reasons.push(trackLabel);
  if (
    /\b(software|backend|back end|frontend|front end|full[- ]?stack|fullstack|platform|infrastructure|devops|sre|embedded|firmware|machine learning|ml |data engineer|data science|quant)/i.test(
      titleLower,
    )
  ) {
    titleScore = Math.max(titleScore, 28);
  }
  if (
    /\b(intern|internship|co-?op|new grad|new-grad|graduate engineer|university grad|campus|early career|entry[- ]?level)/i.test(
      titleLower,
    )
  ) {
    titleScore += 6;
  }
  // Strong-skill-in-title is the strongest single relevance signal.
  const titleSkillHits = TITLE_STRONG_SKILLS.filter((skill) => hasAny(input.title, [skill]));
  if (titleSkillHits.length > 0) {
    titleScore = Math.max(titleScore, 34);
    reasons.push(...titleSkillHits.slice(0, 3).map(friendlySkill));
  }
  score += Math.min(40, titleScore);

  // --- Career level: 0-15 ---------------------------------------------------
  const level = earlyCareerMarker(input.title);
  if (level) {
    reasons.push(earlyCareerLabel(level));
    score += 13;
  } else if (input.descriptionPlain && hasAny(input.descriptionPlain, EARLY_CAREER_MARKERS)) {
    const descLevel = hasAny(input.descriptionPlain, EARLY_CAREER_MARKERS);
    if (descLevel) {
      reasons.push(earlyCareerLabel(descLevel));
      score += 9; // marker only in description → partial credit
    }
  }

  // --- Skills: 0-25, canonical overlap ratio -------------------------------
  // Canonical ids prevent go/golang or ml/machine-learning double-fires.
  const CANONICAL: Record<string, string> = {
    go: "golang",
    ml: "machine learning",
    "machine learning": "machine learning",
    js: "javascript",
    javascript: "javascript",
    k8s: "kubernetes",
    kubernetes: "kubernetes",
    aws: "aws",
    react: "react",
    python: "python",
    typescript: "typescript",
    java: "java",
    rust: "rust",
    cpp: "c++",
    "c++": "c++",
    sql: "sql",
    docker: "docker",
  };
  const hitCanonical = new Set<string>();
  for (const skill of titleSkillHits) {
    const key = skill.toLowerCase();
    hitCanonical.add(CANONICAL[key] ?? key);
  }
  if (input.descriptionPlain) {
    for (const skill of DESCRIPTION_STRONG_SKILLS) {
      const label = friendlySkill(skill);
      if (!reasons.includes(label) && hasAny(input.descriptionPlain, [skill])) {
        const key = skill.toLowerCase();
        const canon = CANONICAL[key] ?? key;
        if (!hitCanonical.has(canon)) {
          hitCanonical.add(canon);
          if (reasons.filter((r) => r === label).length === 0) reasons.push(label);
        }
      }
    }
  }
  // Overlap ratio against a 6-skill expectation: 1 unique skill ≈ 8,
  // 2 ≈ 14, 3 ≈ 19, 4+ ≈ 23-25. Saturating, so keyword walls can't buy score.
  const uniq = hitCanonical.size;
  const skillScore = uniq === 0 ? 6 : Math.min(25, 4 + uniq * 7);
  if (uniq >= 3 && !reasons.includes("Multi-stack")) reasons.push("Multi-stack");
  score += skillScore;

  // --- Freshness: 0-10 -------------------------------------------------------
  // Intern-pipeline aware: a posting for next summer is NOT stale today.
  // Base 6 for everything (gates already bound volume); +4 when the board
  // published it within the last 21 days.
  let freshScore = 6;
  const published = input.sourcePublishedAt ? Date.parse(input.sourcePublishedAt) : NaN;
  const nowMs = Date.now();
  if (Number.isFinite(published) && Number.isFinite(nowMs)) {
    const ageDays = (nowMs - published) / 86_400_000;
    if (ageDays <= 3) freshScore = 10;
    else if (ageDays <= 7) freshScore = 9;
    else if (ageDays <= 21) freshScore = 8;
    else if (ageDays <= 45) freshScore = 6;
    else freshScore = 4; // old but intern pipelines recycle — mild penalty only
    if (freshScore >= 9 && !reasons.includes("Fresh")) reasons.push("Fresh");
  }
  score += freshScore;

  // --- Location: 0-10 ---------------------------------------------------------
  const locationText = (input.location ?? "").toLowerCase();
  if (looksUS(input.location) && /remote/.test(locationText)) {
    reasons.push("Remote (US)");
    score += 10;
  } else if (looksUS(input.location)) {
    reasons.push("US");
    score += 8;
    if (/(san francisco|new york|seattle|austin|boston|los angeles)/i.test(locationText)) {
      reasons.push("Major tech hub");
      score += 2;
    }
  } else if (/remote/.test(locationText)) {
    reasons.push("Remote");
    score += 6;
  } else if (hasAny(locationText, ["hybrid", "in-office", "on-site"])) {
    reasons.push("US");
    score += 6;
  }

  return { score: Math.min(100, Math.round(score)), reasons };
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

  // 1. US-only location (V3 audit fix A: allowlist semantics). A location
  //    that is neither recognizably US nor absent now suppresses — previously
  //    unknown locations fell through and alerted on title score alone,
  //    which leaked Malaysia/Philippines postings. Bare "Remote" stays
  //    eligible: the nonUSRegion check above already suppressed any location
  //    carrying a known foreign marker, so a surviving "Remote" is treated
  //    as US-remote (the dominant convention on US boards).
  const foreign = nonUSRegion(input.location);
  const isBareRemote = /^\s*remote\s*$/i.test(input.location ?? "");
  const usConfirmed = looksUS(input.location) || !input.location || isBareRemote;
  if (foreign || !usConfirmed) {
    return {
      score: 0,
      reasons: [],
      suppressed: true,
      suppressionReason: foreign
        ? `Outside US (${foreign})`
        : `Location not identifiable as US (${input.location})`,
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
