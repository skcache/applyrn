import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompanyConfig } from "@applyrn/domain";
import { SmartRecruitersAdapter } from "../src/smartrecruiters/smartrecruiters.js";

const fixture = (name: string): unknown => {
  const p = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "smartrecruiters",
    "fixtures",
    name,
  );
  return JSON.parse(readFileSync(p, "utf8"));
};

const company: CompanyConfig = {
  id: "delivery-hero",
  name: "Delivery Hero",
  provider: "smartrecruiters",
  boardKey: "DeliveryHero",
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

describe("SmartRecruitersAdapter normalize", () => {
  it("maps a valid board fixture to normalized jobs", async () => {
    const adapter = new SmartRecruitersAdapter();
    const jobs = await adapter.normalize(company, fixture("board-valid.json"));
    expect(jobs).toHaveLength(2);
    const first = jobs[0]!;
    expect(first.provider).toBe("smartrecruiters");
    expect(first.companyId).toBe("delivery-hero");
    expect(first.externalJobId).toBe("744000144362911");
    expect(first.title).toBe("Software Engineering Intern");
    expect(first.location).toBe("Denver, CO, United States");
    expect(first.employmentType).toBe("Internship");
    expect(first.department).toBe("Engineering");
    expect(first.sourcePublishedAt).toBe("2026-08-14T16:23:39.776Z");
    // List rows are "observed": the authoritative URL/description comes from detail.
    expect(first.publicationTimeKind).toBe("observed");
    expect(first.jobUrl).toBe("");
    expect(first.applyUrl).toBe("");
  });

  it("fills URL + description + authoritative timestamp from the detail endpoint", async () => {
    const adapter = new SmartRecruitersAdapter();
    const detail = await adapter.normalizeDetail(
      company,
      fixture("detail-valid.json"),
      "744000144362911",
    );
    expect(detail).not.toBeNull();
    expect(detail!.jobUrl).toBe(
      "https://jobs.smartrecruiters.com/DeliveryHero/744000144362911-software-engineering-intern-",
    );
    expect(detail!.applyUrl).toContain("?oga=true");
    expect(detail!.sourcePublishedAt).toBe("2026-08-14T16:23:39.776Z");
    expect(detail!.publicationTimeKind).toBe("authoritative");
    expect(detail!.descriptionPlain).toContain("0-2 years of experience in software engineering");
    expect(detail!.descriptionPlain).toContain("YOUR MISSION");
  });

  it("handles an empty board", async () => {
    const adapter = new SmartRecruitersAdapter();
    expect(await adapter.normalize(company, { content: [] })).toEqual([]);
  });

  it("throws malformed on a payload without a content array", async () => {
    const adapter = new SmartRecruitersAdapter();
    await expect(adapter.normalize(company, {})).rejects.toMatchObject({ code: "malformed" });
  });

  it("skips rows without id or title instead of failing the board", async () => {
    const adapter = new SmartRecruitersAdapter();
    const jobs = await adapter.normalize(company, {
      content: [{ name: "No id" }, { id: "1", name: "" }, { id: "2", name: "Good Job" }],
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.externalJobId).toBe("2");
  });
});

describe("SmartRecruitersAdapter fetch/failures", () => {
  it("builds the list URL with the board key and limit 100", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://api.smartrecruiters.com/v1/companies/DeliveryHero/postings?limit=100&offset=0",
      );
      return jsonResponse({ content: [] });
    });
    const adapter = new SmartRecruitersAdapter(fetchImpl);
    await adapter.fetchBoard(company);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("builds the detail URL with the posting id", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://api.smartrecruiters.com/v1/companies/DeliveryHero/postings/744000144362911",
      );
      return jsonResponse({ id: "744000144362911", name: "x" });
    });
    const adapter = new SmartRecruitersAdapter(fetchImpl);
    await adapter.fetchJobDetail(company, "744000144362911");
  });

  it("maps 429 to rate_limited", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429));
    const adapter = new SmartRecruitersAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });

  it("maps 5xx to server_error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 502));
    const adapter = new SmartRecruitersAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({
      code: "server_error",
      status: 502,
    });
  });

  it("maps network errors to network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const adapter = new SmartRecruitersAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "network" });
  });

  it("maps non-JSON bodies to malformed", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    const adapter = new SmartRecruitersAdapter(fetchImpl);
    await expect(adapter.fetchBoard(company)).rejects.toMatchObject({ code: "malformed" });
  });
});
