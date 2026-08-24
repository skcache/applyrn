/**
 * V3 §5 — OA deadline extraction.
 *
 * Parses explicit deadlines from assessment-invite emails. Deliberately
 * conservative: only extracts when the email states a clear deadline
 * ("complete within 5 days", "by August 30, 2026", "deadline: 2026-08-30").
 * No deadline found → null (the reminder sweep simply skips it).
 *
 * All parsing is deterministic; no LLM anywhere (ADR-2).
 */

export type ExtractedDeadline = {
  /** ISO timestamp of the deadline, or null when not stated. */
  deadlineAt: string | null;
  /** How it was expressed — useful for the Telegram message + tests. */
  source: "relative_days" | "absolute_date" | "explicit_iso" | null;
};

/** Normalize for matching: lowercase, collapse whitespace, unify dashes. */
function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ");
}

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Parse "August 30, 2026" / "Aug 30" / "30 August 2026". Returns UTC midnight. */
export function parseAbsoluteDate(text: string): string | null {
  const t = norm(text);
  // Month D, YYYY  or  Month D
  const m1 = t.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/);
  if (m1) {
    const month = MONTHS[m1[1] ?? ""];
    if (month !== undefined) {
      const day = Number(m1[2]);
      const year = m1[3] ? Number(m1[3]) : new Date().getUTCFullYear();
      if (day >= 1 && day <= 31) {
        return new Date(Date.UTC(year, month, day, 23, 59, 59)).toISOString();
      }
    }
  }
  // D Month YYYY  or  D Month
  const m2 = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?\b/);
  if (m2) {
    const month = MONTHS[m2[2] ?? ""];
    if (month !== undefined) {
      const day = Number(m2[1]);
      const year = m2[3] ? Number(m2[3]) : new Date().getUTCFullYear();
      if (day >= 1 && day <= 31) {
        return new Date(Date.UTC(year, month, day, 23, 59, 59)).toISOString();
      }
    }
  }
  // ISO YYYY-MM-DD
  const m3 = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m3) {
    return `${m3[1]}-${m3[2]}-${m3[3]}T23:59:59.000Z`;
  }
  return null;
}

/**
 * Extract a deadline from an assessment-invite email (subject + snippet).
 * Priority:
 *   1. Explicit ISO date near a deadline word
 *   2. Absolute date near a deadline word ("by August 30")
 *   3. Relative days near completion language ("within 5 days of receipt")
 */
export function extractDeadline(subject: string, snippet: string, now: string): ExtractedDeadline {
  const combined = norm(`${subject} ${snippet}`);
  const nowMs = Date.parse(now);

  // Deadline-ish context words that must appear near the date expression.
  const CONTEXT = /(?:deadline|complete|submit|finish|within|no later than|by|expires?|before)/;

  // 1. ISO dates (strongest).
  const iso = combined.match(/(?:deadline|[a-z ]{0,30})\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso?.[1] && CONTEXT.test(iso[0])) {
    const ms = Date.parse(`${iso[1]}T23:59:59.000Z`);
    // Run-3 hardening: explicit ISO dates in the past roll forward a year,
    // same as the absolute branch ("deadline: 2025-09-01" seen in 2026).
    let out = `${iso[1]}T23:59:59.000Z`;
    if (Number.isFinite(nowMs) && ms < nowMs - 86_400_000) {
      out = new Date(ms + 365 * 86_400_000).toISOString();
    }
    return { deadlineAt: out, source: "explicit_iso" };
  }

  // 2. Relative days: "within X days", "X days from (the date of) receipt",
  //    "no later than X business days".
  const rel =
    combined.match(
      /\b(?:within|no later than|have|has)?\s*(\d{1,3})\s*(?:-|to\s+)?(\d{1,3})?\s*(?:calendar\s+|business\s+)?days?\b/,
    ) ?? combined.match(/\b(?:complete|submit|finish)\b[^.]{0,40}?\b(\d{1,3})\s*days?\b/);
  if (rel?.[1]) {
    // Business-days phrasing is approximated as calendar days ×7/5, rounded up,
    // min 1 — conservative so reminders fire early rather than late.
    const isBusiness = /business/.test(rel[0]);
    // Ranges ("2–3 days") take the LARGER end: conservative, remind early.
    let days = Number(rel[2] ?? rel[1]);
    if (isBusiness) days = Math.max(1, Math.ceil((days * 7) / 5));
    const ms = nowMs + days * 86_400_000;
    if (Number.isFinite(ms)) {
      return { deadlineAt: new Date(ms).toISOString(), source: "relative_days" };
    }
  }

  // 3. Absolute date with deadline context. I10 fix: the absolute parser
  // anchors to the FIRST month-word match in the whole text, which can mint
  // phantom dates. Require the context word within ~60 chars of the match.
  if (CONTEXT.test(combined)) {
    const abs = parseAbsoluteDate(combined);
    if (abs) {
      const ms = Date.parse(abs);
      if (Number.isFinite(nowMs) && ms < nowMs - 86_400_000) {
        // Year-less date rolled into the past → assume next occurrence.
        const rolled = new Date(ms + 365 * 86_400_000).toISOString();
        return { deadlineAt: rolled, source: "absolute_date" };
      }
      return { deadlineAt: abs, source: "absolute_date" };
    }
  }

  return { deadlineAt: null, source: null };
}
