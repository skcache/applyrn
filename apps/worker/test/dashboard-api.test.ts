import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Repository } from "../src/repo.js";
import type { CompanyConfig } from "@applyrn/domain";

/**
 * Dashboard API tests: jobs tape, job detail, sources, system status,
 * applications. Outbound HTTP is stubbed; companies are synthetic.
 */

const AUTH_HEADER = { authorization: "Bearer test-dashboard-token-000" };
const NO_AUTH = {};

const company: CompanyConfig = {
  id: "example-ai",
  name: "Example AI",
  provider: "greenhouse",
  boardKey: "exampleai",
  enabled: true,
  pollIntervalSeconds: 120,
  createdAt: "2026-08-14T00:00:00Z",
};

const repo = () => new D1Repository(env.DB);

const get = (path: string, headers: Record<string, string> = AUTH_HEADER) =>
  exports.default.fetch(`https://applyrn-worker.test${path}`, { headers }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as Record<string, unknown>,
  }));

async function seedJob(overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
  const job = {
    id: "job-1",
    companyId: "example-ai",
    provider: "greenhouse",
    externalJobId: "ext-1",
    title: "Software Engineering Intern",
    jobUrl: "https://boards.greenhouse.io/exampleai/jobs/1",
    applyUrl: "https://boards.greenhouse.io/exampleai/jobs/1",
    publicationTimeKind: "authoritative",
    sourcePublishedAt: "2026-08-14T17:00:00Z",
    firstSeenAt: "2026-08-14T17:00:00Z",
    detectedAt: "2026-08-14T17:00:00Z",
    lastSeenAt: "2026-08-14T17:00:00Z",
    contentHash: "abc",
    status: "new",
    absentCount: 0,
    matchScore: 82,
    matchReasonsJson: JSON.stringify(["Internship", "Python"]),
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO jobs (id, company_id, provider, external_job_id, title, job_url, apply_url,
      publication_time_kind, source_published_at, first_seen_at, detected_at, last_seen_at,
      content_hash, status, absent_count, match_score, match_reasons_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      job.id,
      job.companyId,
      job.provider,
      job.externalJobId,
      job.title,
      job.jobUrl,
      job.applyUrl,
      job.publicationTimeKind,
      job.sourcePublishedAt,
      job.firstSeenAt,
      job.detectedAt,
      job.lastSeenAt,
      job.contentHash,
      job.status,
      job.absentCount,
      job.matchScore,
      job.matchReasonsJson,
    )
    .run();
  return job.id;
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

describe("dashboard API auth", () => {
  it("requires a token for every dashboard endpoint", async () => {
    for (const path of [
      "/api/jobs",
      "/api/jobs/x",
      "/api/sources",
      "/api/status",
      "/api/applications",
    ]) {
      const res = await get(path, NO_AUTH);
      expect(res.status).toBe(401);
    }
  });
});

describe("GET /api/jobs", () => {
  it("returns jobs with company name, match info, and application status", async () => {
    await seedJob();
    await repo().upsertApplication({
      jobId: "job-1",
      status: "APPLIED",
      appliedAt: "2026-08-14T18:00:00Z",
    });
    const res = await get("/api/jobs");
    expect(res.status).toBe(200);
    const jobs = res.body.jobs as {
      companyName: string;
      title: string;
      matchScore: number;
      applicationStatus: string;
    }[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.companyName).toBe("Example AI");
    expect(jobs[0]!.title).toBe("Software Engineering Intern");
    expect(jobs[0]!.matchScore).toBe(82);
    expect(jobs[0]!.applicationStatus).toBe("APPLIED");
  });

  it("returns empty tape when no jobs", async () => {
    const res = await get("/api/jobs");
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([]);
  });
});

describe("GET /api/jobs/:id", () => {
  it("returns a single job with detail fields", async () => {
    const id = await seedJob();
    const res = await get(`/api/jobs/${id}`);
    expect(res.status).toBe(200);
    const job = res.body.job as { title: string; matchReasonsJson: string; companyName: string };
    expect(job.title).toBe("Software Engineering Intern");
    expect(job.companyName).toBe("Example AI");
    expect(job.matchReasonsJson).toContain("Internship");
  });

  it("404s for an unknown job", async () => {
    const res = await get("/api/jobs/nope");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/sources", () => {
  it("returns source health rows for all companies", async () => {
    await repo().recordSourceSuccess("example-ai", "2026-08-14T17:00:00Z", 200, "3");
    const res = await get("/api/sources");
    expect(res.status).toBe(200);
    const sources = res.body.sources as {
      name: string;
      lastSuccessAt: string;
      failureStreak: number;
    }[];
    expect(sources).toHaveLength(1);
    expect(sources[0]!.name).toBe("Example AI");
    expect(sources[0]!.lastSuccessAt).toBeTruthy();
    expect(sources[0]!.failureStreak).toBe(0);
  });

  it("returns companies with no health data yet (null state)", async () => {
    const res = await get("/api/sources");
    const sources = res.body.sources as { lastSuccessAt?: string; failureStreak: number }[];
    expect(sources).toHaveLength(1);
    expect(sources[0]!.lastSuccessAt).toBeUndefined();
    expect(sources[0]!.failureStreak).toBe(0);
  });
});

describe("GET /api/status", () => {
  it("reports company count, cadence, and last poll", async () => {
    await repo().insertPollMetric({
      provider: "greenhouse",
      shard: "greenhouse",
      startedAt: "2026-08-14T17:00:00Z",
      finishedAt: "2026-08-14T17:00:02Z",
      companiesPolled: 1,
      successful: 1,
      failed: 0,
      newJobs: 0,
      durationMs: 2000,
    });
    const res = await get("/api/status");
    expect(res.status).toBe(200);
    const status = res.body.status as {
      companyCount: number;
      cadenceSeconds: number;
      lastPollAt: string;
    };
    expect(status.companyCount).toBe(1);
    expect(status.cadenceSeconds).toBe(120);
    expect(status.lastPollAt).toBe("2026-08-14T17:00:02Z");
  });

  it("reports zero state before any data exists", async () => {
    const res = await get("/api/status");
    const status = res.body.status as { companyCount: number; lastPollAt?: string };
    expect(status.companyCount).toBe(1);
    expect(status.lastPollAt).toBeUndefined();
  });
});

describe("PUT /api/jobs/:id/application", () => {
  const put = (id: string, body: unknown, headers: Record<string, string> = AUTH_HEADER) =>
    exports.default
      .fetch(`https://applyrn-worker.test/api/jobs/${id}/application`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      .then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

  it("sets a status and stamps the corresponding timestamp", async () => {
    const id = await seedJob();
    const res = await put(id, { status: "APPLIED" });
    expect(res.status).toBe(200);
    const app = res.body.application as { status: string; appliedAt: string };
    expect(app.status).toBe("APPLIED");
    expect(app.appliedAt).toBeTruthy();

    // The tape view now reflects the application.
    const jobs = await get("/api/jobs");
    const first = (
      jobs.body.jobs as { applicationStatus: string; applicationAppliedAt: string }[]
    )[0]!;
    expect(first.applicationStatus).toBe("APPLIED");
    expect(first.applicationAppliedAt).toBeTruthy();
  });

  it("preserves applied_at when moving to a later status", async () => {
    const id = await seedJob();
    await put(id, { status: "APPLIED" });
    const before = await repo().getApplication(id);
    await put(id, { status: "INTERVIEW" });
    const after = await repo().getApplication(id);
    expect(after!.status).toBe("INTERVIEW");
    expect(after!.appliedAt).toBe(before!.appliedAt);
    expect(after!.interviewAt).toBeTruthy();
  });

  it("rejects invalid statuses with 400", async () => {
    const id = await seedJob();
    const res = await put(id, { status: "NOT_A_STATUS" });
    expect(res.status).toBe(400);
  });

  it("404s for an unknown job", async () => {
    const res = await put("nope", { status: "APPLIED" });
    expect(res.status).toBe(404);
  });

  it("requires auth", async () => {
    const res = await put("job-1", { status: "APPLIED" }, NO_AUTH);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/applications", () => {
  it("returns applications joined with job and company", async () => {
    await seedJob();
    await repo().upsertApplication({
      jobId: "job-1",
      status: "APPLIED",
      appliedAt: "2026-08-14T18:00:00Z",
    });
    const res = await get("/api/applications");
    expect(res.status).toBe(200);
    const apps = res.body.applications as {
      jobTitle: string;
      companyName: string;
      status: string;
    }[];
    expect(apps).toHaveLength(1);
    expect(apps[0]!.jobTitle).toBe("Software Engineering Intern");
    expect(apps[0]!.companyName).toBe("Example AI");
    expect(apps[0]!.status).toBe("APPLIED");
  });

  it("returns empty list when no applications", async () => {
    const res = await get("/api/applications");
    expect(res.body.applications).toEqual([]);
  });
});
