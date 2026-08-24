import type { CompanyConfig, NormalizedJob } from "@applyrn/domain";

/** Optional deterministic relevance output (Issue 8). Rendered when present. */
export type MatchInfo = { score: number; reasons: string[] };

export type RenderAlertInput = {
  job: NormalizedJob;
  company: CompanyConfig;
  detectedAt: string;
  /** When this job was FIRST seen (JobRecord.firstSeenAt) — may predate
   * detectedAt on re-alerts/reopens. Rendered when different. */
  firstSeenAt?: string;
  match?: MatchInfo;
  /** Alert flavor: reopened jobs render REOPENED, everything else NEW. */
  kind?: "new" | "reopened";
};

/**
 * Render the Telegram alert message. Follows PRD section 6 format.
 * Never fabricates publication age: authoritative kind shows Published,
 * observed kind shows First seen.
 */
export function renderAlertText(input: RenderAlertInput): string {
  const { job, company, detectedAt, match, kind } = input;
  const lines: string[] = [];

  const tag = kind === "reopened" ? "REOPENED" : "NEW";
  const header = match ? `\u{1F6A8} ${tag} \u2014 ${match.score} MATCH` : `\u{1F6A8} ${tag} JOB`;
  lines.push(header, "");

  lines.push(job.title);
  lines.push(company.name);
  lines.push("");

  if (job.location) lines.push(`\u{1F4CD} ${job.location}`);
  if (job.compensationText) lines.push(`\u{1F4B0} ${job.compensationText}`);
  lines.push(`\u{1F3E2} ${providerLabel(job.provider)}`);
  lines.push("");

  // 2026-08-23 user request: Pacific times WITH date, and always render
  // published (when known) + detected + age — never a bare "First seen" line.
  const detected = formatClock(detectedAt);
  if (job.publicationTimeKind === "authoritative" && job.sourcePublishedAt) {
    lines.push(`Published: ${formatClock(job.sourcePublishedAt)}`);
    lines.push(`Detected:  ${detected}`);
    lines.push(`Age:       ${formatAge(job.sourcePublishedAt, detectedAt)}`);
  } else {
    const firstSeen = input.firstSeenAt ?? detectedAt;
    lines.push(`First seen: ${formatClock(firstSeen)}`);
    if (firstSeen !== detectedAt) {
      // Re-alerts/reopens: show when THIS detection happened too.
      lines.push(`Detected:  ${detected}`);
      lines.push(`Age:       ${formatAge(firstSeen, detectedAt)} since first seen`);
    }
  }

  if (match && match.reasons.length > 0) {
    lines.push("");
    lines.push("Matched:");
    for (const reason of match.reasons) lines.push(`\u2713 ${reason}`);
  }

  return lines.join("\n");
}

export type InlineButton = { text: string; url: string };

/** Only http(s) URLs may become Telegram inline buttons (provider-controlled). */
export function isSafeButtonUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * V0 buttons: APPLY NOW + DETAILS, both URL buttons (PRD 6.1).
 * State buttons (MARK APPLIED / SAVE / IGNORE) need callback handling and
 * are deferred; they must not delay initial detection delivery.
 * URLs come from provider payloads, so only http(s) URLs are accepted.
 */
export function alertButtons(job: NormalizedJob): InlineButton[] {
  const buttons: InlineButton[] = [];
  if (job.applyUrl && isSafeButtonUrl(job.applyUrl))
    buttons.push({ text: "APPLY NOW", url: job.applyUrl });
  if (job.jobUrl && isSafeButtonUrl(job.jobUrl)) buttons.push({ text: "DETAILS", url: job.jobUrl });
  return buttons;
}

export type TelegramMessagePayload = {
  chat_id: string;
  text: string;
  reply_markup?: { inline_keyboard: InlineButton[][] };
  disable_web_page_preview?: boolean;
};

/** Telegram hard limit on message text length (chars). */
export const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * Cap text at the Telegram limit (audit F7). A longer message (e.g. a huge
 * board-supplied title) makes sendMessage fail permanently; the alert would
 * retry forever and never deliver. Truncate with a marker at the single
 * payload choke point so both fresh alerts and retries are covered.
 */
export function truncateTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const marker = "\n\n…(truncated)";
  return text.slice(0, limit - marker.length) + marker;
}

export function buildSendMessagePayload(
  chatId: string,
  text: string,
  buttons: InlineButton[],
): TelegramMessagePayload {
  const payload: TelegramMessagePayload = {
    chat_id: chatId,
    text: truncateTelegramText(text),
    disable_web_page_preview: true,
  };
  if (buttons.length > 0) {
    payload.reply_markup = { inline_keyboard: buttons.map((b) => [b]) };
  }
  return payload;
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "greenhouse":
      return "Greenhouse";
    case "ashby":
      return "Ashby";
    case "lever":
      return "Lever";
    case "smartrecruiters":
      return "SmartRecruiters";
    case "workday":
      return "Workday";
    case "oracle":
      return "Taleo";
    default:
      return provider;
  }
}

/**
 * Pacific-time rendering WITH date, e.g. "Sat, Aug 23, 2025 · 5:14:03 PM PT".
 * Workers run UTC internally; Intl.DateTimeFormat pins the zone explicitly so
 * alert times are verifiable against America/Los_Angeles wall-clock regardless
 * of where the isolate runs. (User request 2026-08-23: include the date.)
 */
const PT_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

/** Compact PT stamp used inline in alerts: "Aug 23, 2025 · 5:14:03 PM PT". */
export function formatPacific(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `${iso} (unparseable)`;
  return PT_FORMATTER.format(d).replace(",", "").replace(" at ", ", ") + " PT";
}

/** Legacy alias kept for tests/imports — now renders Pacific with date. */
export function formatClock(iso: string): string {
  return formatPacific(iso);
}

export function formatAge(fromIso: string, toIso: string): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
