import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Repository } from "../src/repo.js";
import type { CompanyConfig } from "@applyrn/domain";

/**
 * /api/tick — the third independent trigger (Phase 2).
 *
 * A free external pinger (cron-job.org / UptimeRobot) POSTs here every ~5
 * minutes. Contract under test:
 *  - auth is fail-closed (same bearer token as every other endpoint)
 *  - the tick stands down while the last cycle is fresh (< 180s)
 *  - a stale tick sweeps EVERY shard in one call (a pinger cannot fan out)
 *  - cycles driven by the tick are attributed trigger='external-ping'
 */
const AUTH_HEADER = { authorization: "Bearer test-dashboard-token-000" };
const repo = () => new D1Repository(env.DB);

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;
type FetchRoute = {
  match: (url: string) => boolean;
  handle: (url: string, init: RequestInit) => Promise<Response>;
};
const fetchRoutes: FetchRoute[] = [];

function installFetchStub(routes: FetchRoute[]) {
  fetchRoutes.push(...routes);
  vi.stubGlobal(
    "fetch",
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const route = [...fetchRoutes].reverse().find((r) => r.match(target));
      if (!route) throw new Error(`No fetch stub for ${target}`);
      return route.handle(target, init ?? {});
    },
  );
}

const jsonReply = (body: Json, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubBoard(payload: { jobs: Record<string, unknown>[] }) {
  installFetchStub([
    {
      match: (url) => url === "https://boards-api.greenhouse.io/v1/boards/exampleai/jobs",
      handle: () => Promise.resolve(jsonReply(payload)),
    },
  ]);
}

function stubTelegram() {
  installFetchStub([
    {
      match: (url) => url.startsWith("https://api.telegram.org") && url.endsWith("/sendMessage"),
      handle: () => Promise.resolve(jsonReply({ ok: true })),
    },
  ]);
}

const company: CompanyConfig = {
  id: "example-ai",
  name: "Example AI",
  provider: "greenhouse",
  boardKey: "exampleai",
  careersUrl: "https://jobs.example.com",
  enabled: true,
  pollIntervalSeconds: 120,
  tags: [],
  createdAt: "2026-08-14T00:00:00Z",
};

const jobs = [
  {
    id: 71001,
    title: "Software Engineer Intern",
    location: { name: "San Francisco, CA" },
    absolute_url: "https://boards.greenhouse.io/exampleai/jobs/71001",
    updated_at: "2026-08-14T17:00:00Z",
  },
];

async function postTick(auth = true): Promise<Response> {
  return exports.default.fetch("https://applyrn-worker.test/api/tick", {
    method: "POST",
    headers: auth ? AUTH_HEADER : {},
  });
}

beforeEach(async () => {
  fetchRoutes.length = 0;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_CHAT_ID", "-1000");
  vi.stubEnv("DASHBOARD_TOKEN", "test-dashboard-token-000");
  await env.DB.exec(
    "DELETE FROM notifications; DELETE FROM jobs; DELETE FROM applications; DELETE FROM source_state; DELETE FROM poll_metrics; DELETE FROM companies;",
  );
  await repo().upsertCompany(company);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/tick (third trigger)", () => {
  it("refuses without the bearer token (fail-closed)", async () => {
    const res = await postTick(false);
    expect(res.status).toBe(401);
  });

  it("stands down while the primary cron is healthy (fresh heartbeat)", async () => {
    // A recent completed cycle exists -> tick must NOT drive another.
    await env.DB.prepare(
      "INSERT INTO poll_metrics (provider, shard, started_at, finished_at, companies_polled, successful, failed, new_jobs, duration_ms) VALUES ('greenhouse','shard','2026-08-15T12:00:00Z',?,1,1,0,0,100)",
    )
      .bind(new Date(Date.now() - 10_000).toISOString()) // 10s old, < 180s
      .run();

    stubBoard({ jobs });
    stubTelegram();
    const res = await postTick();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticked: boolean; reason?: string };
    expect(body.ticked).toBe(false);
    expect(body.reason).toBe("fresh");
  });

  it("when stale, sweeps every shard in one call and attributes external-ping", async () => {
    stubBoard({ jobs }); // board returns the job; first poll baselines it
    stubTelegram();

    // No poll_metrics rows at all -> no lastPollAt -> fully stale.
    const res = await postTick();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticked: boolean; shards?: number };
    expect(body.ticked).toBe(true);

    // The sweep must have covered every shard of the watchlist. With one
    // company there is exactly one shard; assert the company got polled by
    // checking its job was persisted and the metric row carries the tag.
    const jobRows = await env.DB.prepare("SELECT status FROM jobs").all();
    expect(jobRows.results.length).toBe(1);

    const metrics = await env.DB.prepare(
      "SELECT DISTINCT trigger FROM poll_metrics WHERE trigger IS NOT NULL",
    ).all();
    expect(metrics.results.map((r) => String(r.trigger))).toContain("external-ping");
  });

  it("tick-driven cycle actually detects and alerts a new job", async () => {
    // Baseline first (via a normal cycle), so a later added job alerts.
    stubBoard({ jobs: [] });
    stubTelegram();
    await exports.default.fetch("https://applyrn-worker.test/api/poll/company", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ companyId: company.id }),
    });

    // Board gains a job, then time passes beyond the tick window.
    stubBoard({ jobs });
    await env.DB.prepare("UPDATE source_state SET last_success_at = ? WHERE company_id = ?")
      .bind(new Date(Date.now() - 300_000).toISOString(), company.id)
      .run();
    // Fresh-looking heartbeat from the primary cron would stand the tick
    // down, so clear metrics to simulate the cron being dead.
    await env.DB.exec("DELETE FROM poll_metrics");

    const res = await postTick();
    const body = (await res.json()) as { ticked: boolean };
    expect(body.ticked).toBe(true);

    const notifs = await env.DB.prepare(
      "SELECT delivered FROM notifications n JOIN jobs j ON j.id = n.job_id WHERE j.external_job_id = '71001'",
    ).all();
    expect(notifs.results.length).toBe(1);
    expect(Number(notifs.results[0]!.delivered)).toBe(1);
  });
});
