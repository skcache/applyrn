import { describe, expect, it } from "vitest";
import type { CompanyConfig, JobRecord, NormalizedJob } from "@applyrn/domain";
import { contentHash } from "@applyrn/domain";
import { detectJobs, shouldAlert, shouldPersist, INACTIVE_AFTER_ABSENCES } from "../src/engine.js";

const company: CompanyConfig = {
  id: "example-ai",
  name: "Example AI",
  provider: "greenhouse",
  boardKey: "exampleai",
  enabled: true,
  pollIntervalSeconds: 120,
  createdAt: "2026-08-14T00:00:00Z",
};

function job(externalJobId: string, overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    provider: "greenhouse",
    companyId: "example-ai",
    externalJobId,
    title: "SWE Intern",
    jobUrl: `https://boards.greenhouse.io/exampleai/jobs/${externalJobId}`,
    applyUrl: `https://boards.greenhouse.io/exampleai/jobs/${externalJobId}`,
    publicationTimeKind: "observed",
    ...overrides,
  };
}

async function record(
  j: NormalizedJob,
  status: JobRecord["status"],
  overrides: Partial<JobRecord> = {},
): Promise<JobRecord> {
  return {
    id: `id-${j.externalJobId}`,
    companyId: j.companyId,
    provider: j.provider,
    externalJobId: j.externalJobId,
    title: j.title,
    jobUrl: j.jobUrl,
    applyUrl: j.applyUrl,
    publicationTimeKind: j.publicationTimeKind,
    firstSeenAt: "2026-08-14T00:00:00Z",
    detectedAt: "2026-08-14T00:00:00Z",
    lastSeenAt: "2026-08-14T00:00:00Z",
    contentHash: await contentHash(j),
    status,
    absentCount: 0,
    ...overrides,
  };
}

const NOW = "2026-08-14T12:00:00Z";
describe("detectJobs", () => {
  it("first run: every fetched job is baseline and nothing alerts", async () => {
    const fetched = [job("1"), job("2")];
    const decisions = await detectJobs({ company, fetched, existing: [], firstRun: true });
    expect(decisions.map((d) => d.kind)).toEqual(["baseline", "baseline"]);
    expect(decisions.every(shouldPersist)).toBe(true);
    expect(decisions.some(shouldAlert)).toBe(false);
  });

  it("unseen job after baseline is new exactly once", async () => {
    const existing = [await record(job("1"), "baseline")];
    const decisions = await detectJobs({
      company,
      fetched: [job("1"), job("2")],
      existing,
      firstRun: false,
    });
    expect(decisions.find((d) => d.kind === "new")?.kind).toBe("new");
    const newDecision = decisions.find((d) => d.kind === "new");
    expect(newDecision && shouldAlert(newDecision)).toBe(true);
  });

  it("replaying the same board 100 times yields zero new/alert decisions", async () => {
    const fetched = [job("1"), job("2"), job("3")];
    let existing = [
      await record(job("1"), "new"),
      await record(job("2"), "baseline"),
      await record(job("3"), "active"),
    ];
    for (let i = 0; i < 100; i++) {
      const decisions = await detectJobs({ company, fetched, existing, firstRun: false });
      expect(decisions.filter(shouldAlert)).toHaveLength(0);
      expect(decisions.every((d) => d.kind === "unchanged")).toBe(true);
      // Simulate the repo layer applying the decisions.
      existing = existing.map((r) => ({ ...r, lastSeenAt: NOW, absentCount: 0 }));
    }
  });

  it("edited job is edited, not a new alert", async () => {
    const original = job("1");
    const existing = [await record(original, "active")];
    const edited = job("1", { location: "Remote" });
    const decisions = await detectJobs({ company, fetched: [edited], existing, firstRun: false });
    const editedDecision = decisions.find((d) => d.kind === "edited");
    expect(editedDecision).toBeDefined();
    expect(shouldAlert(editedDecision!)).toBe(false);
    expect(shouldPersist(editedDecision!)).toBe(true);
  });

  it("a job absent once is missing but not inactive", async () => {
    const existing = [await record(job("1"), "active", { absentCount: 0 })];
    const decisions = await detectJobs({ company, fetched: [], existing, firstRun: false });
    const missing = decisions.find((d) => d.kind === "missing");
    expect(missing).toBeDefined();
    expect(missing!.kind).toBe("missing");
    expect((missing as { absentCount: number }).absentCount).toBe(1);
    expect((missing as { nowInactive: boolean }).nowInactive).toBe(false);
  });

  it("a job absent twice becomes inactive", async () => {
    const existing = [
      await record(job("1"), "active", { absentCount: INACTIVE_AFTER_ABSENCES - 1 }),
    ];
    const decisions = await detectJobs({ company, fetched: [], existing, firstRun: false });
    const missing = decisions.find((d) => d.kind === "missing");
    expect((missing as { nowInactive: boolean }).nowInactive).toBe(true);
    expect((missing as { absentCount: number }).absentCount).toBe(INACTIVE_AFTER_ABSENCES);
  });

  it("an inactive job that reappears is reopened and alerts again", async () => {
    const existing = [await record(job("1"), "inactive")];
    const decisions = await detectJobs({ company, fetched: [job("1")], existing, firstRun: false });
    const reopened = decisions.find((d) => d.kind === "reopened");
    expect(reopened).toBeDefined();
    expect(shouldAlert(reopened!)).toBe(true);
  });

  it("already-inactive jobs absent again produce no decision", async () => {
    const existing = [await record(job("1"), "inactive")];
    const decisions = await detectJobs({ company, fetched: [], existing, firstRun: false });
    expect(decisions).toHaveLength(0);
  });

  it("decisions are deterministic across runs", async () => {
    const existing = [await record(job("1"), "active"), await record(job("2"), "active")];
    const input = {
      company,
      fetched: [job("2", { location: "Remote" }), job("3")],
      existing,
      firstRun: false,
    };
    const a = await detectJobs(input);
    const b = await detectJobs(input);
    expect(a.map((d) => decisionLabel(d))).toEqual(b.map((d) => decisionLabel(d)));
  });
});

function decisionLabel(d: { kind: string; job?: NormalizedJob; externalJobId?: string }): string {
  const id = d.job?.externalJobId ?? d.externalJobId ?? "";
  return `${d.kind}:${id}`;
}
