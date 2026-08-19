import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompanyConfig } from "@applyrn/domain";
import { WorkdayAdapter, parseWorkdayBoardKey } from "../src/workday/workday.js";

const fixture = (name: string): unknown => {
  const p = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "workday",
    "fixtures",
    name,
  );
  return JSON.parse(readFileSync(p, "utf8"));
};

const company: CompanyConfig = {
  id: "abc-fws",
  name: "ABC FWS",
  provider: "workday",
  boardKey: "abcfws.wd1.myworkdayjobs.com:abcfws",
  enabled: true,
  pollIntervalSeconds: 120,
  createdAt: "2026-08-19T00:00:00Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("WorkdayAdapter normalize", () => {
  it("maps a valid board fixture to normalized jobs", async () => {
    const adapter = new WorkdayAdapter();
    const jobs = await adapter.normalize(company, fixture("board-valid.json"));
    expect(jobs).toHaveLength(2);
    const first = jobs[0]!;
    expect(first.provider).toBe("workday");
    expect(first.companyId).toBe("abc-fws");
    expect(first.externalJobId).toBe("JR107566");
    expect(first.title).toBe("Software Engineering Intern");
    expect(first.location).toBe("Seattle, WA; Remote");
    expect(first.jobUrl).toBe(
      "https://abcfws.wd1.myworkdayjobs.com/job/Seattle-WA/Software-Engineering-Intern_JR107566",
    );
    expect(first.applyUrl).toBe(first.jobUrl);
    expect(first.publicationTimeKind).toBe("observed");
    expect(first.compensationText).toBe("Posted Posted Today");
  });

  it("falls back to the externalPath slug when there is no bullet field", async () => {
    const adapter = new WorkdayAdapter();
    const jobs = await adapter.normalize(company, {
      total: 1,
      jobPostings: [
        {
          title: "Data Engineer",
          externalPath: "/job/NY/Data-Engineer_12345",
          locationsText: "New York, NY",
        },
      ],
    });
    expect(jobs[0]!.externalJobId).toBe("/job/NY/Data-Engineer_12345");
  });

  it("handles an empty board", async () => {
    const adapter = new WorkdayAdapter();
    expect(await adapter.normalize(company, fixture("board-empty.json"))).toEqual([]);
  });

  it("skips rows without title or externalPath", async () => {
    const adapter = new WorkdayAdapter();
    const jobs = await adapter.normalize(company, {
      total: 2,
      jobPostings: [
        { title: "No path" },
        { externalPath: "/job/x/No-title" },
        { title: "Good", externalPath: "/job/x/Good_JR1" },
      ],
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.title).toBe("Good");
  });
});

describe("WorkdayAdapter fetchBoard", () => {
  it("POSTs the CXS jobs endpoint with tenant + site id + JSON body", async () => {
    const fetchImpl = vi.fn(
      async (url: string, init: RequestInit | undefined): Promise<Response> => {
        expect(url).toBe(
          "https://abcfws.wd1.myworkdayjobs.com/wday/cxs/abcfws.wd1.myworkdayjobs.com/abcfws/jobs",
        );
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ searchText: "", limit: 100, offset: 0 });
        expect((init?.headers as Record<string, string> | undefined)?.["Accept-Language"]).toBe(
          "en-US",
        );
        return jsonResponse({ total: 0, jobPostings: [] });
      },
    );
    const adapter = new WorkdayAdapter(fetchImpl);
    await adapter.fetchBoard(company);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("maps 429 to rate_limited", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429));
    const adapter = new WorkdayAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("maps 5xx to server_error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 502));
    const adapter = new WorkdayAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "server_error" });
  });

  it("maps non-JSON bodies to malformed", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    const adapter = new WorkdayAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "malformed" });
  });
});

describe("parseWorkdayBoardKey", () => {
  it("splits host:site into origin/tenant/siteId", () => {
    expect(parseWorkdayBoardKey("abcfws.wd1.myworkdayjobs.com:abcfws")).toEqual({
      origin: "https://abcfws.wd1.myworkdayjobs.com",
      tenant: "abcfws.wd1.myworkdayjobs.com",
      siteId: "abcfws",
    });
  });

  it("defaults siteId to the tenant when omitted", () => {
    const k = parseWorkdayBoardKey("acme.wd2.myworkdayjobs.com");
    expect(k.siteId).toBe("acme.wd2.myworkdayjobs.com");
  });
});
