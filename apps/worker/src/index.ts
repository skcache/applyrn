import {
  AshbyAdapter,
  GreenhouseAdapter,
  LeverAdapter,
  SmartRecruitersAdapter,
  TaleoAdapter,
  WorkdayAdapter,
} from "@applyrn/adapters";
import type { JobSourceAdapter } from "@applyrn/adapters";
import type { ApplicationStatus } from "@applyrn/domain";
import { D1Repository } from "./repo.js";
import { PollService, SUBREQUEST_LIMIT_PER_INVOCATION, type WorkerEnv } from "./poll.js";
import { PollScheduler } from "./scheduler.js";
import { log } from "./logger.js";

/**
 * ApplyRN Worker: cron-driven poll cycle + minimal HTTP API.
 *
 * GET  /health            liveness
 * GET  /api/jobs          recent jobs (dashboard read path)
 * POST /api/poll          trigger one poll cycle manually
 * POST /api/poll/company  trigger a single company poll
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Observability report window: the last 24 hours (PRD Issue 11). */
const OBSERVABILITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * /api/tick stand-down window: if the last completed cycle is fresher than
 * this, an external pinger does nothing (the primary cron is healthy).
 * 180s mirrors the GH fallback's staleness threshold — comfortably above
 * the 2-min per-shard cadence, comfortably below the 5-min pinger period.
 */
const TICK_STALENESS_SECONDS = 180;

/**
 * V0 access control (PRD 14): a single shared token. Data/mutating
 * endpoints require `Authorization: Bearer <DASHB...N>`.
 *
 * FAIL-CLOSED: when DASHBOARD_TOKEN is unset the API is locked, not open.
 * Local development must set DASHBOARD_TOKEN in .dev.vars; production
 * provisioning lives in .github/workflows/deploy.yml. This deliberately
 * prevents an accidental wide-open deploy (previously the default).
 */
async function isAuthorized(request: Request, env: WorkerEnv): Promise<boolean> {
  const token = env.DASHBOARD_TOKEN;
  if (!token) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice("Bearer ".length), token);
}

