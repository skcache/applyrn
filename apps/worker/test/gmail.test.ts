import { describe, expect, it } from "vitest";
import {
  ATS_DOMAINS,
  classifyEmail,
  extractMessageParts,
  parseFrom,
  toSnippet,
} from "../src/gmail.js";

describe("V3 §1 classifier", () => {
  it("classifies interview invites (word-boundary safe)", () => {
    const r = classifyEmail(
      "noreply@myworkday.com",
      "Your interview with Acme Corp — Recruiting Screen",
      "schedule time",
    );
    expect(r.eventClass).toBe("interview_invite");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("classifies rejections including euphemisms", () => {
    for (const subject of ["Update on your application", "Your application to Acme"]) {
      const r = classifyEmail(
        "notifications@smartrecruiters.com",
        `${subject}`,
        "we have decided to move forward with other candidates unfortunately",
      );
      expect(r.eventClass).toBe("rejection");
    }
  });

  it("classifies HackerRank / CodeSignal assessment invites", () => {
    for (const from of ["noreply@hackerrank.com", "noreply@codesignal.com"]) {
      const r = classifyEmail(from, "Complete your online assessment", "");
      expect(r.eventClass).toBe("assessment_invite");
    }
  });

  it("classifies offers via DocuSign sender + subject", () => {
    const r = classifyEmail(
      "dse@docusign.net",
      "Acme Corp: Please review and sign your offer letter",
      "",
    );
    expect(r.eventClass).toBe("offer");
    // ATS domain boost applies
    expect(r.confidence).toBeGreaterThan(0.95);
  });

  it("classifies application confirmations", () => {
    const r = classifyEmail(
      "no-reply@jobs.lever.co",
      "We received your application for Software Engineer Intern",
      "",
    );
    expect(r.eventClass).toBe("application_confirmation");
  });

  it("returns unclassified for noise, low confidence", () => {
    const r = classifyEmail("friend@gmail.com", "lunch tomorrow?", "");
    expect(r.eventClass).toBe("unclassified");
    expect(r.confidence).toBe(0);
  });

  it("ATS domain boosts subject-tier confidence by 0.05", () => {
    const ats = classifyEmail("noreply@ashbyhq.com", "Interview invitation", "");
    const nonAts = classifyEmail("someone@random.org", "Interview invitation", "");
    expect(ats.confidence).toBeGreaterThan(nonAts.confidence);
    expect(ats.eventClass).toBe(nonAts.eventClass);
  });

  it("snippet fallback lowers confidence vs subject match", () => {
    const subj = classifyEmail("a@b.com", "interview availability", "");
    const snip = classifyEmail("a@b.com", "Hello", "we would like to schedule an interview");
    expect(subj.confidence).toBeGreaterThan(snip.confidence);
  });

  it("every ATS domain entry is a bare registrable domain", () => {
    for (const d of ATS_DOMAINS) {
      expect(d).toMatch(/^[a-z0-9.-]+$/);
      expect(d.startsWith("@")).toBe(false);
      expect(d.includes("@")).toBe(false);
    }
  });
});

describe("V3 §1 parseFrom + snippet", () => {
  it("parses 'Name <email>' form", () => {
    const { email, domain } = parseFrom("Jane Doe <noreply@acme.myworkday.com>");
    expect(email).toBe("noreply@acme.myworkday.com");
    expect(domain).toBe("acme.myworkday.com");
  });

  it("parses bare address form", () => {
    const { email, domain } = parseFrom("noreply@greenhouse.io");
    expect(email).toBe("noreply@greenhouse.io");
    expect(domain).toBe("greenhouse.io");
  });

  it("handles null/empty headers", () => {
    expect(parseFrom(null)).toEqual({ email: null, domain: null });
    expect(parseFrom("")).toEqual({ email: null, domain: null });
  });

  it("strips HTML tags and collapses whitespace in snippets", () => {
    const out = toSnippet("<html><body><p>Dear   candidate,</p>  we received</body></html>");
    expect(out).toContain("Dear candidate,");
    expect(out).not.toContain("<");
  });

  it("caps snippets at ~200 chars", () => {
    const long = toSnippet("x".repeat(500));
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("V3 §1 extractMessageParts", () => {
  it("extracts From/Subject headers and decodes base64url body", () => {
    const bodyB64 = Buffer.from("<p>We received your application.</p>").toString("base64url");
    const msg = {
      payload: {
        headers: [
          { name: "From", value: "Acme <noreply@greenhouse-mail.io>" },
          { name: "Subject", value: "Application received" },
          { name: "Date", value: "Fri, 22 Aug 2026 10:00:00 +0000" },
        ],
        parts: [{ mimeType: "text/html", body: { data: bodyB64 } }],
      },
      snippet: "fallback",
    };
    const parts = extractMessageParts(msg);
    expect(parts.from).toBe("Acme <noreply@greenhouse-mail.io>");
    expect(parts.subject).toBe("Application received");
    expect(parts.snippet).toBe("We received your application.");
  });
});
