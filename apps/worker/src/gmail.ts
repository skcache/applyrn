/**
 * V3 §1 — Gmail outcome tracking (read-only).
 *
 * Poll → classify → persist, with zero Google SDKs: every call is a plain
 * fetch. Access tokens are refreshed on demand from the stored refresh token
 * and never persisted.
 *
 * Classifier is deterministic (ADR-2): ATS sender-domain whitelist + subject
 * keyword tiers, confidence attached per rule tier. No LLM anywhere.
 */

import { log } from "./logger.js";
import { matchEmailToApplication, senderDomain, type LinkCandidate } from "./matcher.js";
import { planTransition, EVENT_TO_STATUS, type AppStatus } from "./lifecycle.js";
import { extractDeadline } from "./deadline.js";
import { parseIcsEvent } from "./ics.js";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const POLL_WINDOW_DAYS = 7; // history fallback window
const MAX_MESSAGES_PER_POLL = 25;

// --- Classifier tables -------------------------------------------------------
// ATS senders observed in production filter files (jobseeker-analytics et al)
// plus assessment vendors. Exact-domain match only — no substring surprises.
export const ATS_DOMAINS = new Set([
  "greenhouse-mail.io",
  "greenhouse.io",
  "myworkday.com",
  "smartrecruiters.com",
  "ashbyhq.com",
  "lever.co",
  "icims.com",
  "otta.com",
  "wellfound.com",
  "hackerrank.com",
  "codesignal.com",
  "docusign.net", // offers go through DocuSign
  "jobvite.com",
  "workable.com",
  "recruitee.com",
  "teamtailor.com",
  "breezy.hr",
  "applytojob.com",
]);

// Keyword tiers: first matching tier wins; word-boundary regex on normalized
// subject (+ snippet as weak secondary signal). Ported from OSS trackers'
// production vocabularies (jobseeker-analytics applied_email_filter.yaml,
// AI-Job-Application-Tracker EmailParser taxonomy) and trimmed to what we act on.
type Class =
  | "interview_invite"
  | "offer"
  | "rejection"
  | "assessment_invite"
  | "application_confirmation"
  | "unclassified";

