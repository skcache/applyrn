import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Repository } from "../src/repo.js";
import type { CompanyConfig } from "@applyrn/domain";

/**
 * End-to-end poll cycle tests against a real local D1 (vitest pool worker).
 * The real migrations are applied by test/apply-migrations.ts (setup file).
 * Outbound HTTP is stubbed at globalThis.fetch: no network, no real data.
 * All companies are synthetic fixtures (Example AI).
 */

const TELEGRAM = "https://api.telegram.org";

const company: CompanyConfig = {
  id: "example-ai",
  name: "Example AI",
  careersUrl: "https://boards.greenhouse.io/exampleai",
  provider: "greenhouse",
  boardKey: "exampleai",
  enabled: true,
  pollIntervalSeconds: 120,
  tags: ["fixture"],
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
  {
    id: 70002,
    title: "Applied AI Intern",
    location: { name: "Remote" },
    absolute_url: "https://boards.greenhouse.io/exampleai/jobs/70002",
    updated_at: "2026-08-14T16:40:00Z",
  },
  {
    id: 70003,
    title: "Systems Software Intern",
    location: { name: "Austin, TX" },
    absolute_url: "https://boards.greenhouse.io/exampleai/jobs/70003",
    updated_at: "2026-08-13T09:12:00Z",
  },
];

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

type FetchRoute = {
  match: (url: string) => boolean;
  handle: (url: string, init: RequestInit) => Promise<Response>;
};

/** Shared route registry; installFetchStub adds routes without replacing. */
const fetchRoutes: FetchRoute[] = [];

function installFetchStub(routes: FetchRoute[]) {
  fetchRoutes.push(...routes);
  vi.stubGlobal(
    "fetch",
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      // Last installed route wins (tests re-stub a board mid-test).
      const route = [...fetchRoutes].reverse().find((r) => r.match(target));
      if (!route) throw new Error(`No fetch stub for ${target}`);
      return route.handle(target, init ?? {});
    },
  );
}

const jsonReply = (body: Json, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Board list stub; can be re-installed per test with a custom payload. */
function stubBoard(payload: Json, status = 200, boardKey = "exampleai") {
  const board = `https://boards-api.greenhouse.io/v1/boards/${boardKey}/jobs`;
  const list = payload as {
    jobs?: {
      id: number;
      title: string;
      location: { name: string };
      absolute_url: string;
      updated_at: string;
    }[];
  };
  const detailFor = (id: number) => {
    const j = list.jobs?.find((x) => x.id === id);
    if (!j) return null;
    return {
      id: j.id,
      title: j.title,
      location: j.location,
      absolute_url: j.absolute_url,
      updated_at: j.updated_at,
      first_published: j.updated_at,
    };
  };
  installFetchStub([
    {
      match: (url) => url === `${board}`,
      handle: () => Promise.resolve(jsonReply(payload, status)),
    },
    {
      match: (url) => url.startsWith(`${board}/`),
      handle: (url) => {
        const id = Number(url.split("/").pop());
        const detail = detailFor(id);
        return Promise.resolve(detail ? jsonReply(detail) : jsonReply({}, 404));
      },
    },
  ]);
}

function stubTelegram(opts?: {
  ok?: boolean;
  status?: number;
  capture?: { text: string; chatId: string; buttons: unknown[] }[];
}) {
  const capture = opts?.capture;
  installFetchStub([
    {
      match: (url) => url.startsWith(`${TELEGRAM}/bot`) && url.endsWith("/sendMessage"),
      handle: (_url, init) => {
        const body = JSON.parse(String(init.body)) as {
          chat_id: string;
          text: string;
          reply_markup?: { inline_keyboard: unknown[][] };
        };
        capture?.push({
          chatId: body.chat_id,
          text: body.text,
          buttons: body.reply_markup?.inline_keyboard ?? [],
        });
        const ok = opts?.ok ?? true;
        const status = opts?.status ?? 200;
        return Promise.resolve(
          ok
            ? jsonReply({ ok: true }, status)
            : jsonReply({ ok: false, description: "boom" }, status),
        );
      },
    },
  ]);
}

const repo = () => new D1Repository(env.DB);

/** Test binding value; must match apps/worker/vitest.config.ts. */
const AUTH_HEADER = { authorization: "Bearer test-dashboard-token-000" };

const pollCompany = (id: string) =>
  exports.default
    .fetch("https://applyrn-worker.test/api/poll/company", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ companyId: id }),
    })
    .then((r) => r.json() as Promise<{ outcome: PollOutcome }>);

