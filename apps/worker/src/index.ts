import { D1Repository } from "./repo.js";

/**
 * ApplyRN Worker — domain + D1 stage (Issue 1 / PR #2).
 * Health + job read path; the poll cycle lands in PR #5.
 */

type WorkerEnv = {
  DB: D1Database;
};

const JSON_HEADERS = { "Content-Type": "application/json" };

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const repo = new D1Repository(env.DB);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "applyrn-worker" }, { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/jobs") {
      const jobs = await repo.listJobs(50);
      return Response.json({ jobs }, { headers: JSON_HEADERS });
    }

    return Response.json({ error: "not found" }, { status: 404, headers: JSON_HEADERS });
  },
} satisfies ExportedHandler<WorkerEnv>;