const KEYWORD_TIERS: [Class, number, RegExp][] = [
  [
    "offer",
    0.95,
    /\boffer\b|compensation package|extend(?:ed)? (?:an )?offer|congratulations.{0,40}position/i,
  ],
  [
    "interview_invite",
    0.9,
    /\binterview\b|recruiting screen|recruiter screen|\bschedule a (?:call|chat|time)\b|availability for/i,
  ],
  [
    "assessment_invite",
    0.85,
    /hackerrank|codesignal|online assessment|take[- ]?home (?:assignment|exercise)|code assessment/i,
  ],
  [
    "rejection",
    0.8,
    /moved forward with other candidates|not moving forward|unfortunately|will not be proceeding|decided not to advance|position has been filled|no longer under consideration/i,
  ],
  [
    "application_confirmation",
    0.7,
    /received your application|thank you for applying|thanks for applying|application (?:was )?(?:submitted|received)|we(?:'ve| have) received your/i,
  ],
];

export type Classification = { eventClass: Class; confidence: number };

/** Deterministic classification. Exported for tests. */
export function classifyEmail(
  fromEmail: string | null,
  subject: string,
  snippet: string,
): Classification {
  const domain = fromEmail ? (fromEmail.split("@")[1] ?? "").toLowerCase() : "";
  const ats = ATS_DOMAINS.has(domain);
  // Subject first (strongest signal), then snippet as fallback context.
  for (const [cls, conf, re] of KEYWORD_TIERS) {
    if (re.test(subject))
      return { eventClass: cls, confidence: ats ? Math.min(1, conf + 0.05) : conf };
  }
  for (const [cls, conf, re] of KEYWORD_TIERS) {
    if (re.test(snippet)) return { eventClass: cls, confidence: Math.max(0.3, conf - 0.15) };
  }
  return { eventClass: "unclassified", confidence: ats ? 0.4 : 0 };
}

// --- Repo surface ------------------------------------------------------------
export interface GmailRepo {
  getGmailRefreshToken(): Promise<string | null>;
  saveGmailRefreshToken(refreshToken: string, scope: string): Promise<void>;
  insertEmailEvent(ev: {
    gmailId: string;
    threadId?: string;
    fromEmail?: string;
    fromDomain?: string;
    subjectNorm?: string;
    snippet?: string;
    eventClass: string;
    confidence: number;
    receivedAt: string;
    now: string;
  }): Promise<boolean>; // true = newly inserted (false = idempotent skip)
  getLastGmailHistoryId(): Promise<string | null>;
  saveGmailHistoryId(id: string): Promise<void>;
  setApplicationDeadline(
    applicationId: number,
    deadlineAt: string | null,
    source: string | null,
  ): Promise<void>;
  listApplicationsWithUpcomingDeadlines(
    nowIso: string,
    windowHours: number,
  ): Promise<
    { id: number; company: string; role: string | null; status: string; deadline_at: string }[]
  >;
  markDeadlineReminded(applicationId: number, remindedAt: string): Promise<void>;
  setInterviewSchedule(
    applicationId: number,
    whenIso: string | null,
    location: string | null,
  ): Promise<void>;
  getIcsAttachment(messageId: string, accessToken: string): Promise<string | null>;
  findApplicationByDomain(
    domain: string,
  ): Promise<{ id: number; company: string; role: string | null } | null>;
  listActiveApplications(): Promise<{ id: number; company: string; role: string | null }[]>;
  createApplication(input: {
    company: string;
    role?: string;
    source: string;
    companyDomain?: string;
    applyrnJobId?: string;
    status?: string;
    now: string;
  }): Promise<number>;
  getApplicationStatus(id: number): Promise<string | null>;
  recordApplicationEvent(input: {
    applicationId: number;
    eventClass: string;
    emailEventId?: number | null;
    fromStatus: string;
    toStatus: string;
    occurredAt: string;
    now: string;
  }): Promise<boolean>;
}

export class GmailError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "GmailError";
  }
}