const pollAll = () =>
  exports.default
    .fetch("https://applyrn-worker.test/api/poll", { method: "POST", headers: AUTH_HEADER })
    .then((r) => r.json() as Promise<{ summary: { outcomes: PollOutcome[] } }>);

type PollOutcome = {
  companyId: string;
  ok: boolean;
  errorCode?: string;
  httpStatus?: number;
  newJobs: number;
  alertsSent: number;
};

async function countRows(table: string): Promise<number> {
  const res = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
  return Number(res?.n ?? 0);
}

/** Age the source state so the poll-interval gate allows another poll. */
async function backdateSource(id = "example-ai", ms = 200_000): Promise<void> {
  await env.DB.prepare(
    "UPDATE source_state SET last_success_at = ?, last_failure_at = NULL WHERE company_id = ?",
  )
    .bind(new Date(Date.now() - ms).toISOString(), id)
    .run();
}

async function rows(table: string, where: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${where}`).all();
  return results;
}

beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM notifications; DELETE FROM jobs; DELETE FROM applications; DELETE FROM source_state; DELETE FROM poll_metrics; DELETE FROM companies;",
  );
  await repo().upsertCompany(company);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchRoutes.length = 0;
});

describe("first-run baseline", () => {
  it("persists every job as baseline and sends zero alerts", async () => {
    stubBoard({ jobs });
    stubTelegram();
    const { outcome } = await pollCompany("example-ai");
    expect(outcome.ok).toBe(true);
    expect(outcome.newJobs).toBe(0);
    expect(outcome.alertsSent).toBe(0);
    expect(await countRows("jobs")).toBe(3);
    const statuses = await rows("jobs", "company_id = 'example-ai'");
    expect(statuses.every((r) => r.status === "baseline")).toBe(true);
    expect(await countRows("notifications")).toBe(0);
    const state = await repo().getSourceState("example-ai");
    expect(state?.lastSuccessAt).toBeTruthy();
    expect(state?.failureStreak).toBe(0);
  });
});

describe("new job detection", () => {
  it("one unseen job produces exactly one notification", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline run

    // Board gains one job.
    const extra = {
      id: 70004,
      title: "ML Inference Intern",
      location: { name: "Remote" },
      absolute_url: "https://boards.greenhouse.io/exampleai/jobs/70004",
      updated_at: "2026-08-14T18:00:00Z",
    };
    stubBoard({ jobs: [...jobs, extra] });
    await backdateSource();
    const telegramCalls: { text: string; chatId: string; buttons: unknown[] }[] = [];
    stubTelegram({ capture: telegramCalls });

    const { outcome } = await pollCompany("example-ai");
    expect(outcome.ok).toBe(true);
    expect(outcome.newJobs).toBe(1);
    expect(outcome.alertsSent).toBe(1);
    expect(await countRows("notifications")).toBe(1);
    expect(await countRows("jobs")).toBe(4);

    const notifs = await rows("notifications", "1=1");
    expect(notifs[0]!.delivered).toBe(1);
    const sent = telegramCalls[0]!;
    expect(sent.text).toContain("ML Inference Intern");
    expect(sent.text).toContain("Example AI");
    expect(sent.buttons.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(sent.buttons)).toContain("APPLY NOW");
    expect(JSON.stringify(sent.buttons)).toContain(
      "https://boards.greenhouse.io/exampleai/jobs/70004",
    );
  });

  it("enriches a new job with the authoritative publishedAt from its detail endpoint", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline run

    const extra = {
      id: 70005,
      title: "Platform Engineer",
      location: { name: "New York" },
      absolute_url: "https://boards.greenhouse.io/exampleai/jobs/70005",
      updated_at: "2026-08-15T09:00:00Z",
    };
    stubBoard({ jobs: [...jobs, extra] });
    await backdateSource();
    stubTelegram();

    const { outcome } = await pollCompany("example-ai");
    expect(outcome.newJobs).toBe(1);

    const jobRows = await rows("jobs", "1=1");
    const enriched = jobRows.find((r) => String(r.external_job_id) === "70005");
    expect(enriched).toBeDefined();
    // Detail endpoint returns first_published = updated_at; the persisted
    // job must carry the authoritative timestamp for lifetime measurement.
    expect(enriched!.publication_time_kind).toBe("authoritative");
    expect(enriched!.source_published_at).toBe("2026-08-15T09:00:00Z");
  });

  it("does not fetch per-job details during the baseline run (cycle stays at cadence)", async () => {
    // Baseline covers the whole board; detail fetches would be one HTTP
    // request per job. The first successful poll must only hit the board
    // list endpoint (perf contract that keeps large boards at cadence).
    let boardHits = 0;
    let detailHits = 0;
    installFetchStub([
      {
        match: (url) => url === "https://boards-api.greenhouse.io/v1/boards/exampleai/jobs",
        handle: () => {
          boardHits++;
          return Promise.resolve(jsonReply({ jobs }, 200));
        },
      },
      {
        match: (url) => url.startsWith("https://boards-api.greenhouse.io/v1/boards/exampleai/jobs/"),
        handle: () => {
          detailHits++;
          return Promise.resolve(jsonReply({}, 404));
        },
      },
    ]);
    stubTelegram();

    await pollCompany("example-ai");
    expect(boardHits).toBe(1);
    expect(detailHits).toBe(0);
    expect(await countRows("jobs")).toBe(3);
  });
});

describe("replay idempotency", () => {
  it("replaying the same board 100 times creates zero additional alerts", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline

    for (let i = 0; i < 100; i++) {
      await backdateSource();
      const { outcome } = await pollCompany("example-ai");
      expect(outcome.ok).toBe(true);
      expect(outcome.newJobs).toBe(0);
      expect(outcome.alertsSent).toBe(0);
    }
    expect(await countRows("notifications")).toBe(0);
    expect(await countRows("jobs")).toBe(3);
  });
});

describe("edited job", () => {
  it("does not produce a duplicate NEW notification", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline

    // Job 70001 changes location (material field).
    const edited = jobs.map((j) => (j.id === 70001 ? { ...j, location: { name: "Remote" } } : j));
    stubBoard({ jobs: edited });
    stubTelegram();
    await backdateSource();

    const { outcome } = await pollCompany("example-ai");
    expect(outcome.newJobs).toBe(0);
    expect(outcome.alertsSent).toBe(0);
    expect(await countRows("notifications")).toBe(0);
    const jobRow = await rows("jobs", "external_job_id = '70001'");
    expect(jobRow[0]!.location).toBe("Remote");
  });
});

describe("Telegram failure recovery", () => {
  it("persists the job and retries delivery on the next cycle", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline

    const extra = {
      id: 70005,
      title: "Platform Intern",
      location: { name: "NYC" },
      absolute_url: "https://boards.greenhouse.io/exampleai/jobs/70005",
      updated_at: "2026-08-14T18:30:00Z",
    };
    stubBoard({ jobs: [...jobs, extra] });
    await backdateSource();

    // Telegram is down: 500.
    stubTelegram({ ok: false, status: 500 });
    const first = await pollCompany("example-ai");
    expect(first.outcome.newJobs).toBe(1);
    expect(first.outcome.alertsSent).toBe(0);
    expect(await countRows("jobs")).toBe(4); // job persisted despite failure
    const notifs = await rows("notifications", "1=1");
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.delivered).toBe(0);
    expect(notifs[0]!.error_code).toBe("http_500");

    // Telegram recovers. The retry is throttled, so age the attempt past
    // RETRY_MIN_INTERVAL_MS (5 min) but keep it under RETRY_MAX_AGE_MS (24h):
    // a fixed historical date would go stale as the real clock advances.
    const aged = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await env.DB.exec(`UPDATE notifications SET attempted_at = '${aged}' WHERE delivered = 0`);
    stubTelegram();
    await pollAll();
    const retried = await rows("notifications", "1=1");
    expect(retried[0]!.delivered).toBe(1);
    expect(retried[0]!.error_code).toBeNull();
  });
});

describe("failure isolation and backoff", () => {
  it("a 429 enters backoff and skips polls until it expires", async () => {
    stubBoard({}, 429);
    const first = await pollCompany("example-ai");
    expect(first.outcome.ok).toBe(false);
    expect(first.outcome.errorCode).toBe("rate_limited");
    const state = await repo().getSourceState("example-ai");
    expect(state?.failureStreak).toBe(1);
    expect(state?.backoffUntil).toBeTruthy();
    expect(state?.lastHttpStatus).toBe(429);

    // Next poll immediately: still inside backoff, skipped.
    const second = await pollCompany("example-ai");
    expect(second.outcome.ok).toBe(false);
    expect(second.outcome.errorCode).toBe("backoff");
  });

  it("a 5xx failure is isolated: other companies still poll", async () => {
    // Second company whose board 5xxs.
    const bad: CompanyConfig = {
      ...company,
      id: "infra-co",
      name: "Infra Co",
      boardKey: "infraco",
    };
    await repo().upsertCompany(bad);
    const BAD_BOARD = "https://boards-api.greenhouse.io/v1/boards/infraco/jobs";

    stubBoard({ jobs }); // example-ai healthy
    installFetchStub([
      {
        match: (url) => url === BAD_BOARD,
        handle: () => Promise.resolve(jsonReply({}, 502)),
      },
    ]);
    stubTelegram();

    const results = await pollAll();
    const byCompany = Object.fromEntries(results.summary.outcomes.map((r) => [r.companyId, r]));
    expect(byCompany["example-ai"]!.ok).toBe(true);
    expect(byCompany["infra-co"]!.ok).toBe(false);
    expect(byCompany["infra-co"]!.errorCode).toBe("server_error");
    expect(await countRows("jobs")).toBe(3); // only healthy company persisted
  });

  it("malformed payloads fail cleanly and never crash the cycle", async () => {
    stubBoard({ unexpected: true });
    const { outcome } = await pollCompany("example-ai");
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe("malformed");
    expect(await countRows("jobs")).toBe(0);
  });

  it("a persist failure is contained: no throw, failure recorded, cycle survives", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline (DB healthy)

    // Break the DB for the persist phase: any write now throws. The worker
    // builds its own repo instance, so spy on the prototype.
    vi.spyOn(D1Repository.prototype, "recordSourceSuccess").mockRejectedValue(
      new Error("D1 is down"),
    );
    await backdateSource();

    const first = await pollCompany("example-ai");
    expect(first.outcome.ok).toBe(false);
    expect(first.outcome.errorCode).toBe("persist_error");

    vi.restoreAllMocks();

    // The failure was recorded as a source failure; next poll is refused
    // while backoff applies, and the cycle itself never rejected.
    const state = await repo().getSourceState("example-ai");
    expect(state?.lastErrorCode).toBe("persist_error");
    expect(state?.failureStreak).toBeGreaterThan(0);
  });
});

describe("inactive/reopen lifecycle", () => {
  it("marks a job inactive after 2 consecutive absences", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline: 3 jobs persisted
    expect(await countRows("jobs")).toBe(3);

    // Board drops one job: first absence.
    const reduced = jobs.filter((j) => j.id !== 70001);
    stubBoard({ jobs: reduced });
    await backdateSource();
    const one = await pollCompany("example-ai");
    expect(one.outcome.ok).toBe(true);
    let row = await rows("jobs", "external_job_id = '70001'");
    expect(row[0]!.absent_count).toBe(1);
    expect(row[0]!.status).not.toBe("inactive");

    // Second consecutive absence: inactive.
    await backdateSource();
    const two = await pollCompany("example-ai");
    expect(two.outcome.ok).toBe(true);
    row = await rows("jobs", "external_job_id = '70001'");
    expect(row[0]!.absent_count).toBe(2);
    expect(row[0]!.status).toBe("inactive");
    expect(row[0]!.confirmed_inactive_at).toBeTruthy();
  });

  it("re-alerts a reposted job that went inactive (reopened)", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline

    // Two absences => inactive.
    const reduced = jobs.filter((j) => j.id !== 70002);
    stubBoard({ jobs: reduced });
    await backdateSource();
    await pollCompany("example-ai");
    await backdateSource();
    await pollCompany("example-ai");
    const inactive = await rows("jobs", "external_job_id = '70002'");
    expect(inactive[0]!.status).toBe("inactive");

    // Job reposted: must alert again (reopened).
    const calls: { text: string; chatId: string; buttons: unknown[] }[] = [];
    stubTelegram({ capture: calls });
    stubBoard({ jobs });
    await backdateSource();
    const { outcome } = await pollCompany("example-ai");
    expect(outcome.ok).toBe(true);
    expect(outcome.newJobs).toBe(1);
    expect(outcome.alertsSent).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("REOPENED");
    const reopened = await rows("jobs", "external_job_id = '70002'");
    expect(reopened[0]!.status).toBe("reopened");
  });

  it("reopens even when an earlier delivered notification row exists", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline

    // A NEW job is detected and alerted: delivered row exists.
    const extra = {
      id: 70011,
      title: "Reopen Intern",
      location: { name: "Austin" },
      absolute_url: "https://boards.greenhouse.io/exampleai/jobs/70011",
      updated_at: "2026-08-14T22:00:00Z",
    };
    const firstCalls: { text: string; chatId: string; buttons: unknown[] }[] = [];
    stubBoard({ jobs: [...jobs, extra] });
    stubTelegram({ capture: firstCalls });
    await backdateSource();
    const first = await pollCompany("example-ai");
    expect(first.outcome.alertsSent).toBe(1);
    expect(firstCalls).toHaveLength(1);
    expect(firstCalls[0]!.text).toContain("🚨 NEW");
    const notifs = await rows("notifications", "1=1");
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.delivered).toBe(1);

    // Job leaves the board, then is reposted after going inactive.
    const without = jobs.filter((j) => j.id !== 70011);
    stubBoard({ jobs: without });
    await backdateSource();
    await pollCompany("example-ai");
    await backdateSource();
    await pollCompany("example-ai");
    const gone = await rows("jobs", "external_job_id = '70011'");
    expect(gone[0]!.status).toBe("inactive");

    // Reposted: the old delivered row must NOT suppress the reopen alert.
    const reopenCalls: { text: string; chatId: string; buttons: unknown[] }[] = [];
    stubBoard({ jobs: [...jobs, extra] });
    stubTelegram({ capture: reopenCalls });
    await backdateSource();
    const reopened = await pollCompany("example-ai");
    expect(reopened.outcome.ok).toBe(true);
    expect(reopened.outcome.alertsSent).toBe(1);
    expect(reopenCalls).toHaveLength(1);
    expect(reopenCalls[0]!.text).toContain("🚨 REOPENED");
    const after = await rows("notifications", "1=1");
    expect(after).toHaveLength(1); // one row per (job, channel), re-delivered
    expect(after[0]!.delivered).toBe(1);
    expect(after[0]!.error_code).toBeNull();
  });
});

describe("poll interval enforcement", () => {
  it("skips a company polled too recently (not_due)", async () => {
    stubBoard({ jobs });
    stubTelegram();

    // First run succeeds and records lastSuccessAt = now.
    const first = await pollCompany("example-ai");
    expect(first.outcome.ok).toBe(true);

    // An immediate second manual trigger must be refused, not re-polled.
    const second = await pollCompany("example-ai");
    expect(second.outcome.ok).toBe(false);
    expect(second.outcome.errorCode).toBe("not_due");
  });

  it("allows a poll after the interval has elapsed", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai");

    // Backdate the last success beyond the 120s interval.
    await env.DB.prepare(
      "UPDATE source_state SET last_success_at = ?, last_failure_at = NULL WHERE company_id = ?",
    )
      .bind(new Date(Date.now() - 200_000).toISOString(), "example-ai")
      .run();

    const again = await pollCompany("example-ai");
    expect(again.outcome.ok).toBe(true);
  });
});

describe("API access control", () => {
  it("rejects /api/jobs without a token when DASHBOARD_TOKEN is set", async () => {
    const res = await exports.default.fetch("https://applyrn-worker.test/api/jobs");
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token (fail-closed, not just missing)", async () => {
    const res = await exports.default.fetch("https://applyrn-worker.test/api/jobs", {
      headers: { authorization: "Bearer wrong-token-000" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a non-Bearer scheme even with the right secret", async () => {
    const res = await exports.default.fetch("https://applyrn-worker.test/api/jobs", {
      headers: { authorization: "Basic test-dashboard-token-000" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects /api/poll without a token", async () => {
    const res = await exports.default.fetch("https://applyrn-worker.test/api/poll", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("rejects /api/poll/company without a token", async () => {
    const res = await exports.default.fetch("https://applyrn-worker.test/api/poll/company", {
      method: "POST",
      body: JSON.stringify({ companyId: "example-ai" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a correct bearer token", async () => {
    stubBoard({ jobs });
    stubTelegram();
    const res = await exports.default.fetch("https://applyrn-worker.test/api/jobs", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: unknown[] };
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  it("keeps /health public", async () => {
    const res = await exports.default.fetch("https://applyrn-worker.test/health");
    expect(res.status).toBe(200);
  });
});

describe("notification send claim (F6)", () => {
  it("only one claim wins; delivered rows refuse; stale markers expire", async () => {
    const now = new Date().toISOString();
    const r = repo();

    // First isolate claims: inserted as in-flight, wins.
    expect(await r.claimNotificationSend("job-race-1", "telegram", now)).toBe(true);

    // Second isolate claims immediately: in-flight marker refuses it.
    expect(await r.claimNotificationSend("job-race-1", "telegram", now)).toBe(false);

    // Winner records delivery; a later claim is refused (duplicate guard).
    await r.recordNotificationAttempt({
      jobId: "job-race-1",
      channel: "telegram",
      attemptedAt: now,
      delivered: true,
    });
    expect(await r.claimNotificationSend("job-race-1", "telegram", now)).toBe(false);

    // Reopen: delivery reset, claim succeeds again.
    await r.resetNotificationDelivery("job-race-1", "telegram");
    expect(await r.claimNotificationSend("job-race-1", "telegram", now)).toBe(true);

    // A crashed isolate leaves a fresh 'sending' marker: refused...
    expect(await r.claimNotificationSend("job-race-2", "telegram", now)).toBe(true);
    expect(await r.claimNotificationSend("job-race-2", "telegram", now)).toBe(false);

    // ...until it ages out past the TTL.
    const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await env.DB.exec(
      `UPDATE notifications SET attempted_at = '${stale}' WHERE job_id = 'job-race-2'`,
    );
    expect(await r.claimNotificationSend("job-race-2", "telegram", now)).toBe(true);
  });
});

describe("relevance integration", () => {
  it("suppresses a hard-mismatch job from alerts but persists it", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline

    // A clearly senior role appears on the board.
    const senior = {
      id: 70009,
      title: "Staff Software Engineer",
      location: { name: "San Francisco, CA" },
      absolute_url: "https://boards.greenhouse.io/exampleai/jobs/70009",
      updated_at: "2026-08-14T21:00:00Z",
    };
    stubBoard({ jobs: [...jobs, senior] });
    await backdateSource();
    const calls: { text: string; chatId: string; buttons: unknown[] }[] = [];
    stubTelegram({ capture: calls });

    const { outcome } = await pollCompany("example-ai");
    expect(outcome.ok).toBe(true);
    expect(outcome.newJobs).toBe(0); // suppressed: not counted as alertable
    expect(outcome.alertsSent).toBe(0);
    expect(calls).toHaveLength(0); // no Telegram message
    expect(await countRows("jobs")).toBe(4); // still persisted
    const row = await rows("jobs", "external_job_id = '70009'");
    expect(row[0]!.match_score).toBe(0); // scored 0 for a suppressed job
  });

  it("alerts a relevant job with the match score and reasons", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline

    const relevant = {
      id: 70010,
      title: "Software Engineering Intern",
      location: { name: "San Francisco, CA" },
      absolute_url: "https://boards.greenhouse.io/exampleai/jobs/70010",
      updated_at: "2026-08-14T21:30:00Z",
    };
    stubBoard({ jobs: [...jobs, relevant] });
    await backdateSource();
    const calls: { text: string; chatId: string; buttons: unknown[] }[] = [];
    stubTelegram({ capture: calls });

    const { outcome } = await pollCompany("example-ai");
    expect(outcome.newJobs).toBe(1);
    expect(outcome.alertsSent).toBe(1);
    const sent = calls[0]!;
    expect(sent.text).toContain("MATCH"); // score header rendered
    expect(sent.text).toContain("Internship");
    expect(sent.text).toContain("Software engineering");
    const row = await rows("jobs", "external_job_id = '70010'");
    expect(Number(row[0]!.match_score)).toBeGreaterThan(0);
  });
});

describe("bounded notification retry", () => {
  it("does not retry within the throttle window", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline

    const extra = {
      id: 70006,
      title: "Retry Intern",
      location: { name: "Denver" },
      absolute_url: "https://boards.greenhouse.io/exampleai/jobs/70006",
      updated_at: "2026-08-14T19:00:00Z",
    };
    stubBoard({ jobs: [...jobs, extra] });
    stubTelegram({ ok: false, status: 500 }); // Telegram down
    await backdateSource();
    const first = await pollCompany("example-ai");
    expect(first.outcome.newJobs).toBe(1);
    expect(first.outcome.alertsSent).toBe(0);

    // Immediately retry: throttled, no second send attempt.
    const calls: { text: string; chatId: string; buttons: unknown[] }[] = [];
    stubTelegram({ capture: calls });
    await pollAll();
    expect(calls).toHaveLength(0); // still within RETRY_MIN_INTERVAL_MS
    const notifs = await rows("notifications", "1=1");
    expect(notifs[0]!.delivered).toBe(0);
  });

  it("gives up on notifications older than the max retry age", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline

    const extra = {
      id: 70007,
      title: "Old Intern",
      location: { name: "Seattle" },
      absolute_url: "https://boards.greenhouse.io/exampleai/jobs/70007",
      updated_at: "2026-08-14T19:30:00Z",
    };
    stubBoard({ jobs: [...jobs, extra] });
    stubTelegram({ ok: false, status: 500 });
    await backdateSource();
    await pollCompany("example-ai");

    // Age the undelivered notification beyond RETRY_MAX_AGE_MS (24h).
    await env.DB.exec(
      "UPDATE notifications SET attempted_at = '2026-08-01T00:00:00Z' WHERE delivered = 0",
    );
    const calls: { text: string; chatId: string; buttons: unknown[] }[] = [];
    stubTelegram({ capture: calls });
    await pollAll();
    expect(calls).toHaveLength(0); // too old: no retry, no flood
    const notifs = await rows("notifications", "1=1");
    expect(notifs[0]!.delivered).toBe(0); // detection still persisted
    expect(await countRows("jobs")).toBe(4);
  });
});

describe("duplicate-send guard", () => {
  it("does not send a second alert when a delivered notification row exists", async () => {
    stubBoard({ jobs });
    stubTelegram();
    await pollCompany("example-ai"); // baseline

    // Simulate a job that was already notified (crash after send, before state).
    const extra = {
      id: 70008,
      title: "Already Notified Intern",
      location: { name: "Boston" },
      absolute_url: "https://boards.greenhouse.io/exampleai/jobs/70008",
      updated_at: "2026-08-14T20:00:00Z",
    };
    stubBoard({ jobs: [...jobs, extra] });
    const calls: { text: string; chatId: string; buttons: unknown[] }[] = [];
    stubTelegram({ capture: calls });
    await backdateSource();
    await pollCompany("example-ai"); // first detection: sends once
    expect(calls).toHaveLength(1);

    // Second cycle: job now exists with delivered=1; must not re-send.
    await backdateSource();
    await pollCompany("example-ai");
    expect(calls).toHaveLength(1);
    expect(await countRows("notifications")).toBe(1);
  });
});
