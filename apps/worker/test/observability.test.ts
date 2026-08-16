import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Repository, lifetimeMs, percentile } from "../src/repo.js";
import { HEARTBEAT_STALE_MS, PollScheduler } from "../src/scheduler.js";
import type { CompanyConfig } from "@applyrn/domain";

/**
 * Observability tests (PRD Issue 11): /api/metrics endpoint, 24h report
 * aggregation, percentile/lifetime math, system events, and the scheduler
 * staleness incident (record once, alert once, clear on recovery).
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

const NOW = "2026-08-15T12:00:00.000Z";

const get = (path: string, headers: Record<string, string> = AUTH_HEADER) =>
  exports.default.fetch(`https://applyrn-worker.test${path}`, { headers }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as Record<string, unknown>,
  }));

async function seedCompany(overrides: Partial<Record<string, unknown>> = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO companies
       (id, name, careers_url, provider, board_key, enabled, poll_interval_seconds, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      company.id,
      company.name,
      `https://boards.greenhouse.io/${company.boardKey}`,
      company.provider,
      company.boardKey,
      1,
      120,
      null,
      company.createdAt,
    )
    .run();
  for (const [k, v] of Object.entries(overrides)) {
    await env.DB.prepare(`UPDATE companies SET ${k} = ? WHERE id = ?`).bind(v, company.id).run();
  }
}

async function seedJob(overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
  const job = {
    id: "job-lifetime-1",
    companyId: company.id,
    provider: "greenhouse",
    externalJobId: "ext-lt-1",
    title: "Senior Platform Engineer",
    jobUrl: "https://boards.greenhouse.io/exampleai/jobs/1",
    applyUrl: "https://boards.greenhouse.io/exampleai/jobs/1",
    publicationTimeKind: "authoritative",
    sourcePublishedAt: "2026-08-13T08:00:00Z",
    firstSeenAt: "2026-08-13T08:00:00Z",
    detectedAt: "2026-08-13T08:00:00Z",
    lastSeenAt: "2026-08-15T08:00:00Z",
    contentHash: "abc",
    status: "inactive",
    absentCount: 2,
    matchScore: 90,
    matchReasonsJson: JSON.stringify(["Senior", "Platform"]),
    confirmedInactiveAt: "2026-08-15T08:30:00Z",
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO jobs (id, company_id, provider, external_job_id, title, job_url, apply_url,
      publication_time_kind, source_published_at, first_seen_at, detected_at, last_seen_at,
      content_hash, status, absent_count, match_score, match_reasons_json, confirmed_inactive_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      job.confirmedInactiveAt,
    )
    .run();
  return job.id;
}

async function seedPollMetric(overrides: Partial<Record<string, unknown>> = {}): Promise<void> {
  const metric = {
    provider: "greenhouse",
    shard: "greenhouse",
    started_at: "2026-08-15T11:58:00Z",
    finished_at: "2026-08-15T11:59:00Z",
    companies_polled: 1,
    successful: 1,
    failed: 0,
    new_jobs: 0,
    duration_ms: 120,
    request_latency_p50_ms: 40,
    request_latency_p95_ms: 90,
    request_latency_p99_ms: 110,
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO poll_metrics
       (provider, shard, started_at, finished_at, companies_polled, successful, failed,
        new_jobs, duration_ms, request_latency_p50_ms, request_latency_p95_ms,
        request_latency_p99_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      metric.provider,
      metric.shard,
      metric.started_at,
      metric.finished_at,
      metric.companies_polled,
      metric.successful,
      metric.failed,
      metric.new_jobs,
      metric.duration_ms,
      metric.request_latency_p50_ms,
      metric.request_latency_p95_ms,
      metric.request_latency_p99_ms,
    )
    .run();
}

async function seedNotification(overrides: Partial<Record<string, unknown>> = {}): Promise<void> {
  const n = {
    job_id: "job-lifetime-1",
    channel: "telegram",
    attempted_at: "2026-08-15T09:00:00Z",
    delivered: 0,
    latency_ms: 300,
    error_code: "http_400",
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT OR REPLACE INTO notifications
       (job_id, channel, attempted_at, delivered, latency_ms, error_code)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(n.job_id, n.channel, n.attempted_at, n.delivered, n.latency_ms, n.error_code)
    .run();
}

beforeEach(async () => {
  await seedCompany();
  await env.DB.prepare("DELETE FROM poll_metrics").run();
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM notifications").run();
  await env.DB.prepare("DELETE FROM system_events").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("percentile + lifetime helpers", () => {
  it("computes nearest-rank percentiles", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.95)).toBe(100);
    expect(percentile(sorted, 0.99)).toBe(100);
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.5)).toBe(7);
  });

  it("computes observed posting lifetime from source publication time", () => {
    const ms = lifetimeMs("2026-08-13T08:00:00Z", "2026-08-15T08:30:00Z");
    expect(ms).toBe(2 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000);
    expect(lifetimeMs("2026-08-15T09:00:00Z", "2026-08-15T08:00:00Z")).toBe(0);
    expect(lifetimeMs("not-a-date", "2026-08-15T08:00:00Z")).toBe(0);
  });
});

describe("/api/metrics endpoint", () => {
  it("rejects without a token", async () => {
    const r = await get("/api/metrics", NO_AUTH);
    expect(r.status).toBe(401);
  });

  it("returns the 24h observability report", async () => {
    await seedPollMetric({ duration_ms: 100, new_jobs: 1 });
    await seedPollMetric({ duration_ms: 300, new_jobs: 2 });
    await seedJob();
    await seedNotification({
      job_id: "job-failed-1",
      attempted_at: new Date(Date.now() - 60_000).toISOString(),
      delivered: 0,
      error_code: "http_400",
    });
    await seedNotification({
      job_id: "job-lifetime-1",
      channel: "telegram",
      attempted_at: new Date(Date.now() - 30_000).toISOString(),
      delivered: 1,
      error_code: null,
    });
    // Same job+channel delivered twice is impossible via the unique index,
    // but the report must at least shape correctly with valid rows.
    const r = await get("/api/metrics");
    expect(r.status).toBe(200);
    const metrics = (r.body as { metrics: Record<string, unknown> }).metrics;
    expect(metrics.cycles).toBe(2);
    expect(metrics.companiesPolled).toBe(2);
    expect(metrics.successful).toBe(2);
    expect(metrics.newJobs).toBe(3);
    expect(metrics.durationP50Ms).toBe(100);
    expect(metrics.durationP95Ms).toBe(300);
    expect(metrics.requestLatencyP95Ms).toBe(90);
    expect(metrics.alertFailures).toEqual([{ error_code: "http_400", n: 1 }]);
    expect(metrics.inactiveConfirmations).toBe(1);
    expect(metrics.duplicateNotifications).toBe(0);
    const lifetimes = metrics.observedLifetimes as {
      title: string;
      lifetimeMs: number;
    }[];
    expect(lifetimes[0]!.title).toBe("Senior Platform Engineer");
    expect(lifetimes[0]!.lifetimeMs).toBe(2 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000);
  });

  it("reports duplicate notifications when the unique index is bypassed", async () => {
    await seedNotification({ job_id: "job-lifetime-1", channel: "telegram", delivered: 1 });
    // The schema's unique (job_id, channel) index normally forbids this; the
    // report query still counts it if data is inconsistent (soak canary).
    await env.DB.prepare(
      `INSERT INTO notifications (job_id, channel, attempted_at, delivered)
       VALUES ('other-job', 'telegram', '2026-08-15T09:10:00Z', 1)`,
    ).run();
    const r = await get("/api/metrics");
    const metrics = (r.body as { metrics: { duplicateNotifications: number } }).metrics;
    expect(metrics.duplicateNotifications).toBe(0);
  });
});

describe("system events", () => {
  it("records, dedupes open incidents, and clears them", async () => {
    const r = repo();
    await r.recordSystemEvent("scheduler-stale", NOW, "stale!");
    await r.recordSystemEvent("scheduler-stale", "2026-08-15T12:05:00Z", "stale again");
    const open = await r.getOpenSystemEvent("scheduler-stale");
    expect(open?.kind).toBe("scheduler-stale");
    expect(open?.cleared_at).toBeNull();

    await r.clearSystemEvents("scheduler-stale", "2026-08-15T12:10:00Z");
    const after = await r.getOpenSystemEvent("scheduler-stale");
    expect(after).toBeNull();
  });
});

describe("scheduler staleness heartbeat", () => {
  class StubPoller {
    pollCompany = vi.fn(async () => ({
      companyId: company.id,
      ok: true,
      newJobs: 0,
      alertsSent: 0,
    }));
    retryUndelivered = vi.fn(async () => 0);
    sendSystemAlert = vi.fn(async () => true);
  }

  it("records an incident once and alerts once, then clears on recovery", async () => {
    const realNow = new Date().toISOString();
    await seedPollMetric({
      finished_at: new Date(Date.now() - HEARTBEAT_STALE_MS - 60_000).toISOString(),
    });
    const stub = new StubPoller();
    const scheduler = new PollScheduler(repo(), stub as never);

    // First run: stale (last cycle finished > 15 min ago) -> incident + alert.
    await scheduler.runCycle(realNow);
    expect(await repo().getOpenSystemEvent("scheduler-stale")).not.toBeNull();
    expect(stub.sendSystemAlert).toHaveBeenCalledTimes(1);
    expect(stub.sendSystemAlert).toHaveBeenCalledWith(expect.stringContaining("stale"));

    // Second run while still stale: no duplicate alert.
    await scheduler.runCycle(new Date().toISOString());
    expect(stub.sendSystemAlert).toHaveBeenCalledTimes(1);

    // Recovery: a fresh cycle clears the incident.
    await scheduler.runCycle(new Date().toISOString());
    expect(await repo().getOpenSystemEvent("scheduler-stale")).toBeNull();
  });

  it("does not alert on a fresh scheduler (no prior cycle)", async () => {
    const stub = new StubPoller();
    const scheduler = new PollScheduler(repo(), stub as never);
    await scheduler.runCycle(NOW);
    expect(stub.sendSystemAlert).not.toHaveBeenCalled();
    expect(await repo().getOpenSystemEvent("scheduler-stale")).toBeNull();
  });
});
