import { describe, expect, it } from "vitest";
import { extractDeadline, parseAbsoluteDate } from "../src/deadline.js";

const NOW = "2026-08-23T22:00:00.000Z";

describe("V3 §5 parseAbsoluteDate", () => {
  it("parses 'August 30, 2026'", () => {
    expect(parseAbsoluteDate("by August 30, 2026")).toBe("2026-08-30T23:59:59.000Z");
  });
  it("parses 'Aug 30' (assumes current year)", () => {
    expect(parseAbsoluteDate("complete by Aug 30")).toMatch(/^2026-08-30T23:59/);
  });
  it("parses '30 August 2026'", () => {
    expect(parseAbsoluteDate("deadline 30 August 2026")).toBe("2026-08-30T23:59:59.000Z");
  });
  it("parses ISO YYYY-MM-DD", () => {
    expect(parseAbsoluteDate("deadline: 2026-09-05")).toBe("2026-09-05T23:59:59.000Z");
  });
  it("returns null for no date", () => {
    expect(parseAbsoluteDate("no dates here")).toBeNull();
  });
});

describe("V3 §5 extractDeadline", () => {
  it("relative days: 'within 5 days'", () => {
    const r = extractDeadline(
      "Complete your online assessment",
      "please complete within 5 days of receipt",
      NOW,
    );
    expect(r.source).toBe("relative_days");
    // 2026-08-23T22:00 + 5d = 2026-08-28T22:00Z
    expect(r.deadlineAt).toBe("2026-08-28T22:00:00.000Z");
  });

  it("business days approximated conservatively (early reminder)", () => {
    const r = extractDeadline("Online Assessment", "you have 3 business days to complete", NOW);
    expect(r.source).toBe("relative_days");
    // 3 business ≈ ceil(21/5)=5 calendar days
    expect(r.deadlineAt).toBe("2026-08-28T22:00:00.000Z");
  });

  it("absolute date with context", () => {
    const r = extractDeadline("Assessment invitation", "please submit by September 15, 2026", NOW);
    expect(r.source).toBe("absolute_date");
    expect(r.deadlineAt).toBe("2026-09-15T23:59:59.000Z");
  });

  it("explicit ISO near deadline word", () => {
    const r = extractDeadline("OA invite", "deadline 2026-09-01 — good luck", NOW);
    expect(r.source).toBe("explicit_iso");
    expect(r.deadlineAt).toBe("2026-09-01T23:59:59.000Z");
  });

  it("no deadline language → null (sweep skips)", () => {
    const r = extractDeadline(
      "Thanks for applying",
      "we got your application and will review",
      NOW,
    );
    expect(r.deadlineAt).toBeNull();
    expect(r.source).toBeNull();
  });

  it("date WITHOUT deadline context does not trigger (false-positive guard)", () => {
    // 'August 30' present but no completion/deadline language nearby.
    const r = extractDeadline(
      "Welcome to our talent community",
      "our next event is August 30",
      NOW,
    );
    // CONTEXT requires words like complete/by/expires — absent here.
    expect(r.deadlineAt).toBeNull();
  });

  it("en-dash and unicode normalization don't break parsing", () => {
    const r = extractDeadline("Assessment", "complete within 2–3 days", NOW);
    expect(r.deadlineAt).not.toBeNull();
  });
});
