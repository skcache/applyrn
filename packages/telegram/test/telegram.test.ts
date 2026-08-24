import { describe, expect, it, vi } from "vitest";
import type { CompanyConfig, NormalizedJob } from "@applyrn/domain";
import {
  TelegramClient,
  TelegramError,
  alertButtons,
  buildSendMessagePayload,
  formatAge,
  formatClock,
  renderAlertText,
} from "../src/index.js";

const company: CompanyConfig = {
  id: "example-ai",
  name: "Example AI",
  provider: "greenhouse",
  boardKey: "exampleai",
  enabled: true,
  pollIntervalSeconds: 120,
  createdAt: "2026-08-14T00:00:00Z",
};

const job: NormalizedJob = {
  provider: "greenhouse",
  companyId: "example-ai",
  externalJobId: "70001",
  title: "Software Engineering Intern",
  location: "San Francisco, CA",
  compensationText: "$45-60/hr",
  jobUrl: "https://boards.greenhouse.io/exampleai/jobs/70001",
  applyUrl: "https://boards.greenhouse.io/exampleai/jobs/70001",
  publicationTimeKind: "authoritative",
  sourcePublishedAt: "2026-08-14T17:14:03Z",
};

describe("renderAlertText", () => {
  it("renders the PRD alert shape with authoritative timing", () => {
    const text = renderAlertText({ job, company, detectedAt: "2026-08-14T17:14:31Z" });
    expect(text).toContain("🚨 NEW JOB");
    expect(text).toContain("Software Engineering Intern");
    expect(text).toContain("Example AI");
    expect(text).toContain("📍 San Francisco, CA");
    expect(text).toContain("💰 $45-60/hr");
    expect(text).toContain("🏢 Greenhouse");
    expect(text).toContain("Published:");
    expect(text).toContain("Detected:");
    expect(text).toContain("Age:");
    expect(text).toMatch(/Published: .*\d{4}.*PT/);
    expect(text).toMatch(/Detected: {2}.*\d{4}.*PT/);
    expect(text).not.toContain("First seen");
  });

  it("shows First seen instead of Published when not authoritative", () => {
    const observed = {
      ...job,
      publicationTimeKind: "observed" as const,
      sourcePublishedAt: undefined,
    };
    const text = renderAlertText({ job: observed, company, detectedAt: "2026-08-14T17:14:31Z" });
    expect(text).toContain("First seen:");
    expect(text).not.toContain("Published:");
    // 2026-08-23 user request: every timestamp carries its date (PT)
    expect(text).toMatch(/First seen: .*\d{4}.*PT/);
    expect(text).not.toContain("Age:");
  });

  it("renders match block when provided", () => {
    const text = renderAlertText({
      job,
      company,
      detectedAt: "2026-08-14T17:14:31Z",
      match: { score: 82, reasons: ["Internship", "Python", "Backend"] },
    });
    expect(text).toContain("🚨 NEW — 82 MATCH");
    expect(text).toContain("Matched:");
    expect(text).toContain("✓ Internship");
    expect(text).toContain("✓ Python");
  });

  it("renders REOPENED for reopened alerts", () => {
    const text = renderAlertText({
      job,
      company,
      detectedAt: "2026-08-14T17:14:31Z",
      match: { score: 70, reasons: ["Internship"] },
      kind: "reopened",
    });
    expect(text).toContain("🚨 REOPENED — 70 MATCH");
    expect(text).not.toContain("🚨 NEW");
  });

  it("truncates oversized text to the Telegram limit with a marker", () => {
    const payload = buildSendMessagePayload("chat-1", "x".repeat(5000), []);
    expect(payload.text.length).toBeLessThanOrEqual(4096);
    expect(payload.text.endsWith("…(truncated)")).toBe(true);
    // The meaningful head is preserved.
    expect(payload.text.startsWith("x".repeat(100))).toBe(true);
  });

  it("leaves text within the limit untouched", () => {
    const short = "Short alert";
    const payload = buildSendMessagePayload("chat-1", short, []);
    expect(payload.text).toBe(short);
  });

  it("never fabricates age for unknown timestamps", () => {
    expect(formatAge("not-a-date", "2026-08-14T17:14:31Z")).toBe("unknown");
  });
});

