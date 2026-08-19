import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompanyConfig } from "@applyrn/domain";
import { TaleoAdapter, parseTaleoBoardKey } from "../src/oracle/oracle.js";

const fixture = (name: string): unknown => {
  const p = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "oracle",
    "fixtures",
    name,
  );
  return JSON.parse(readFileSync(p, "utf8"));
};

const company: CompanyConfig = {
  id: "vw-america",
  name: "Volkswagen Group of America",
  provider: "oracle",
  boardKey: "vwgoa.taleo.net:volkswagen_of_america:10240752087:en",
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

describe("TaleoAdapter normalize", () => {
  it("maps a valid board fixture to normalized jobs", async () => {
    const adapter = new TaleoAdapter();
    const jobs = await adapter.normalize(company, fixture("board-valid.json"));
    expect(jobs).toHaveLength(2);
    const first = jobs[0]!;
    expect(first.provider).toBe("oracle");
    expect(first.companyId).toBe("vw-america");
    expect(first.externalJobId).toBe("JR107566");
    expect(first.title).toBe("Software Engineering Intern");
    expect(first.location).toBe("Titusville, FL");
    expect(first.publicationTimeKind).toBe("observed");
    expect(first.jobUrl).toBe(
      "https://vwgoa.taleo.net/careersection/volkswagen_of_america/jobdetail.ftl?job=JR107566&lang=en&portal=10240752087",
    );
    expect(first.applyUrl).toBe(first.jobUrl);
  });

  it("joins multiple location parts from a JSON locations column", async () => {
    const adapter = new TaleoAdapter();
    const jobs = await adapter.normalize(company, {
      requisitionList: [
        {
          jobId: "JR9",
          contestNo: "JR9",
          column: ["Data Engineer", '["Remote", "United States"]'],
          locationsColumns: [1],
          linkedColumn: 0,
        },
      ],
      pagingData: { totalCount: 1 },
    });
    expect(jobs[0]!.title).toBe("Data Engineer");
    expect(jobs[0]!.location).toBe("Remote, United States");
  });

  it("handles an empty board", async () => {
    const adapter = new TaleoAdapter();
    expect(await adapter.normalize(company, { requisitionList: [] })).toEqual([]);
  });

  it("skips rows without a jobId or a linked title column", async () => {
    const adapter = new TaleoAdapter();
    const jobs = await adapter.normalize(company, {
      requisitionList: [
        { contestNo: "JR1", column: ["No jobId"] },
        { jobId: "JR2", column: [] },
        { jobId: "JR3", contestNo: "JR3", column: ["Good Job"] },
      ],
      pagingData: { totalCount: 1 },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.externalJobId).toBe("JR3");
  });
});

describe("TaleoAdapter fetchBoard", () => {
  it("POSTs the searchjobs endpoint with lang + portal + page JSON", async () => {
    const fetchImpl = vi.fn(
      async (url: string, init: RequestInit | undefined): Promise<Response> => {
        expect(url).toBe(
          "https://vwgoa.taleo.net/careersection/rest/jobboard/searchjobs?lang=en&portal=10240752087",
        );
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ pageNo: 1, activeFilterId: undefined });
        return jsonResponse({ requisitionList: [], pagingData: { totalCount: 0 } });
      },
    );
    const adapter = new TaleoAdapter(fetchImpl);
    await adapter.fetchBoard(company);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("maps an HTML error envelope to malformed", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html><body>An Error Occurred in TEE</body></html>", { status: 200 }),
    );
    const adapter = new TaleoAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "malformed" });
  });

  it("maps 429 to rate_limited", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429));
    const adapter = new TaleoAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("maps 400/404 to server_error", async () => {
    for (const status of [400, 404, 502]) {
      const fetchImpl = vi.fn(async () => jsonResponse({}, status));
      const adapter = new TaleoAdapter(fetchImpl);
      await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "server_error" });
    }
  });

  it("maps network errors to network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    const adapter = new TaleoAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "network" });
  });
});

describe("parseTaleoBoardKey", () => {
  it("splits host:section:portal:lang", () => {
    expect(parseTaleoBoardKey("vwgoa.taleo.net:volkswagen_of_america:10240752087:en")).toEqual({
      origin: "https://vwgoa.taleo.net",
      section: "volkswagen_of_america",
      portal: "10240752087",
      lang: "en",
    });
  });

  it("defaults lang to en when omitted", () => {
    const k = parseTaleoBoardKey("acme.taleo.net:2:1234");
    expect(k.lang).toBe("en");
    expect(k.section).toBe("2");
    expect(k.portal).toBe("1234");
  });
});
