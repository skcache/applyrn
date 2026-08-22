import { describe, expect, it } from "vitest";
import { ApplicationRunner, type RunnerHooks } from "../src/runner.js";
import type { ApplicationProfile } from "../src/profile.js";
import type { ApplicationSession } from "../src/session.js";
import type { BrowserLike } from "../src/browser-agent.js";

const profile: ApplicationProfile = {
  version: 1,
  answers: [
    { key: "first_name", value: "Siddhant", kind: "factual" },
    { key: "email", value: "me@example.com", kind: "factual" },
  ],
  pausedCategories: [],
  labelStopList: ["salary"],
};

type FakePage = {
  fields?: { label: string; required?: boolean; selector: string }[];
  hasNextStep?: boolean;
  submitted?: boolean;
};

function fakeBrowserFactory(page: FakePage) {
  const calls: string[] = [];
  const factory = async (): Promise<BrowserLike> => ({
    async goto(url) {
      calls.push(`goto:${url}`);
    },

    evaluate: (async (fn: string) => {
      if (fn.includes("submit application")) return page.hasNextStep ?? false;
      if (fn.includes("btn.click()")) {
        page.submitted = true;
        return true;
      }
      return (page.fields ?? []).map((f) => ({
        label: f.label,
        required: f.required ?? false,
        type: "text",
        selector: f.selector,
      }));
    }) as never,

    evaluateWithArgs: (async () => null) as never,
    async type(selector) {
      calls.push(`type:${selector}`);
      return true;
    },
    async uploadFile(selector, p) {
      calls.push(`upload:${selector}:${p}`);
      return true;
    },
    async clickNext() {
      return false;
    },
    close: async () => undefined,
  });
  return { factory, calls };
}

function hooks() {
  const messages: string[] = [];
  const actions: string[][][] = [];
  const saved: ApplicationSession[] = [];
  const h: RunnerHooks = {
    notify: async (message, opts) => {
      messages.push(message);
      if (opts?.actions) actions.push(opts.actions);
    },
    saveSession: async (s) => {
      saved.push(s);
    },
  };
  return { h, messages, actions, saved };
}

describe("ApplicationRunner", () => {
  it("creates a pending session and announces with APPROVE buttons", async () => {
    const { h, messages, actions } = hooks();
    const r = new ApplicationRunner(h, fakeBrowserFactory({}).factory);
    const s = await r.createSession({
      id: "s1",
      jobId: "j1",
      company: "Example AI",
      jobTitle: "Software Engineer Intern",
      applyUrl: "https://x",
    });
    expect(s.status).toBe("pending_approval");
    expect(messages[0]).toContain("Ready to apply");
    expect(actions[0]?.[0]?.[0]).toBe("APPROVE s1");
  });

  it("full happy path: approve -> fills -> review -> submit -> submitted + APPLIED", async () => {
    const page: FakePage = {
      fields: [
        { label: "First name", selector: "#fn" },
        { label: "Email", selector: "#email", required: true },
      ],
      hasNextStep: false,
    };
    const { factory, calls } = fakeBrowserFactory(page);
    const { h, messages } = hooks();
    let s = await new ApplicationRunner(h, factory).createSession({
      id: "s1",
      jobId: "j1",
      company: "Example AI",
      jobTitle: "SE Intern",
      applyUrl: "https://x",
    });

    // Telegram callback arrives.
    const runner = new ApplicationRunner(h, factory);
    s = (await runner.handleAction({ kind: "approve", sessionId: "s1" }, async () => s, {
      profile,
    }))!;
    expect(s.status).toBe("review");
    expect(s.filled.map((f) => f.key)).toEqual(["first_name", "email"]);
    expect(messages.some((m) => m.includes("Review before submit"))).toBe(true);

    // Human approves submission.
    s = (await runner.handleAction({ kind: "submit", sessionId: "s1" }, async () => s))!;
    expect(s.status).toBe("submitted");
    expect(page.submitted).toBe(true);
    expect(calls.some((c) => c.startsWith("goto:https://x"))).toBe(true);
  });

  it("pauses on unknown/sensitive fields and resumes after answers", async () => {
    const page: FakePage = {
      fields: [
        { label: "Email", selector: "#email" },
        { label: "Desired Salary", selector: "#sal" },
      ],
    };
    const { factory } = fakeBrowserFactory(page);
    const { h, messages } = hooks();
    const runner = new ApplicationRunner(h, factory);
    let s = await runner.createSession({
      id: "s2",
      jobId: "j2",
      company: "Example AI",
      jobTitle: "SE Intern",
      applyUrl: "https://y",
    });
    s = (await runner.handleAction({ kind: "approve", sessionId: "s2" }, async () => s, {
      profile,
    }))!;
    expect(s.status).toBe("paused");
    expect(s.paused[0]?.label).toBe("Desired Salary");
    expect(messages.some((m) => m.includes("need your input"))).toBe(true);

    // Human replies via the resume action.
    s = (await runner.handleAction(
      { kind: "resume", sessionId: "s2", answers: { "Desired Salary": "$120k" } },
      async () => s,
    ))!;
    expect(s.status).toBe("review");
    expect(s.filled.some((f) => f.label === "Desired Salary")).toBe(true);
  });

  it("abandon works from any live state and notifies", async () => {
    const { factory } = fakeBrowserFactory({});
    const { h, messages } = hooks();
    const runner = new ApplicationRunner(h, factory);
    let s = await runner.createSession({
      id: "s3",
      jobId: "j3",
      company: "C",
      jobTitle: "T",
      applyUrl: "https://z",
    });
    s = (await runner.handleAction({ kind: "abandon", sessionId: "s3" }, async () => s))!;
    expect(s.status).toBe("abandoned");
    expect(messages.some((m) => m.includes("Abandoned"))).toBe(true);
  });
});
