import { describe, expect, it } from "vitest";
import { contentHash, jobId } from "../src/hash.js";

describe("hash helpers", () => {
  it("jobId is deterministic for the same triple", async () => {
    const a = await jobId("greenhouse", "example-ai", "70001");
    const b = await jobId("greenhouse", "example-ai", "70001");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("jobId differs when any component differs", async () => {
    const a = await jobId("greenhouse", "example-ai", "70001");
    const b = await jobId("greenhouse", "example-ai", "70002");
    const c = await jobId("ashby", "example-ai", "70001");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("contentHash is stable for equal material fields", async () => {
    const job = { title: "SWE Intern", location: "SF", employmentType: "Internship" };
    const a = await contentHash(job);
    const b = await contentHash({ ...job, team: undefined });
    expect(a).toBe(b);
  });

  it("contentHash changes on material field edit", async () => {
    const a = await contentHash({ title: "SWE Intern", location: "SF" });
    const b = await contentHash({ title: "SWE Intern", location: "Remote" });
    expect(a).not.toBe(b);
  });
});
