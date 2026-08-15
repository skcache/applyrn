import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Repository } from "../src/repo.js";
import type { CompanyConfig } from "@applyrn/domain";

/**
 * Scheduler tests: interval due-checks, bounded concurrency, per-shard
 * metrics. Outbound HTTP is stubbed at globalThis.fetch; all companies are
 * synthetic fixtures.
 */

const AUTH_HEADER = { authorization: "Bearer test-dashboard-token-000" };

const company: CompanyConfig = {
  id: "example-ai",
  name: "Example AI",
  provider: "greenhouse",
  boardKey: "exampleai",
  enabled: true,
  pollIntervalSeconds: 120,
  createdAt: "2026-08-14T00:00:00Z",
};

const jobs = [
  {
    id: 70001,
    title: "Software Engineering Intern",
    location: { name: "San Francisco, CA" },
    absolute_url: "https://boards.greenhouse.io/exampleai/jobs/70001",
    updated_at: "2026-08-14T17:00:00Z",
  },
];

const repo = () => new D1Repository(env.DB);

const pollAll = () =>
  exports.default
    .fetch("https://applyrn-worker.test/api/poll", { method: "POST", headers: AUTH_HEADER })
    .then(
      (r) =>
        r.json() as Promise<{
          summary: {
            outcomes: { companyId: string; ok: boolean }[];
            skippedInterval: number;
            skippedBackoff: number;
          };
        }>,
    );

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub Greenhouse list + detail for the example board. */
function stubBoard() {
  vi.stubGlobal("fetch", async (url: string | URL | Request): Promise<Response> => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (target === "https://boards-api.greenhouse.io/v1/boards/exampleai/jobs") {
      return jsonReply({ jobs });
    }
    if (target.startsWith("https://boards-api.greenhouse.io/v1/boards/exampleai/jobs/")) {
      return jsonReply({
        id: 70001,
        title: jobs[0]!.title,
        location: jobs[0]!.location,
        absolute_url: jobs[0]!.absolute_url,
        updated_at: jobs[0]!.updated_at,
        first_published: jobs[0]!.updated_at,
      });
    }
    throw new Error(`No stub for ${target}`);
  });
}

beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM notifications; DELETE FROM jobs; DELETE FROM applications; DELETE FROM source_state; DELETE FROM poll_metrics; DELETE FROM companies;",
  );
  await repo().upsertCompany(company);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scheduler due-checks", () => {
  it("polls a never-polled company and records success", async () => {
    stubBoard();
    const summary = await pollAll();
    expect(summary.summary.outcomes).toHaveLength(1);
    expect(summary.summary.outcomes[0]!.ok).toBe(true);
    const state = await repo().getSourceState("example-ai");
    expect(state?.lastSuccessAt).toBeTruthy();
  });

  it("skips companies still inside their poll interval", async () => {
    stubBoard();
    await pollAll(); // first poll at t0

    // Force last poll to 60s ago: interval is 120s, so not due yet.
    // Timestamp is test-controlled; inline is fine here (no user input).
    const ts = new Date(Date.now() - 60_000).toISOString();
    await env.DB.exec(
      `UPDATE source_state SET last_success_at = '${ts}' WHERE company_id = 'example-ai'`,
    );
    const summary = await pollAll();
    expect(summary.summary.skippedInterval).toBe(1);
    expect(summary.summary.outcomes).toHaveLength(0); // nothing polled
  });

  it("polls again once the interval has elapsed", async () => {
    stubBoard();
    await pollAll();

    // Force last poll to 121s ago: interval elapsed, due again.
    const ts = new Date(Date.now() - 121_000).toISOString();
    await env.DB.exec(
      `UPDATE source_state SET last_success_at = '${ts}' WHERE company_id = 'example-ai'`,
    );
    const summary = await pollAll();
    expect(summary.summary.skippedInterval).toBe(0);
    expect(summary.summary.outcomes).toHaveLength(1);
    expect(summary.summary.outcomes[0]!.ok).toBe(true);
  });

  it("skips companies in backoff", async () => {
    await repo().recordSourceFailure(
      "example-ai",
      new Date().toISOString(),
      "rate_limited",
      429,
      new Date(Date.now() + 60_000).toISOString(),
    );
    stubBoard();
    const summary = await pollAll();
    expect(summary.summary.skippedBackoff).toBe(1);
    expect(summary.summary.outcomes).toHaveLength(0);
  });
});

describe("bounded concurrency", () => {
  it("never exceeds the concurrency limit across companies", async () => {
    // Seed 5 more companies (base example-ai + 5 = 6) sharing one stub.
    for (let i = 0; i < 5; i++) {
      await repo().upsertCompany({
        ...company,
        id: `example-ai-${i}`,
        boardKey: "exampleai",
      });
    }

    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal("fetch", async (url: string | URL | Request): Promise<Response> => {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (!target.startsWith("https://boards-api.greenhouse.io/v1/boards/exampleai/jobs")) {
        throw new Error(`No stub for ${target}`);
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Simulate a real network round-trip so concurrency is observable.
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return jsonReply({ jobs });
    });

    const summary = await pollAll();
    expect(summary.summary.outcomes).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // actually parallel, not serial
  });
});

describe("shard metrics", () => {
  it("records poll metrics with the provider as shard key", async () => {
    stubBoard();
    await pollAll();
    const { results } = await env.DB.prepare("SELECT * FROM poll_metrics").all();
    expect(results).toHaveLength(1);
    const row = results[0] as Record<string, unknown>;
    expect(row.provider).toBe("greenhouse");
    expect(row.shard).toBe("greenhouse");
    expect(row.companies_polled).toBe(1);
    expect(row.successful).toBe(1);
    expect(row.failed).toBe(0);
  });
});