// --- OAuth token refresh (pure fetch) ----------------------------------------
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(
  env: { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string },
  repo: GmailRepo,
): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt - 60_000) {
    return cachedAccessToken.token;
  }
  const refreshToken = await repo.getGmailRefreshToken();
  if (!refreshToken)
    throw new GmailError("not_linked", "No Gmail refresh token stored. Run applyrn-auth first.");
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new GmailError(
      "not_configured",
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET secrets are not set",
    );
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new GmailError(
      res.status === 400 || res.status === 401 ? "token_revoked" : "refresh_failed",
      `Gmail token refresh failed: HTTP ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  const tok = (await res.json()) as { access_token: string; expires_in: number; scope?: string };
  cachedAccessToken = { token: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 };
  return tok.access_token;
}

/** Test seam: clear the module-level access-token cache between tests. */
export function resetAccessTokenCache(): void {
  cachedAccessToken = null;
}

// --- Polling ------------------------------------------------------------------
export type GmailPollOutcome = {
  ok: boolean;
  fetched: number;
  stored: number;
  skipped: number;
  promoted: { applicationId: number; eventClass: string; from: string; to: AppStatus }[];
  createdApplications: number;
  errorCode?: string;
};

/** Company name guess for a new application row (best-effort, deterministic). */
function companyFromEvent(
  fromEmail: string | null,
  domain: string | null,
  _subject: string,
): string {
  // Prefer the readable part of the From header ("Acme Careers <...>").
  // Fallback: second-level domain label capitalized.
  if (fromEmail) {
    const m = fromEmail.match(/^"?([^"<]+?)"?\s*</);
    const readable = m?.[1]?.trim();
    if (readable) {
      return readable
        .replace(
          /\s+(careers|jobs|recruit(?:ing|ment)?|talent|hiring|no.?reply|notifications?)$/i,
          "",
        )
        .trim();
    }
    const local = fromEmail.split("@")[0] ?? "";
    if (local)
      return (
        local
          .replace(/[._-]+/g, " ")
          .replace(/(?:^|[. _-])(?:no|reply|noreply)(?:[. _-]|$)/gi, " ")
          .trim() ||
        (domain ?? "unknown")
      );
  }
  return domain ?? "unknown";
}

function gmailDateDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** Strip HTML tags + collapse whitespace for a PII-minimal snippet. */
export function toSnippet(htmlOrText: string, max = 200): string {
  const text = htmlOrText
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** Minimal shape of a gmail v1 messages.get format=full payload (vendor-defined). */
/* eslint-disable @typescript-eslint/no-explicit-any -- gmail v1 payload shapes are vendor-defined; narrowed at extraction boundaries */
type GmailMessage = any;

/**
 * Extract header value + text snippet from a messages.get format=full payload.
 * Walks payload.parts for text/plain or text/html (falls back to body.data).
 */
export function extractMessageParts(msg: GmailMessage): {
  from: string | null;
  subject: string;
  snippet: string;
  date: string | null;
} {
  const headers: Record<string, string> = {};
  for (const h of (msg.payload?.headers ?? []) as { name: string; value?: string }[]) {
    headers[h.name.toLowerCase()] = h.value ?? "";
  }
  let bodyData = "";
  const walk = (part: any): void => {
    if (!part) return;
    if (!bodyData && part.mimeType === "text/plain" && part.body?.data) bodyData = part.body.data;
    if (!bodyData && part.mimeType === "text/html" && part.body?.data) bodyData = part.body.data;
    for (const child of part.parts ?? []) walk(child);
  };
  walk(msg.payload);
  if (!bodyData && msg.payload?.body?.data) bodyData = msg.payload.body.data;

  let decoded = "";
  try {
    // Gmail uses base64url.
    const b64 = bodyData.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    decoded = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    decoded = "";
  }

  return {
    from: headers["from"] ?? null,
    subject: headers["subject"] ?? "",
    snippet: toSnippet(decoded || msg.snippet || ""),
    date: headers["date"] ?? null,
  };
}

/** Parse "From: Jane Doe <noreply@acme.myworkday.com>" → email + domain. */
export function parseFrom(fromHeader: string | null): {
  email: string | null;
  domain: string | null;
} {
  if (!fromHeader) return { email: null, domain: null };
  const m = fromHeader.match(/<([^>]+)>/) ?? [null, fromHeader.trim()];
  const email = (m[1] ?? "").toLowerCase() || null;
  const domain = email ? (email.split("@")[1] ?? null) : null;
  return { email, domain };
}

/** Run one poll cycle. Never throws; errors land in the outcome. */
export type GmailNotifyHook = (message: string, opts?: { silent?: boolean }) => Promise<void>;

/** Severity tiers per event class (anti-fatigue synthesis, see docs/v3_outcomes.md §2). */
export const NOTIFY_TIERS: Record<string, { silent: boolean; priority: 1 | 2 | 3 }> = {
  interview_invite: { silent: false, priority: 1 },
  offer: { silent: false, priority: 1 },
  rejection: { silent: true, priority: 2 },
  application_confirmation: { silent: true, priority: 3 }, // digest candidate
  assessment_invite: { silent: true, priority: 3 },
};

export async function notifyPromotions(
  promoted: GmailPollOutcome["promoted"],
  created: number,
  repo: GmailRepo,
  notify: GmailNotifyHook,
): Promise<void> {
  for (const pr of promoted) {
    const tier = NOTIFY_TIERS[pr.eventClass] ?? { silent: true, priority: 3 };
    // Fetch company for a readable message.
    const status = await repo.getApplicationStatus(pr.applicationId);
    void status;
    const msg =
      `${pr.eventClass === "interview_invite" ? "🎤" : pr.eventClass === "offer" ? "🎉" : "📧"} ` +
      `Application update: ${pr.eventClass.replace(/_/g, " ")} (${pr.from} → ${pr.to})`;
    try {
      await notify(msg, { silent: tier.silent });
    } catch {
      // notification failure must never break the poll
    }
  }
  if (created > 0) {
    try {
      await notify(`📬 ${created} new application${created > 1 ? "s" : ""} detected from email.`, {
        silent: true,
      });
    } catch {
      // notification failures are non-fatal by design
    }
  }
}

export async function pollGmail(
  env: { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string },
  repo: GmailRepo,
  now: string,
  notify?: GmailNotifyHook,
): Promise<GmailPollOutcome> {
  const outcome: GmailPollOutcome = {
    ok: false,
    fetched: 0,
    stored: 0,
    skipped: 0,
    promoted: [],
    createdApplications: 0,
  };
  let accessToken: string;
  try {
    accessToken = await getAccessToken(env, repo);
  } catch (err: any) {
    outcome.errorCode = err instanceof GmailError ? err.code : "refresh_failed";
    log.warn(`gmail poll: ${outcome.errorCode}`);
    return outcome;
  }

  try {
    await repo.getLastGmailHistoryId(); // reserved for history.list delta sync (§2)
    const q =
      `after:${gmailDateDaysAgo(POLL_WINDOW_DAYS)} ` +
      `-from:me in:inbox -category:promotions -category:social -category:forums`;

    // List newest messages matching the job-lifecycle query.
    const listRes = await fetch(
      `${GMAIL_API}/messages?maxResults=${MAX_MESSAGES_PER_POLL}&q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (listRes.status === 401) throw new GmailError("auth_expired", "access token rejected");
    if (!listRes.ok) throw new GmailError("list_failed", `messages.list HTTP ${listRes.status}`);
    const listed = (await listRes.json()) as { messages?: { id: string }[]; historyId?: string };

    for (const { id } of listed.messages ?? []) {
      outcome.fetched++;
      const getRes = await fetch(`${GMAIL_API}/messages/${id}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!getRes.ok) {
        outcome.skipped++;
        continue;
      }
      // Gmail message payload shape is vendor-defined; narrowed by extractMessageParts.
      const msg = (await getRes.json()) as Record<string, any>;
      const parts = extractMessageParts(msg);
      const { email, domain } = parseFrom(parts.from);
      const cls = classifyEmail(email, parts.subject, parts.snippet);

      // Internal Date = original receive time (RFC822 ms), stable across polls.
      const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : now;
      const inserted = await repo.insertEmailEvent({
        gmailId: id,
        threadId: msg.threadId,
        fromEmail: email ?? undefined,
        fromDomain: domain ?? undefined,
        subjectNorm: parts.subject.toLowerCase().replace(/\s+/g, " ").trim(),
        snippet: parts.snippet,
        eventClass: cls.eventClass,
        confidence: cls.confidence,
        receivedAt,
        now,
      });
      if (inserted) outcome.stored++;
      else outcome.skipped++;

      // V3 §2: promote applications. Only classified events with a status
      // mapping participate; unclassified mail never touches the funnel.
      const toStatus = EVENT_TO_STATUS[cls.eventClass];
      if (!inserted || !toStatus) continue;

      const senderDom = senderDomain(email);
      const domainHit = senderDom ? await repo.findApplicationByDomain(senderDom) : null;
      if (!domainHit) {
        // Tier-2 candidates by company-token overlap against subject.
        const candidates = await repo.listActiveApplications();
        const link = matchEmailToApplication(
          senderDom,
          parts.subject,
          null,
          candidates as LinkCandidate[],
        );
        if (!link.linked) {
          // New application row from email evidence alone.
          const newId = await repo.createApplication({
            company: companyFromEvent(email, domain, parts.subject),
            source: "email",
            companyDomain: senderDom ?? undefined,
            status: toStatus,
            now,
          });
          await repo.recordApplicationEvent({
            applicationId: newId,
            eventClass: cls.eventClass,
            emailEventId: undefined,
            fromStatus: "DETECTED",
            toStatus,
            occurredAt: receivedAt,
            now,
          });
          outcome.createdApplications++;
          if (toStatus === "OA" && cls.eventClass === "assessment_invite") {
            const dl = extractDeadline(parts.subject, parts.snippet, now);
            await repo.setApplicationDeadline(newId, dl.deadlineAt, dl.source);
          }
          if (cls.eventClass === "interview_invite") {
            const ics = await repo.getIcsAttachment(id, accessToken);
            if (ics) {
              const ev = parseIcsEvent(ics);
              if (ev.start) {
                await repo.setInterviewSchedule(newId, ev.start, ev.location);
              }
            }
          }
          continue;
        }
        // Tier-2 hit: promote that application.
        const current2 = await repo.getApplicationStatus(link.applicationId);
        if (!current2) continue;
        const plan2 = planTransition(current2 as AppStatus, cls.eventClass);
        if (plan2.action === "promote") {
          await repo.recordApplicationEvent({
            applicationId: link.applicationId,
            eventClass: cls.eventClass,
            emailEventId: undefined,
            fromStatus: current2,
            toStatus: plan2.to,
            occurredAt: receivedAt,
            now,
          });
          outcome.promoted.push({
            applicationId: link.applicationId,
            eventClass: cls.eventClass,
            from: current2,
            to: plan2.to,
          });
          if (cls.eventClass === "assessment_invite") {
            const dl = extractDeadline(parts.subject, parts.snippet, now);
            await repo.setApplicationDeadline(link.applicationId, dl.deadlineAt, dl.source);
          }
          if (cls.eventClass === "interview_invite") {
            const ics = await repo.getIcsAttachment(id, accessToken);
            if (ics) {
              const ev = parseIcsEvent(ics);
              if (ev.start) {
                await repo.setInterviewSchedule(link.applicationId, ev.start, ev.location);
              }
            }
          }
        }
        continue;
      }

      // Tier-1 hit (sender domain matches an existing application).
      const current = await repo.getApplicationStatus(domainHit.id);
      if (!current) continue;
      const plan = planTransition(current as AppStatus, cls.eventClass);
      if (plan.action === "promote") {
        await repo.recordApplicationEvent({
          applicationId: domainHit.id,
          eventClass: cls.eventClass,
          emailEventId: undefined,
          fromStatus: current,
          toStatus: plan.to,
          occurredAt: receivedAt,
          now,
        });
        outcome.promoted.push({
          applicationId: domainHit.id,
          eventClass: cls.eventClass,
          from: current,
          to: plan.to,
        });
        if (cls.eventClass === "assessment_invite") {
          const dl = extractDeadline(parts.subject, parts.snippet, now);
          await repo.setApplicationDeadline(domainHit.id, dl.deadlineAt, dl.source);
        }
        if (cls.eventClass === "interview_invite") {
          const ics = await repo.getIcsAttachment(id, accessToken);
          if (ics) {
            const ev = parseIcsEvent(ics);
            if (ev.start) {
              await repo.setInterviewSchedule(domainHit.id, ev.start, ev.location);
            }
          }
        }
      }
    }

    if (listed.historyId) await repo.saveGmailHistoryId(String(listed.historyId));
    outcome.ok = true;
    if (notify && (outcome.promoted.length > 0 || outcome.createdApplications > 0)) {
      await notifyPromotions(outcome.promoted, outcome.createdApplications, repo, notify);
    }
    return outcome;
  } catch (err: any) {
    outcome.errorCode = err instanceof GmailError ? err.code : "poll_failed";
    log.warn(`gmail poll failed: ${err instanceof Error ? err.message : err}`);
    return outcome;
  }
}
