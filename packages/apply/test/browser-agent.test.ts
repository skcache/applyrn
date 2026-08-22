import { describe, expect, it } from "vitest";
import { runFillPass, type BrowserLike } from "../src/browser-agent.js";
import type { ApplicationProfile } from "../src/profile.js";

const profile: ApplicationProfile = {
  version: 1,
  answers: [
    { key: "first_name", value: "Siddhant", kind: "factual" },
    { key: "last_name", value: "Kuwar", kind: "factual" },
    { key: "email", value: "me@example.com", kind: "factual" },
    { key: "school", value: "UC San Diego", kind: "factual" },
    { key: "resume", value: "/profile/resume.pdf", kind: "factual" },
  ],
  pausedCategories: [],
  labelStopList: ["salary", "ssn"],
};

/** Fake browser driven by an in-memory page definition. */
function fakeBrowser(
  fields: {
    label: string;
    required?: boolean;
    selector: string;
    acceptValue?: boolean;
  }[],
  opts: { hasNextStep: boolean; uploaded?: string[] } = { hasNextStep: false },
): BrowserLike {
  return {
    async goto() {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evaluate: (async (fn: string) => {
      // The next-step probe runs a snippet mentioning "submit application";
      // the inventory probe serializes the fields list.
      if (fn.includes("submit application")) return opts.hasNextStep;
      return fields.map((f) => ({
        label: f.label,
        required: f.required ?? false,
        type: "text",
        selector: f.selector,
      }));
    }) as never,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evaluateWithArgs: (async () => null) as never,
    async type(selector: string, _value: string) {
      const f = fields.find((x) => x.selector === selector);
      return Boolean(f?.acceptValue ?? true);
    },
    async uploadFile(selector: string, path: string) {
      opts.uploaded?.push(`${selector}:${path}`);
      return true;
    },
    async clickNext() {
      return opts.hasNextStep;
    },
    close: async () => undefined,
  };
}

describe("runFillPass", () => {
  it("fills mapped factual fields and reports them", async () => {
    const browser = fakeBrowser([
      { label: "First name", selector: "#first_name" },
      { label: "Last name", selector: "#last_name" },
      { label: "Email", selector: "#email", required: true },
    ]);
    const result = await runFillPass(browser, profile, { dryRun: true });
    expect(result.filled).toHaveLength(3);
    expect(result.filled.map((f) => f.key)).toEqual(["first_name", "last_name", "email"]);
    expect(result.paused).toHaveLength(0);
    expect(result.hasNextStep).toBe(false);
  });

  it("pauses unknown and stop-list fields with reasons", async () => {
    const browser = fakeBrowser([
      { label: "Email", selector: "#email" },
      { label: "Favorite Kubernetes Feature", selector: "#k8s", required: true },
      { label: "Desired Salary", selector: "#salary" },
    ]);
    const result = await runFillPass(browser, profile, { dryRun: true });
    expect(result.filled).toHaveLength(1);
    expect(result.paused.map((p) => p.reason)).toEqual([
      'unknown field: "Favorite Kubernetes Feature" (required)',
      'stop-list label: "Desired Salary"',
    ]);
    expect(result.paused.find((p) => p.label === "Favorite Kubernetes Feature")?.required).toBe(
      true,
    );
  });

  it("uploads the resume via uploadFile (path stays out of page JS)", async () => {
    const uploaded: string[] = [];
    const browser = fakeBrowser([{ label: "Attach Resume/CV", selector: "#resume_input" }], {
      hasNextStep: false,
      uploaded,
    });
    const result = await runFillPass(browser, profile, {
      resumePath: "/profile/resume.pdf",
      dryRun: false,
    });
    expect(result.filled[0]).toMatchObject({ key: "resume", value: "/profile/resume.pdf" });
    expect(uploaded).toEqual(["#resume_input:/profile/resume.pdf"]);
  });

  it("detects multi-step applications via next-step buttons", async () => {
    const browser = fakeBrowser([{ label: "Email", selector: "#email" }], { hasNextStep: true });
    const result = await runFillPass(browser, profile, { dryRun: true });
    expect(result.hasNextStep).toBe(true);
  });

  it("pauses fields whose type attempt failed on the live page", async () => {
    const browser = fakeBrowser([{ label: "Email", selector: "#email", acceptValue: false }]);
    const result = await runFillPass(browser, profile, { dryRun: false });
    expect(result.filled).toHaveLength(0);
    expect(result.paused[0]?.reason).toContain("type attempt failed");
  });
});
