/**
 * V3 §2 — deterministic matcher: link email events to applications.
 *
 * No embeddings, no edit-distance (prior art: every OSS tracker uses exact
 * normalized matching; similarity floors only where tokens overlap). Three
 * tiers, strongest first:
 *   1. ATS sender domain ↔ application.company_domain (exact)
 *   2. Company-name token overlap (normalized token Jaccard ≥ 0.5)
 *   3. Role-title token overlap (tiebreaker between multiple tier-2 hits)
 */

const COMPANY_SUFFIXES =
  /\b(inc|inc\.|llc|corp|corp\.|corporation|ltd|ltd\.|limited|gmbh|co|co\.|company|holdings|group|technologies|technology|labs|studio|studios)\b/g;

/** Normalize a company name: lowercase, strip suffixes/legal noise, collapse. */
export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokenize a normalized string into non-trivial tokens. */
export function tokenize(s: string): Set<string> {
  return new Set(
    normalizeCompany(s)
      .split(" ")
      .filter((t) => t.length > 1),
  );
}

/** Jaccard similarity over token sets: |A∩B| / |A∪B|. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Extract the sending domain from a From header value. */
export function senderDomain(fromHeader: string | null): string | null {
  if (!fromHeader) return null;
  // Accept either a bare address or a full "Name <addr>" header.
  const m = fromHeader.match(/<([^>]+)>/);
  const email = (m?.[1] ?? fromHeader).trim().toLowerCase();
  return email.split("@")[1] ?? null;
}

/**
 * Tier-2 company match: does the email's From/subject mention the company?
 * Uses token-set Jaccard with the documented baseline floor (0.3) but we
 * require ≥0.5 for auto-linking — company names are short and false links
 * are worse than new rows.
 */
/**
 * Containment: |A∩B| / |A| — how much of A's tokens appear in B. Unlike
 * Jaccard, this stays meaningful when one side is much longer (a full email
 * subject vs a short company name), mirroring pg_trgm's word_similarity.
 */
export function tokenContainment(needle: string, haystack: string): number {
  const a = [...tokenize(needle)];
  if (a.length === 0) return 0;
  const b = tokenize(haystack);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / a.length;
}

/** Company-name similarity: containment both ways, max of the two. */
export function companyTokenSimilarity(nameA: string, nameB: string): number {
  return Math.max(tokenContainment(nameA, nameB), tokenContainment(nameB, nameA));
}

export const COMPANY_MATCH_THRESHOLD = 0.5;

export type LinkCandidate = { id: number; company: string; role: string | null };

export type LinkResult =
  { linked: true; applicationId: number; tier: "domain" | "company" } | { linked: false };

/**
 * Match an email event to an existing application.
 * - domainHit: an application whose company_domain equals the sender domain.
 * - candidates: all applications to compare by company-name tokens.
 */
export function matchEmailToApplication(
  fromDomain: string | null,
  subject: string,
  domainHit: LinkCandidate | null,
  candidates: LinkCandidate[],
): LinkResult {
  // Tier 1: exact sender-domain match.
  if (fromDomain && domainHit) return { linked: true, applicationId: domainHit.id, tier: "domain" };

  // Tier 2: company-token overlap against subject text (which usually names
  // the company: "We received your application for X at Acme").
  let best: { id: number; score: number } | null = null;
  for (const c of candidates) {
    // Containment of company tokens within the subject (subject >> company
    // in length, so plain Jaccard would under-score every real match).
    const sim = tokenContainment(c.company, subject);
    if (sim >= COMPANY_MATCH_THRESHOLD && (!best || sim > best.score)) {
      best = { id: c.id, score: sim };
    }
  }
  if (best) return { linked: true, applicationId: best.id, tier: "company" };
  return { linked: false };
}