/**
 * Constant-time string comparison via SHA-256 digests. Both sides are
 * hashed so length differences leak nothing, then the digests are
 * compared with a branch-free XOR loop.
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401, headers: JSON_HEADERS });
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(buildScheduler(env).runCycle(new Date().toISOString(), { trigger: "cf-cron" }));
  },

  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const repo = new D1Repository(env.DB);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "applyrn-worker" }, { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/jobs") {
      if (!(await isAuthorized(request, env))) return unauthorized();
      const jobs = await repo.listJobViews(50);
      return Response.json({ jobs }, { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      if (!(await isAuthorized(request, env))) return unauthorized();
      const id = url.pathname.slice("/api/jobs/".length);
      const job = await repo.getJobView(id);
      if (!job) {
        return Response.json({ error: "unknown job" }, { status: 404, headers: JSON_HEADERS });
      }
      return Response.json({ job }, { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/sources") {
      if (!(await isAuthorized(request, env))) return unauthorized();
      const sources = await repo.listSourceHealth();
      return Response.json({ sources }, { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      if (!(await isAuthorized(request, env))) return unauthorized();
      const status = await repo.getSystemStatus();
      return Response.json({ status }, { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/metrics") {
      if (!(await isAuthorized(request, env))) return unauthorized();
      const since = new Date(Date.now() - OBSERVABILITY_WINDOW_MS).toISOString();
      const metrics = await repo.getObservability(since);
      return Response.json({ metrics }, { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/applications") {
      if (!(await isAuthorized(request, env))) return unauthorized();
      const applications = await repo.listApplicationViews();
      return Response.json({ applications }, { headers: JSON_HEADERS });
    }

    if (
      request.method === "PUT" &&
      url.pathname.startsWith("/api/jobs/") &&
      url.pathname.endsWith("/application")
    ) {
      if (!(await isAuthorized(request, env))) return unauthorized();
      const id = url.pathname.slice("/api/jobs/".length, -"/application".length);
      const body = (await request.json().catch(() => ({}))) as { status?: unknown };
      // Audit 2026-08-22: non-string JSON values (number/object/array) used
      // to throw on .toUpperCase() -> unhandled 500. Validate the type first.
      const status = typeof body.status === "string" ? body.status.toUpperCase() : undefined;
      const valid: string[] = [
        "DETECTED",
        "SAVED",
        "APPLIED",
        "OA",
        "INTERVIEW",
        "FINAL",
        "OFFER",
        "REJECTED",
        "GHOSTED",
      ];
      if (!status || !valid.includes(status)) {
        return Response.json(
          { error: `invalid status, expected one of ${valid.join(", ")}` },
          { status: 400, headers: JSON_HEADERS },
        );
      }
      const job = await repo.getJobById(id);
      if (!job) {
        return Response.json({ error: "unknown job" }, { status: 404, headers: JSON_HEADERS });
      }
      await repo.setApplicationStatus(id, status as ApplicationStatus, new Date().toISOString());
      const app = await repo.getApplication(id);
      return Response.json({ application: app }, { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/api/tick") {
      // Third independent trigger (Phase 2): a free external pinger
      // (cron-job.org / UptimeRobot) hits this every ~5 minutes. The gate is
      // SERVER-SIDE so the pinger needs zero logic: if the last completed
      // cycle is fresher than TICK_STALENESS_SECONDS (the primary cron is
      // healthy), the tick stands down with {ticked: false}. When stale, ONE
      // call sweeps EVERY shard sequentially (a pinger can't do matrix
      // fan-out like GH Actions), staying under the per-invocation subrequest
      // budget because each shard's due-list is bounded by shardCountFor.
      //
      // Auth: same shared bearer token as the rest of the API — the URL
      // alone must never be able to drive cycles.
      if (!(await isAuthorized(request, env))) return unauthorized();
      const status = await repo.getSystemStatus();
      const ageSec = status.lastPollAt
        ? (Date.now() - Date.parse(status.lastPollAt)) / 1000
        : Number.POSITIVE_INFINITY;
      if (Number.isFinite(ageSec) && ageSec < TICK_STALENESS_SECONDS) {
        return Response.json(
          { ticked: false, reason: "fresh", lastPollAgeSeconds: Math.round(ageSec) },
          { headers: JSON_HEADERS },
        );
      }
      const scheduler = buildScheduler(env);
      // Audit 2026-08-22 V5a: the sweep previously let each runCycle build a
      // FRESH 50-subrequest FetchBudget, but Cloudflare's counter is per
      // INVOCATION — after an outage (everything due) shard 0 alone consumed
      // the cap and shards 1+ mass-failed with unbacked-off `network`
      // errors while this endpoint still returned {ticked:true}. Fix:
      // ONE shared budget across the whole sweep sized to the total due
      // list; each shard isolated so one failure can't kill the rest; and
      // the response reports per-shard ok/failed honestly.
      const summaries: { shard: number; ok: number; failed: number }[] = [];
      for (let shard = 0; shard < status.shardCount; shard++) {
        try {
          const summary = await scheduler.runCycle(new Date().toISOString(), {
            shard,
            trigger: "external-ping",
            // Shared pool: the scheduler plans its own due-list fetches into
            // this budget instead of assuming a fresh 50.
            budgetPool: SUBREQUEST_LIMIT_PER_INVOCATION,
          });
          const ok = summary.outcomes.filter((o) => o.ok).length;
          summaries.push({ shard, ok, failed: summary.outcomes.length - ok });
        } catch (err) {
          // One shard's unexpected throw must not kill the remaining shards.
          summaries.push({ shard, ok: 0, failed: -1 });
          log.error("tick.shard_failed", {
            shard,
            error: err instanceof Error ? err.name : "unknown",
          });
        }
      }
      return Response.json(
        { ticked: true, shards: summaries.length, results: summaries },
        { headers: JSON_HEADERS },
      );
    }

    if (request.method === "POST" && url.pathname === "/api/poll") {
      if (!(await isAuthorized(request, env))) return unauthorized();
      // Optional ?shard=N lets an external fallback trigger cover a specific
      // shard deterministically (GitHub Actions poller), independent of the
      // minute rotation. Invalid values fall back to the minute shard.
      const raw = url.searchParams.get("shard");
      const shard = raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
      // Audit 2026-08-22 V8: same stand-down gate as /api/tick, scoped to
      // the SHARD being requested (a shard-scoped trigger must not be gated
      // on the global heartbeat — other shards may legitimately be fresher
      // or staler). A hammering or misbehaving token-holder (the pinger
      // service also holds this token) previously wrote an unbounded
      // poll_metrics row per request — D1 write-quota amplification with
      // no ceiling. When this shard cycled recently, stand down with
      // zero writes.
      const status = await repo.getSystemStatus();
      const shardKey =
        shard !== undefined && shard >= 0 && shard < status.shardCount
          ? String(shard)
          : String(Math.floor(Date.now() / 60_000) % Math.max(1, status.shardCount));
      const lastShardPollAt = await repo.getLastShardPollAt(shardKey);
      const ageSec = lastShardPollAt
        ? (Date.now() - Date.parse(lastShardPollAt)) / 1000
        : Number.POSITIVE_INFINITY;
      if (Number.isFinite(ageSec) && ageSec < TICK_STALENESS_SECONDS) {
        return Response.json(
          {
            summary: {
              outcomes: [],
              skippedBackoff: 0,
              skippedInterval: status.companyCount,
              retried: 0,
              durationMs: 0,
              stoodDown: true,
            },
          },
          { headers: JSON_HEADERS },
        );
      }
      const summary = await buildScheduler(env).runCycle(new Date().toISOString(), {
        ...(shard !== undefined ? { shard } : {}),
        trigger: "gh-fallback",
      });
      return Response.json({ summary }, { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/api/poll/company") {
      if (!(await isAuthorized(request, env))) return unauthorized();
      const body = (await request.json().catch(() => ({}))) as { companyId?: unknown };
      // Audit 2026-08-22: non-string companyId previously threw in the D1
      // bind -> unhandled 500. Type-check before use.
      if (!body.companyId || typeof body.companyId !== "string") {
        return Response.json(
          { error: "companyId required" },
          { status: 400, headers: JSON_HEADERS },
        );
      }
      const company = await repo.getCompany(body.companyId);
      if (!company) {
        return Response.json({ error: "unknown company" }, { status: 404, headers: JSON_HEADERS });
      }
      const service = buildPollService(env);
      const outcome = await service.pollCompany(company, new Date().toISOString());
      return Response.json({ outcome }, { headers: JSON_HEADERS });
    }

    return Response.json({ error: "not found" }, { status: 404, headers: JSON_HEADERS });
  },
} satisfies ExportedHandler<WorkerEnv>;

function buildPollService(env: WorkerEnv): PollService {
  const adapters = new Map<string, JobSourceAdapter>();
  adapters.set("greenhouse", new GreenhouseAdapter());
  adapters.set("ashby", new AshbyAdapter());
  adapters.set("lever", new LeverAdapter());
  adapters.set("smartrecruiters", new SmartRecruitersAdapter());
  adapters.set("workday", new WorkdayAdapter());
  adapters.set("oracle", new TaleoAdapter());
  return new PollService(new D1Repository(env.DB), adapters, env);
}

function buildScheduler(env: WorkerEnv): PollScheduler {
  const poller = buildPollService(env);
  return new PollScheduler(new D1Repository(env.DB), poller);
}
