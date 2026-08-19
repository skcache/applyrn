import type { CompanyConfig, NormalizedJob } from "@applyrn/domain";

/** Optional deterministic relevance output (Issue 8). Rendered when present. */
export type MatchInfo = { score: number; reasons: string[] };

export type RenderAlertInput = {
  job: NormalizedJob;
  company: CompanyConfig;
  detectedAt: string;
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

  const detected = formatClock(detectedAt);
  if (job.publicationTimeKind === "authoritative" && job.sourcePublishedAt) {
    lines.push(`Published: ${formatClock(job.sourcePublishedAt)}`);
    lines.push(`Detected:  ${detected}`);
    lines.push(`Age:       ${formatAge(job.sourcePublishedAt, detectedAt)}`);
  } else {
    lines.push(`First seen: ${detected}`);
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

/** Local-time clock rendering, e.g. "5:14:03 PM". Times are UTC internally. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m}:${s} ${ampm}`;
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
