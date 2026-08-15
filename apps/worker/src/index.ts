import { GreenhouseAdapter } from "@applyrn/adapters";
import type { JobSourceAdapter } from "@applyrn/adapters";
import { D1Repository } from "./repo.js";
import { PollService, type WorkerEnv } from "./poll.js";

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
    ctx.waitUntil(runCycle(env));
  },

  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const repo = new D1Repository(env.DB);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "applyrn-worker" }, { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/jobs") {
      if (!isAuthorized(request, env)) return unauthorized();
      const jobs = await repo.listJobs(50);
      return Response.json({ jobs }, { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/api/poll") {
      if (!isAuthorized(request, env)) return unauthorized();
      const results = await runCycle(env);
      return Response.json({ results }, { headers: JSON_HEADERS });
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
  return new PollService(new D1Repository(env.DB), adapters, env);
}

async function runCycle(env: WorkerEnv): Promise<unknown[]> {
  const repo = new D1Repository(env.DB);
  const service = buildPollService(env);
  const companies = await repo.listEnabledCompanies();
  const now = new Date().toISOString();
  const startedAt = now;

  const outcomes = [];
  for (const company of companies) {
    outcomes.push(await service.pollCompany(company, new Date().toISOString()));
  }

  // Retry any undelivered Telegram notifications from earlier cycles.
  const retried = await service.retryUndelivered(new Date().toISOString());
  const finishedAt = new Date().toISOString();
  const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  // Aggregate poll metric per provider (PRD 8.6: aggregate rows, not per-fetch).
  const byProvider = new Map<string, { successful: number; failed: number; newJobs: number }>();
  for (const o of outcomes) {
    const company = companies.find((c) => c.id === o.companyId);
    const key = company?.provider ?? "unknown";
    const agg = byProvider.get(key) ?? { successful: 0, failed: 0, newJobs: 0 };
    if (o.ok) agg.successful++;
    else agg.failed++;
    agg.newJobs += o.newJobs;
    byProvider.set(key, agg);
  }
  for (const [provider, agg] of byProvider) {
    await repo.insertPollMetric({
      provider,
      shard: "default",
      startedAt,
      finishedAt,
      companiesPolled: companies.filter((c) => c.provider === provider).length,
      successful: agg.successful,
      failed: agg.failed,
      newJobs: agg.newJobs,
      durationMs,
    });
  }

  if (retried > 0) {
    // Structural log line for observability; counts, no job content.
    console.log(`applyrn: retried ${retried} undelivered telegram notifications`);
  }
  return outcomes;
}
