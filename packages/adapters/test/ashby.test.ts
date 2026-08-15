import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompanyConfig } from "@applyrn/domain";
import { AshbyAdapter } from "../src/ashby/ashby.js";

const fixture = (name: string): unknown => {
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "ashby", "fixtures", name);
  return JSON.parse(readFileSync(p, "utf8"));
};

const company: CompanyConfig = {
  id: "example-ai",
  name: "Example AI",
  provider: "ashby",
  boardKey: "exampleai",
  enabled: true,
  pollIntervalSeconds: 120,
  createdAt: "2026-08-14T00:00:00Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AshbyAdapter normalize", () => {
  it("maps a valid board fixture to normalized jobs", async () => {
    const adapter = new AshbyAdapter();
    const jobs = await adapter.normalize(company, fixture("board-valid.json"));
    expect(jobs).toHaveLength(3);
    const first = jobs[0]!;
    expect(first.provider).toBe("ashby");
    expect(first.companyId).toBe("example-ai");
    expect(first.externalJobId).toBe("a1b2c3d4");
    expect(first.title).toBe("Software Engineering Intern");
    expect(first.location).toBe("San Francisco, CA, Remote");
    expect(first.employmentType).toBe("Internship");
    expect(first.department).toBe("Engineering");
    expect(first.team).toBe("Platform");
    expect(first.jobUrl).toBe("https://jobs.ashbyhq.com/exampleai/a1b2c3d4");
    expect(first.applyUrl).toBe("https://jobs.ashbyhq.com/exampleai/a1b2c3d4/apply");
    expect(first.compensationText).toBe("Internship hourly rate");
    expect(first.sourcePublishedAt).toBe("2026-08-14T17:00:00Z");
    expect(first.publicationTimeKind).toBe("authoritative");
  });

  it("handles an empty board", async () => {
    const adapter = new AshbyAdapter();
    expect(await adapter.normalize(company, fixture("board-empty.json"))).toEqual([]);
  });

  it("throws malformed on a payload without jobs array", async () => {
    const adapter = new AshbyAdapter();
    await expect(adapter.normalize(company, fixture("board-malformed.json"))).rejects.toMatchObject({
      code: "malformed",
    });
  });

  it("skips rows without id or title instead of failing the board", async () => {
    const adapter = new AshbyAdapter();
    const jobs = await adapter.normalize(company, {
      jobs: [{ title: "No id" }, { id: "1", title: "" }, { id: "2", title: "Good Job" }],
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.externalJobId).toBe("2");
  });

  it("marks jobs without publishedAt as observed", async () => {
    const adapter = new AshbyAdapter();
    const jobs = await adapter.normalize(company, {
      jobs: [{ id: "9", title: "No timestamp" }],
    });
    expect(jobs[0]!.publicationTimeKind).toBe("observed");
    expect(jobs[0]!.sourcePublishedAt).toBeUndefined();
  });
});

describe("AshbyAdapter fetchBoard failures", () => {
  it("maps 429 to rate_limited", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429));
    const adapter = new AshbyAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
  });

  it("maps 5xx to server_error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 502));
    const adapter = new AshbyAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "server_error", status: 502 });
  });

  it("maps timeout to timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const adapter = new AshbyAdapter(fetchImpl, 100);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "timeout" });
  });

  it("maps network errors to network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const adapter = new AshbyAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "network" });
  });

  it("maps non-JSON bodies to malformed", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    const adapter = new AshbyAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "malformed" });
  });

  it("rejects oversized responses via content-length", async () => {
    const big = "x".repeat(6 * 1024 * 1024);
    const fetchImpl = vi.fn(
      async () =>
        new Response(big, {
          status: 200,
          headers: { "Content-Type": "application/json", "Content-Length": String(big.length) },
        }),
    );
    const adapter = new AshbyAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "malformed" });
  });

  it("verifies the request URL encodes the board key", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.ashbyhq.com/posting-api/job-board/exampleai");
      return jsonResponse({ jobs: [] });
    });
    const adapter = new AshbyAdapter(fetchImpl);
    await adapter.fetchBoard(company);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