describe("formatClock / formatAge", () => {
  it("renders Pacific time WITH date (2026-08-23 user request)", () => {
    const out = formatClock("2026-08-14T17:14:03Z");
    // 17:14 UTC on Aug 14 = 10:14 AM PT, same calendar day
    expect(out).toContain("Aug 14, 2026");
    expect(out).toContain("10:14:03 AM");
    expect(out.endsWith("PT")).toBe(true);
  });

  it("rolls the PT date correctly across the UTC midnight boundary", () => {
    // 2026-08-15T06:30:00Z = Aug 14, 11:30 PM PT — date must be Aug 14
    const out = formatClock("2026-08-15T06:30:00Z");
    expect(out).toContain("Aug 14, 2026");
    expect(out).toContain("11:30:00 PM");
  });

  it("handles unparseable input without throwing", () => {
    expect(formatClock("garbage")).toContain("(unparseable)");
  });

  it("formats local clock (legacy shape)", () => {
    const out = formatClock("2026-08-14T17:14:03Z");
    expect(out).toMatch(/\d{1,2}:\d{2}:\d{2} (AM|PM)/);
  });

  it("formats ages in seconds and minutes", () => {
    expect(formatAge("2026-08-14T17:14:03Z", "2026-08-14T17:14:31Z")).toBe("28s");
    expect(formatAge("2026-08-14T17:00:00Z", "2026-08-14T17:05:00Z")).toBe("5m 0s");
  });
});

describe("alertButtons / buildSendMessagePayload", () => {
  it("builds APPLY NOW + DETAILS inline keyboard", () => {
    const buttons = alertButtons(job);
    expect(buttons).toEqual([
      { text: "APPLY NOW", url: "https://boards.greenhouse.io/exampleai/jobs/70001" },
      { text: "DETAILS", url: "https://boards.greenhouse.io/exampleai/jobs/70001" },
    ]);
    const payload = buildSendMessagePayload("12345", "text", buttons);
    expect(payload.chat_id).toBe("12345");
    expect(payload.reply_markup?.inline_keyboard).toEqual([[buttons[0]], [buttons[1]]]);
    expect(payload.disable_web_page_preview).toBe(true);
  });

  it("omits reply_markup when no buttons", () => {
    const payload = buildSendMessagePayload("12345", "text", []);
    expect(payload.reply_markup).toBeUndefined();
  });

  it("drops non-http(s) URLs from buttons", () => {
    const malicious = {
      ...job,
      applyUrl: "javascript:alert(1)",
      jobUrl: "data:text/html,<script>alert(1)</script>",
    };
    expect(alertButtons(malicious)).toEqual([]);
  });

  it("keeps only http(s) buttons when mixed", () => {
    const mixed = {
      ...job,
      applyUrl: "https://boards.greenhouse.io/exampleai/jobs/70001",
      jobUrl: "ftp://example.com/job",
    };
    const buttons = alertButtons(mixed);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.text).toBe("APPLY NOW");
  });
});

describe("TelegramClient", () => {
  it("sends a message and reports latency", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.chat_id).toBe("12345");
      expect(body.reply_markup.inline_keyboard).toHaveLength(2);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new TelegramClient("token-abc", { fetchImpl });
    const result = await client.sendMessage(
      "12345",
      buildSendMessagePayload("12345", "hi", alertButtons(job)),
    );
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toBe("https://api.telegram.org/bottoken-abc/sendMessage");
  });

  it("throws TelegramError with http code on rejection", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 }),
    );
    const client = new TelegramClient("token-abc", { fetchImpl });
    await expect(
      client.sendMessage("12345", buildSendMessagePayload("12345", "hi", [])),
    ).rejects.toMatchObject({
      name: "TelegramError",
      errorCode: "http_400",
    });
  });

  it("throws TelegramError on network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const client = new TelegramClient("token-abc", { fetchImpl });
    await expect(
      client.sendMessage("12345", buildSendMessagePayload("12345", "hi", [])),
    ).rejects.toBeInstanceOf(TelegramError);
  });

  it("rejects an empty token at construction", () => {
    expect(() => new TelegramClient("")).toThrow(/empty/);
  });
});
