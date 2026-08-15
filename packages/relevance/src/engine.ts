/**
 * Deterministic relevance engine (PRD section 5).
 *
 * This is a convenience layer, NOT an application gate. A low score ranks a
 * job lower; it never hides it. Only HARD mismatches may suppress the normal
 * Telegram alert (and even then the job stays persisted and visible in the
 * dashboard).
 *
 * No LLM, no embeddings: purely deterministic keyword logic so the hot path
 * keeps working if every AI service dies.
 */

export type RelevanceResult = {
  /** 0-100 normalized score. Ranks, does not gate. */
  score: number;
  /** Human-readable reasons for the score, e.g. "Internship", "Python". */
  reasons: string[];
  /** True when a hard mismatch suppresses the normal alert. */
  suppressed: boolean;
  /** Why it was suppressed, when suppressed. */
  suppressionReason?: string;
};

/**
 * Hard suppression rules (PRD 5.2). Deliberately conservative.
 *
 * Seniority/leadership/occupation signals are matched against the TITLE
 * only: prose like "you will work alongside staff engineers" must never
 * suppress an internship. Experience/PhD requirements are matched against
 * title + description because that is where they live.
 */
const TITLE_HARD_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern:
      /\b(staff|senior staff|principal)\s+(software|engineer|engineering|swe|developer|data|ml|ai|research|platform|systems|backend|frontend|infrastructure)\b/i,
    reason: "Senior-level role (staff/principal)",
  },
  { pattern: /\b(staff|principal)\s+engineer\b/i, reason: "Senior-level role (staff/principal)" },
  { pattern: /\b(director|vp|vice president|head of)\b/i, reason: "Leadership role (director/VP)" },
  // Clearly non-software occupations. Narrow on purpose (PRD 5.2).
  {
    pattern:
      /\b(barista|driver|delivery|cashier|server|chef|cook|retail|warehouse|janitor|nurse|teacher|sales associate|receptionist)\b/i,
    reason: "Non-software role",
  },
];

const BODY_HARD_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /(\d{1,2})\s*\+?\s*(years?|yrs?)\s+(of\s+)?(professional\s+)?experience/i,
    reason: "Years-of-experience minimum",
  },
  { pattern: /\bph\.?d\s*(degree|required|preferred)?\b/i, reason: "PhD requirement" },
];

/** Positive signals (PRD 5.3): strong/medium/light map to 30/20/10 points. */
const SIGNALS: { pattern: RegExp; reason: string; points: number }[] = [
  // strong
  {
    pattern: /\b(intern|internship|co-op|coop|apprenticeship)\b/i,
    reason: "Internship",
    points: 30,
  },
  {
    pattern: /\b(software engineer|swe|software engineering|developer|programmer)\b/i,
    reason: "Software engineering",
    points: 30,
  },
  { pattern: /\b(backend|back-end)\b/i, reason: "Backend", points: 30 },
  { pattern: /\b(infrastructure|systems|platform)\b/i, reason: "Systems / platform", points: 30 },
  {
    pattern: /\b(machine learning|ml|artificial intelligence|\bai\b|applied ai)\b/i,
    reason: "ML / AI",
    points: 30,
  },
  // medium
  { pattern: /\bresearch engineer\b/i, reason: "Research engineer", points: 20 },
  { pattern: /\b(c\+\+|cpp)\b/i, reason: "C / C++", points: 20 },
  { pattern: /\bpython\b/i, reason: "Python", points: 20 },
  { pattern: /\btypescript\b/i, reason: "TypeScript", points: 20 },
  { pattern: /\blinux\b/i, reason: "Linux", points: 20 },
  { pattern: /\bpytorch\b/i, reason: "PyTorch", points: 20 },
  { pattern: /\binference\b/i, reason: "Inference", points: 20 },
  { pattern: /\bdistributed systems\b/i, reason: "Distributed systems", points: 20 },
  { pattern: /\bdeveloper tools\b/i, reason: "Developer tools", points: 20 },
  // light
  { pattern: /\b(bay area|san francisco|sf)\b/i, reason: "Bay Area / SF", points: 10 },
  { pattern: /\bremote\b/i, reason: "Remote", points: 10 },
];

export type RelevanceInput = {
  title: string;
  location?: string;
  employmentType?: string;
  department?: string;
  team?: string;
  descriptionPlain?: string;
};

function haystack(input: RelevanceInput): string {
  return [
    input.title,
    input.location,
    input.employmentType,
    input.department,
    input.team,
    input.descriptionPlain,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");
}

export function evaluateRelevance(input: RelevanceInput): RelevanceResult {
  const text = haystack(input);

  // Hard suppressions first: they win over any positive signals.
  for (const rule of TITLE_HARD_PATTERNS) {
    if (rule.pattern.test(input.title)) {
      return { score: 0, reasons: [], suppressed: true, suppressionReason: rule.reason };
    }
  }
  for (const rule of BODY_HARD_PATTERNS) {
    if (rule.pattern.test(text)) {
      return { score: 0, reasons: [], suppressed: true, suppressionReason: rule.reason };
    }
  }

  const reasons: string[] = [];
  let score = 0;
  for (const signal of SIGNALS) {
    if (signal.pattern.test(text)) {
      reasons.push(signal.reason);
      score += signal.points;
    }
  }

  return { score: Math.min(score, 100), reasons, suppressed: false };
}
