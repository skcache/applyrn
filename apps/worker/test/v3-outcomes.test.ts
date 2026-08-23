import { describe, expect, it } from "vitest";
import {
  COMPANY_MATCH_THRESHOLD,
  companyTokenSimilarity,
  matchEmailToApplication,
  normalizeCompany,
  senderDomain,
} from "../src/matcher.js";
import { canWithdraw, planTransition } from "../src/lifecycle.js";
import { NOTIFY_TIERS } from "../src/gmail.js";

describe("V3 §2 matcher", () => {
  it("normalizes company names (suffixes, punctuation, case)", () => {
    expect(normalizeCompany("Acme Corp., Inc.")).toBe("acme");
    expect(normalizeCompany("  Acme   Robotics ")).toBe("acme robotics");
  });

  it("extracts sender domain from From header", () => {
    expect(senderDomain("Jane <noreply@acme.myworkday.com>")).toBe("acme.myworkday.com");
    expect(senderDomain(null)).toBeNull();
  });

  it("tier-1: exact sender-domain hit links without token checks", () => {
    const r = matchEmailToApplication(
      "acme.myworkday.com",
      "Completely unrelated subject about nothing at all",
      { id: 7, company: "Acme", role: null },
      [{ id: 8, company: "Beta", role: null }],
    );
    expect(r).toEqual({ linked: true, applicationId: 7, tier: "domain" });
  });

  it("tier-2: company-token overlap in subject links when no domain hit", () => {
    const r = matchEmailToApplication(
      "noreply@vendor.example",
      "We received your application for Software Engineer Intern at Globex",
      null,
      [
        { id: 3, company: "Globex Corporation", role: null },
        { id: 4, company: "Initech", role: null },
      ],
    );
    expect(r).toEqual({ linked: true, applicationId: 3, tier: "company" });
  });

  it("no link when nothing overlaps → new application row is correct", () => {
    const r = matchEmailToApplication(
      "noreply@vendor.example",
      "Your assessment for Umbrella Corp",
      null,
      [{ id: 9, company: "Initech", role: null }],
    );
    // 'umbrella corp' vs 'initech' — no overlap
    expect(r).toEqual({ linked: false });
  });

  it("similarity floor is strict (0.5) — weak overlaps do not link", () => {
    // one shared token out of many
    const sim = companyTokenSimilarity("Meta Platforms", "Metamask Digital");
    if (sim >= COMPANY_MATCH_THRESHOLD) throw new Error(`expected below threshold, got ${sim}`);
  });

  it("suffix normalization makes 'Globex Inc' == 'Globex'", () => {
    expect(companyTokenSimilarity("Globex Inc", "GLOBEX")).toBeGreaterThanOrEqual(
      COMPANY_MATCH_THRESHOLD,
    );
  });
});

describe("V3 §2 lifecycle", () => {
  it("promotes legal forward transitions", () => {
    expect(planTransition("APPLIED", "assessment_invite")).toEqual({ action: "promote", to: "OA" });
    expect(planTransition("APPLIED", "interview_invite")).toEqual({
      action: "promote",
      to: "INTERVIEW",
    });
    expect(planTransition("OA", "interview_invite")).toEqual({
      action: "promote",
      to: "INTERVIEW",
    });
    expect(planTransition("INTERVIEW", "offer")).toEqual({ action: "promote", to: "OFFER" });
    expect(planTransition("INTERVIEW", "rejection")).toEqual({ action: "promote", to: "REJECTED" });
  });

  it("no-ops duplicate events (idempotency)", () => {
    expect(planTransition("OA", "assessment_invite").action).toBe("noop");
    expect(planTransition("REJECTED", "rejection").action).toBe("noop");
  });

  it("no-ops illegal backward/skipping transitions", () => {
    expect(planTransition("OFFER", "rejection").action).toBe("noop"); // offer terminal-positive
    expect(planTransition("REJECTED", "interview_invite").action).toBe("noop"); // dead is dead
    expect(planTransition("OA", "application_confirmation").action).toBe("noop"); // never backwards
  });

  it("unclassified events have no mapping", () => {
    expect(planTransition("APPLIED", "unclassified").action).toBe("noop");
  });

  it("withdrawal allowed except from OFFER", () => {
    expect(canWithdraw("APPLIED")).toBe(true);
    expect(canWithdraw("OA")).toBe(true);
    expect(canWithdraw("OFFER")).toBe(false);
    expect(canWithdraw("WITHDRAWN")).toBe(false);
  });
});

describe("V3 §2 notification tiers", () => {
  it("tier-1 events are audible, tier-2/3 silent", () => {
    expect(NOTIFY_TIERS.interview_invite.silent).toBe(false);
    expect(NOTIFY_TIERS.offer.silent).toBe(false);
    expect(NOTIFY_TIERS.rejection.silent).toBe(true);
    expect(NOTIFY_TIERS.application_confirmation.silent).toBe(true);
    expect(NOTIFY_TIERS.assessment_invite.silent).toBe(true);
  });

  it("every classified event has a tier", () => {
    for (const cls of [
      "application_confirmation",
      "assessment_invite",
      "interview_invite",
      "rejection",
      "offer",
    ]) {
      expect(NOTIFY_TIERS[cls]).toBeDefined();
    }
  });
});
