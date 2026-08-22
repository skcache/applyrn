import { describe, expect, it } from "vitest";
import {
  approveRun,
  approveSubmission,
  InvalidTransitionError,
  recordFillPass,
  resolvePauses,
  transition,
  type ApplicationSession,
} from "../src/session.js";
import {
  canonicalKeyForLabel,
  classifyKey,
  planField,
  type ApplicationProfile,
} from "../src/profile.js";

const baseSession: ApplicationSession = {
  id: "s1",
  jobId: "j1",
  company: "Example AI",
  jobTitle: "Software Engineer Intern",
  applyUrl: "https://boards.greenhouse.io/exampleai/jobs/70001",
  status: "pending_approval",
  createdAt: "2026-08-22T00:00:00Z",
  updatedAt: "2026-08-22T00:00:00Z",
  filled: [],
  paused: [],
};

const profile: ApplicationProfile = {
  version: 1,
  answers: [
    { key: "first_name", value: "Siddhant", kind: "factual" },
    { key: "last_name", value: "Kuwar", kind: "factual" },
    { key: "email", value: "me@example.com", kind: "factual" },
    { key: "phone", value: "+1 555 0100", kind: "factual" },
    { key: "linkedin", value: "https://linkedin.com/in/example", kind: "factual" },
    { key: "github", value: "https://github.com/example", kind: "factual" },
    { key: "school", value: "UC San Diego", kind: "factual" },
    { key: "grad_year", value: "2027", kind: "factual" },
    {
      key: "why_company",
      value: "I want to build here because...",
      kind: "statement",
    },
  ],
  pausedCategories: [],
  labelStopList: ["ssn", "salary", "signature"],
};

describe("profile field mapping", () => {
  it("maps common labels to canonical keys", () => {
    expect(canonicalKeyForLabel("First name*")).toBe("first_name");
    expect(canonicalKeyForLabel("E-mail Address")).toBe("email");
    expect(canonicalKeyForLabel("LinkedIn Profile URL")).toBe("linkedin");
    expect(canonicalKeyForLabel("Upload Resume/CV")).toBe("resume");
    expect(canonicalKeyForLabel("What is your favorite color?")).toBeNull();
  });

  it("classifies sensitive/statement keys", () => {
    expect(classifyKey("salary")).toBe("sensitive");
    expect(classifyKey("work_authorization")).toBe("sensitive");
    expect(classifyKey("cover_letter")).toBe("statement");
    expect(classifyKey("email")).toBe("factual");
  });

  it("fills factual fields with profile answers", () => {
    const plan = planField({ label: "Email", required: true }, profile);
    expect(plan).toEqual({ action: "fill", key: "email", value: "me@example.com" });
  });

  it("pauses on stop-list labels even when a synonym would match", () => {
    // "Expected Salary" contains the synonym for salary anyway, but prove
    // the stop-list wins over any mapping.
    const plan = planField({ label: "Desired Salary Expectations", required: true }, profile);
    expect(plan.action).toBe("pause");
    if (plan.action === "pause") expect(plan.reason).toContain("stop-list");
  });

  it("pauses unknown fields and reports them", () => {
    const plan = planField({ label: "Favorite Kubernetes Feature", required: false }, profile);
    expect(plan).toEqual({
      action: "pause",
      key: null,
      reason: 'unknown field: "Favorite Kubernetes Feature"',
    });
  });

  it("pauses sensitive keys regardless of profile content", () => {
    const p: ApplicationProfile = {
      ...profile,
      answers: [
        ...profile.answers,
        { key: "salary", value: "$999k", kind: "sensitive" }, // even if present
      ],
      // Remove "salary" from the stop list so the sensitive-classification
      // branch is what catches it (stop-list is tested separately).
      labelStopList: ["ssn", "signature"],
    };
    const plan = planField({ label: "Salary Expectations", required: true }, p);
    expect(plan).toEqual({ action: "pause", key: "salary", reason: "sensitive: salary" });
  });

  it("honors paused categories", () => {
    const p: ApplicationProfile = {
      ...profile,
      pausedCategories: ["statement"],
    };
    const plan = planField({ label: "Why do you want to work here?", required: true }, p);
    expect(plan).toEqual({
      action: "pause",
      key: "why_company",
      reason: "category paused: statement",
    });
  });
});

describe("session state machine", () => {
  it("walks the happy path: approve -> fill -> review -> submit -> submitted", () => {
    let s = approveRun(baseSession);
    s = recordFillPass(s, [{ key: "email", label: "Email", value: "me@example.com" }], []);
    expect(s.status).toBe("review");
    s = approveSubmission(s);
    expect(s.status).toBe("submitting");
    s = transition(s, "submitted");
    expect(s.status).toBe("submitted");
  });

  it("stops at paused when fields block, resumes after resolutions", () => {
    let s = approveRun(baseSession);
    s = recordFillPass(
      s,
      [{ key: "email", label: "Email", value: "me@example.com" }],
      [{ label: "Are you 18?", key: null, reason: 'unknown field: "Are you 18?"', required: true }],
    );
    expect(s.status).toBe("paused");
    expect(s.paused).toHaveLength(1);
    s = resolvePauses(s, { "Are you 18?": "Yes" });
    expect(s.status).toBe("review");
    expect(s.filled.some((f) => f.label === "Are you 18?" && f.value === "Yes")).toBe(true);
    expect(s.paused).toHaveLength(0);
  });

  it("refuses illegal transitions", () => {
    expect(() => approveSubmission(baseSession)).toThrow(InvalidTransitionError);
    expect(() => transition(baseSession, "submitted")).toThrow(InvalidTransitionError);
    const done = transition(
      approveSubmission(recordFillPass(approveRun(baseSession), [], [])),
      "submitted",
    );
    expect(() => transition(done, "filling")).toThrow(InvalidTransitionError);
  });

  it("never reaches submitting except from review (the human gate)", () => {
    let s = approveRun(baseSession);
    s = recordFillPass(
      s,
      [],
      [{ label: "SSN", key: null, reason: "stop-list label", required: true }],
    );
    expect(s.status).toBe("paused");
    expect(() => transition(s, "submitting")).toThrow(InvalidTransitionError);
  });
});
