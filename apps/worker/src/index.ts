import { AshbyAdapter, GreenhouseAdapter, LeverAdapter } from "@applyrn/adapters";
import type { JobSourceAdapter } from "@applyrn/adapters";
import type { ApplicationStatus } from "@applyrn/domain";
import { D1Repository } from "./repo.js";
import { PollService, type WorkerEnv } from "./poll.js";
import { PollScheduler } from "./scheduler.js";

/**
 * ApplyRN Worker: cron-driven poll cycle + minimal HTTP API.
 *
 * GET  /health            liveness
 * GET  /api/jobs          recent jobs (dashboard read path)
 * POST /api/poll          trigger one poll cycle manually
 * POST /api/poll/company  trigger a single company poll
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * V0 access control (PRD 14): a single shared token. When DASHBOARD_TOKEN is
 * set, mutating/data endpoints require `Authorization: Bearer <token>`.
 * When unset (local dev), endpoints stay open. This is deliberately NOT a
 * full auth product.
 */
function isAuthorized(request: Request, env: WorkerEnv): boolean {
  const token = env.DASHBOARD_TOKEN;
  if (!token) return true;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${token}`;
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
    ctx.waitUntil(buildScheduler(env).runCycle(new Date().toISOString()));
  },

  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const repo = new D1Repository(env.DB);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "applyrn-worker" }, { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/jobs") {
      if (!isAuthorized(request, env)) return unauthorized();
      const jobs = await repo.listJobViews(50);
      return Response.json({ jobs }, { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      if (!isAuthorized(request, env)) return unauthorized();
      const id = url.pathname.slice("/api/jobs/".length);
      const job = await repo.getJobView(id);
      if (!job) {
        return Response.json({ error: "unknown job" }, { status: 404, headers: JSON_HEADERS });
      }
      return Response.json({ job }, { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/sources") {
      if (!isAuthorized(request, env)) return unauthorized();
      const sources = await repo.listSourceHealth();
      return Response.json({ sources }, { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      if (!isAuthorized(request, env)) return unauthorized();
      const status = await repo.getSystemStatus();
      return Response.json({ status }, { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/applications") {
      if (!isAuthorized(request, env)) return unauthorized();
      const applications = await repo.listApplicationViews();
      return Response.json({ applications }, { headers: JSON_HEADERS });
    }

    if (
      request.method === "PUT" &&
      url.pathname.startsWith("/api/jobs/") &&
      url.pathname.endsWith("/application")
    ) {
      if (!isAuthorized(request, env)) return unauthorized();
      const id = url.pathname.slice("/api/jobs/".length, -"/application".length);
      const body = (await request.json().catch(() => ({}))) as { status?: string };
      const status = body.status?.toUpperCase();
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

    if (request.method === "POST" && url.pathname === "/api/poll") {
      if (!isAuthorized(request, env)) return unauthorized();
      const summary = await buildScheduler(env).runCycle(new Date().toISOString());
      return Response.json({ summary }, { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/api/poll/company") {
      if (!isAuthorized(request, env)) return unauthorized();
      const body = (await request.json().catch(() => ({}))) as { companyId?: string };
      if (!body.companyId) {
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
  return new PollService(new D1Repository(env.DB), adapters, env);
}

function buildScheduler(env: WorkerEnv): PollScheduler {
  const poller = buildPollService(env);
  return new PollScheduler(new D1Repository(env.DB), poller);
}
