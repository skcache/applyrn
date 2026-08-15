import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompanyConfig } from "@applyrn/domain";
import { AdapterError } from "../src/types.js";
import { GreenhouseAdapter } from "../src/greenhouse/greenhouse.js";

const fixture = (name: string): unknown => {
  const p = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "greenhouse",
    "fixtures",
    name,
  );
  return JSON.parse(readFileSync(p, "utf8"));
};

const company: CompanyConfig = {
  id: "example-ai",
  name: "Example AI",
  provider: "greenhouse",
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

describe("GreenhouseAdapter normalize", () => {
  it("maps a valid list fixture to normalized jobs", async () => {
    const adapter = new GreenhouseAdapter();
    const jobs = await adapter.normalize(company, fixture("list-valid.json"));
    expect(jobs).toHaveLength(3);
    const first = jobs[0]!;
    expect(first.provider).toBe("greenhouse");
    expect(first.companyId).toBe("example-ai");
    expect(first.externalJobId).toBe("70001");
    expect(first.title).toBe("Software Engineering Intern");
    expect(first.location).toBe("San Francisco, CA");
    expect(first.jobUrl).toBe("https://boards.greenhouse.io/exampleai/jobs/70001");
    expect(first.applyUrl).toBe(first.jobUrl);
    expect(first.publicationTimeKind).toBe("observed");
    expect(first.sourcePublishedAt).toBeUndefined();
    expect(first.sourceUpdatedAt).toBe("2026-08-14T17:00:00Z");
    expect(first.descriptionPlain).toContain("distributed systems");
    expect(first.descriptionPlain).not.toContain("<");
  });

  it("handles an empty board", async () => {
    const adapter = new GreenhouseAdapter();
    const jobs = await adapter.normalize(company, fixture("list-empty.json"));
    expect(jobs).toEqual([]);
  });

  it("throws malformed on a payload without jobs array", async () => {
    const adapter = new GreenhouseAdapter();
    await expect(adapter.normalize(company, fixture("list-malformed.json"))).rejects.toMatchObject({
      code: "malformed",
    });
  });

  it("skips rows without id or title instead of failing the board", async () => {
    const adapter = new GreenhouseAdapter();
    const jobs = await adapter.normalize(company, {
      jobs: [{ title: "No id" }, { id: 1, title: "" }, { id: 2, title: "Good Job" }],
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.externalJobId).toBe("2");
  });
});

describe("GreenhouseAdapter detail", () => {
  it("upgrades publication time to authoritative when first_published exists", async () => {
    const adapter = new GreenhouseAdapter();
    const detail = fixture("detail-valid.json");
    const job = await adapter.normalizeDetail(company, detail, "70001");
    expect(job).not.toBeNull();
    expect(job!.publicationTimeKind).toBe("authoritative");
    expect(job!.sourcePublishedAt).toBe("2026-08-14T17:00:00Z");
  });

  it("returns null for a detail that does not match the external id", async () => {
    const adapter = new GreenhouseAdapter();
    const job = await adapter.normalizeDetail(company, fixture("detail-valid.json"), "99999");
    expect(job).toBeNull();
  });
});

describe("GreenhouseAdapter fetchBoard failures", () => {
  it("maps 429 to rate_limited", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429));
    const adapter = new GreenhouseAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });

  it("maps 5xx to server_error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 502));
    const adapter = new GreenhouseAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({
      code: "server_error",
      status: 502,
    });
  });

  it("maps timeout to timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const adapter = new GreenhouseAdapter(fetchImpl, 100);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "timeout" });
  });

  it("maps network errors to network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const adapter = new GreenhouseAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "network" });
  });

  it("maps non-JSON bodies to malformed", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    const adapter = new GreenhouseAdapter(fetchImpl);
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
    const adapter = new GreenhouseAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "malformed" });
  });

  it("verifies the request URL encodes the board key", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://boards-api.greenhouse.io/v1/boards/exampleai/jobs");
      return jsonResponse({ jobs: [] });
    });
    const adapter = new GreenhouseAdapter(fetchImpl);
    await adapter.fetchBoard(company);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("AdapterError", () => {
  it("carries code and status", () => {
    const err = new AdapterError("rate_limited", "slow down", 429);
    expect(err.code).toBe("rate_limited");
    expect(err.status).toBe(429);
    expect(err).toBeInstanceOf(Error);
  });
});
