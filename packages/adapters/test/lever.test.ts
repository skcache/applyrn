import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompanyConfig } from "@applyrn/domain";
import { LeverAdapter } from "../src/lever/lever.js";

const fixture = (name: string): unknown => {
  const p = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "lever",
    "fixtures",
    name,
  );
  return JSON.parse(readFileSync(p, "utf8"));
};

const company: CompanyConfig = {
  id: "example-ai",
  name: "Example AI",
  provider: "lever",
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

describe("LeverAdapter normalize", () => {
  it("maps a valid postings fixture to normalized jobs", async () => {
    const adapter = new LeverAdapter();
    const jobs = await adapter.normalize(company, fixture("postings-valid.json"));
    expect(jobs).toHaveLength(2);
    const first = jobs[0]!;
    expect(first.provider).toBe("lever");
    expect(first.companyId).toBe("example-ai");
    expect(first.externalJobId).toBe("abc123");
    expect(first.title).toBe("Software Engineering Intern");
    expect(first.location).toBe("San Francisco, Remote");
    expect(first.employmentType).toBe("Internship");
    expect(first.department).toBe("Engineering");
    expect(first.team).toBe("Platform");
    expect(first.jobUrl).toBe("https://jobs.lever.co/exampleai/abc123");
    expect(first.applyUrl).toBe("https://jobs.lever.co/exampleai/abc123/apply");
  });

  it("never claims an authoritative publication time (observed semantics)", async () => {
    const adapter = new LeverAdapter();
    const jobs = await adapter.normalize(company, fixture("postings-valid.json"));
    for (const job of jobs) {
      expect(job.publicationTimeKind).toBe("observed");
      expect(job.sourcePublishedAt).toBeUndefined();
    }
  });

  it("handles an empty board", async () => {
    const adapter = new LeverAdapter();
    expect(await adapter.normalize(company, fixture("postings-empty.json"))).toEqual([]);
  });

  it("throws malformed on a non-array payload", async () => {
    const adapter = new LeverAdapter();
    await expect(
      adapter.normalize(company, fixture("postings-malformed.json")),
    ).rejects.toMatchObject({
      code: "malformed",
    });
  });

  it("skips rows without id or text instead of failing the board", async () => {
    const adapter = new LeverAdapter();
    const jobs = await adapter.normalize(company, [
      { text: "No id" },
      { id: "1", text: "" },
      { id: "2", text: "Good Job" },
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.externalJobId).toBe("2");
  });
});

describe("LeverAdapter fetchBoard failures", () => {
  it("maps 429 to rate_limited", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429));
    const adapter = new LeverAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });

  it("maps 5xx to server_error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const adapter = new LeverAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({
      code: "server_error",
      status: 503,
    });
  });

  it("maps timeout to timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const adapter = new LeverAdapter(fetchImpl, 100);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "timeout" });
  });

  it("maps network errors to network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const adapter = new LeverAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "network" });
  });

  it("maps non-JSON bodies to malformed", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    const adapter = new LeverAdapter(fetchImpl);
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
    const adapter = new LeverAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "malformed" });
  });

  it("verifies the request URL encodes the board key and mode=json", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.lever.co/v0/postings/exampleai?mode=json");
      return jsonResponse([]);
    });
    const adapter = new LeverAdapter(fetchImpl);
    await adapter.fetchBoard(company);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
