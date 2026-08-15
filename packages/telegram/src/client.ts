import type { TelegramMessagePayload } from "./render.js";

/** Fetch-like for testability. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SendResult = { ok: boolean; errorCode?: string; latencyMs: number };

export class TelegramError extends Error {
  readonly errorCode: string;
  constructor(errorCode: string, message: string) {
    super(message);
    this.name = "TelegramError";
    this.errorCode = errorCode;
  }
}

/**
 * Minimal Telegram Bot API client. V0 sends one message kind (job alert)
 * with URL buttons. Token is passed per call and never logged.
 */
export class TelegramClient {
  private readonly botToken: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(botToken: string, opts?: { fetchImpl?: FetchLike; timeoutMs?: number }) {
    if (!botToken) throw new TelegramError("misconfigured", "Telegram bot token is empty");
    this.botToken = botToken;
    this.fetchImpl = opts?.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts?.timeoutMs ?? 10_000;
  }

  async sendMessage(chatId: string, payload: TelegramMessagePayload): Promise<SendResult> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const started = Date.now();
    let res: Response;
    try {
      const signal = AbortSignal.timeout(this.timeoutMs);
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      // Never include the underlying error string: fetch errors can embed the
      // request URL, which contains the bot token.
      const code = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
      throw new TelegramError(code, `Telegram send failed (${code})`);
    }
    const latencyMs = Date.now() - started;
    let body: { ok?: boolean; description?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = {};
    }
    if (!res.ok || body.ok === false) {
      const code = `http_${res.status}`;
      throw new TelegramError(code, `Telegram send rejected (${code})`);
    }
    return { ok: true, latencyMs };
  }
}

export { buildSendMessagePayload, renderAlertText, alertButtons } from "./render.js";
export type {
  InlineButton,
  TelegramMessagePayload,
  MatchInfo,
  RenderAlertInput,
} from "./render.js";
