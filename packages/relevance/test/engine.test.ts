import { describe, expect, it } from "vitest";
import { evaluateRelevance } from "../src/engine.js";

describe("location gate (US-only)", () => {
  it("allows US locations", () => {
    for (const location of [
      "San Francisco, CA",
      "New York, NY; Remote, US",
      "Remote, United States",
      "United States - Remote",
      "Remote, US",
      "Denver, CO",
      undefined,
    ]) {
      const r = evaluateRelevance({ title: "Software Engineering Intern", location });
      expect(r.suppressed).toBe(false);
    }
  });

  it("suppresses explicit non-US locations", () => {
    const cases: [string, string][] = [
      ["Spiral Ingénieur Blockchain", "Paris, France"],
      ["Forward Deployed Engineer - Software Engineer", "Denmark"],
      ["Forward Deployed Engineer - Software Engineer", "Germany"],
      ["Software Engineering Intern", "London, UK"],
      ["Sales Development Representative", "Barcelona, Spain"],
      ["Software Engineering Intern", "Tokyo, Japan"],
      ["Software Engineering Intern", "Dublin, Ireland"],
      ["Software Engineering Intern", "Singapore"],
    ];
    for (const [title, location] of cases) {
      const r = evaluateRelevance({ title, location });
      expect(r.suppressed).toBe(true);
      expect(r.suppressionReason).toMatch(/Outside US/i);
    }
  });

  it("does not suppress a US city that shares a foreign name (Paris, TX)", () => {
    // "London, KY" and "Paris, TX" are real US cities.
    for (const location of ["Paris, TX", "London, KY"]) {
      const r = evaluateRelevance({ title: "Software Engineering Intern", location });
      expect(r.suppressed).toBe(false);
    }
  });
});

describe("early-career scope gate (seniority == out)", () => {
  it("allows internships, co-ops, new-grad and entry-level titles", () => {
    for (const title of [
      "Software Engineering Intern",
      "Data Engineering Co-op",
      "New Grad Software Engineer",
      "Entry Level ML Engineer",
      "Early Career Developer",
      "Junior Backend Engineer",
    ]) {
      const r = evaluateRelevance({ title, location: "San Francisco, CA" });
      expect(r.suppressed).toBe(false);
    }
  });

  it("suppresses senior/leadership titles", () => {
    const cases: string[] = [
      "Senior Data Engineer II, Finance",
      "Software Engineering Manager",
      "Senior Solutions Architect",
      "Senior Territory Account Executive",
      "Staff Software Engineer",
      "Principal Engineer",
      "Director of Engineering",
      "VP of Platform",
      "Senior Learning Design Engineer",
      "Lead Product Analyst",
    ];
    for (const title of cases) {
      const r = evaluateRelevance({ title, location: "San Francisco, CA" });
      expect(r.suppressed).toBe(true);
      expect(r.suppressionReason).toMatch(/Senior\/leadership/i);
    }
  });

  it("does not suppress an internship whose description mentions senior people", () => {
    const r = evaluateRelevance({
      title: "Software Engineering Intern",
      location: "San Francisco, CA",
      descriptionPlain: "You will work alongside staff engineers and principal ICs",
    });
    expect(r.suppressed).toBe(false);
  });
});

describe("role-family gate (software + data + ML only)", () => {
  it("allows engineering-track roles", () => {
    for (const title of [
      "Software Engineering Intern",
      "Data Engineer Intern",
      "Machine Learning Intern",
      "Backend Developer Internship",
      "Frontend Engineering Intern",
      "Security Engineer Intern",
      "Data Science Intern",
    ]) {
      const r = evaluateRelevance({ title, location: "New York, NY" });
      expect(r.suppressed).toBe(false);
    }
  });

  it("suppresses a full-time engineering title that is not early-career", () => {
    const r = evaluateRelevance({ title: "IT Support Engineer", location: "New York, NY" });
    expect(r.suppressed).toBe(true);
    expect(r.suppressionReason).toMatch(/Not early-career/i);
  });

  it("suppresses learners/sales/marketing/design/PM/recruiting/ops roles", () => {
    const cases: string[] = [
      "Commercial Account Executive",
      "Community Manager, Social Media",
      "Marketing Events and Campaigns Intern",
      "GRC Team Intern",
      "Supplemental Sales Agent",
      "Oracle Operations Manager",
      "Sales Development Representative",
      "Learning Design Engineer",
      "Product Manager Intern",
      "Technical Recruiter",
      "Barista",
      "Delivery Driver",
      "Workplace Coordinator",
    ];
    for (const title of cases) {
      const r = evaluateRelevance({ title, location: "San Francisco, CA" });
      expect(r.suppressed).toBe(true);
      // Some (Community Manager / Ops Manager / PM Intern) are caught by the
      // seniority gate first ("manager"), others by the role-family gate; the
      // contract is "never alert on these", not a specific reason string.
      expect(r.suppressionReason).toBeDefined();
    }
  });
});

describe("experience/PhD hard bodies", () => {
  it("suppresses explicit 5+ years experience minimums", () => {
    const r = evaluateRelevance({
      title: "Software Engineering Intern",
      descriptionPlain: "Requires 5+ years of professional experience",
    });
    expect(r.suppressed).toBe(true);
  });

  it("suppresses PhD-required roles", () => {
    const r = evaluateRelevance({
      title: "Software Engineering Intern",
      descriptionPlain: "PhD required",
    });
    expect(r.suppressed).toBe(true);
  });
});

describe("positive signals and scoring", () => {
  it("scores an internship with strong signals highly", () => {
    const r = evaluateRelevance({
      title: "Software Engineering Intern",
      location: "San Francisco, CA",
      descriptionPlain: "Python and backend systems, PyTorch for inference",
    });
    expect(r.suppressed).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.reasons).toContain("Internship");
    expect(r.reasons).toContain("Software engineering");
    expect(r.reasons).toContain("Python");
  });

  it("caps the score at 100", () => {
    const r = evaluateRelevance({
      title: "Software Engineering Intern Co-op",
      location: "San Francisco, Remote",
      descriptionPlain:
        "Python TypeScript C++ Linux PyTorch inference distributed systems developer tools backend ML AI",
    });
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("does not let a description stuffed with buzzwords inflate a full-time non-early-career title", () => {
    // The seniority gate handles this: senior role stays suppressed regardless
    // of how many tech keywords the description contains.
    const r = evaluateRelevance({
      title: "Senior Sales Engineer",
      location: "Remote, US",
      descriptionPlain:
        "Python Kubernetes AWS distributed systems machine learning backend platform engineer",
    });
    expect(r.suppressed).toBe(true);
  });

  it("every score is explainable", () => {
    const r = evaluateRelevance({ title: "Software Engineering Intern", location: "Remote" });
    expect(r.reasons.length).toBeGreaterThan(0);
    for (const reason of r.reasons) {
      expect(typeof reason).toBe("string");
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it("keeps an ambiguous early-career title in scope (no excluded family)", () => {
    // "Intern" alone carries no excluded family (not sales/marketing/design/PM),
    // so it stays in scope — missing a plausible internship is worse than
    // surfacing a mediocre one (PRD). The exclusion list is explicit, not an
    // allow-list.
    const r = evaluateRelevance({
      title: "Intern",
      location: "San Francisco, CA",
      descriptionPlain: "We are hiring an intern for the summer.",
    });
    expect(r.suppressed).toBe(false);
  });
});

describe("blanket: real-world cases the user flagged", () => {
  it("suppresses every example from the production alert log", () => {
    const cases: [string, string][] = [
      ["Spiral Ingénieur Blockchain", "Paris, France"],
      ["Forward Deployed Engineer - Software Engineer", "Denmark"],
      ["Forward Deployed Engineer - Software Engineer", "Germany"],
      ["Community Manager, Social Media", "New York, NY"],
      ["Software Engineering Manager, Network Security", "San Francisco, CA | New York City, NY"],
      ["Supplemental Sales Agent", "West Palm Beach, FL"],
      ["Oracle Operations Manager", "Hybrid"],
      ["Sales Development Representative", "Barcelona, Spain"],
      ["Sales Development Lead - APAC", "Singapore"],
      ["Senior Territory Account Executive, South China", "Distributed"],
      ["Global Onboarding", "United Kingdom"],
      ["GRC Team Intern (Fall 2026)", "In-Office"],
      ["Senior Data Engineer II, Finance", "United States - Remote"],
      ["Commercial Account Executive - Japan", "Remote, Japan"],
      ["Senior Solutions Architect", "Remote"],
      ["Senior Learning Design Engineer", "Remote"],
      ["Marketing Events and Campaigns Intern (Fall 2026)", "In-Office"],
      ["Lead Product Analyst, Lifecycle Marketing", "New York, NY, US; Remote, US"],
      ["Workplace Coordinator", "San Francisco, CA"],
      ["Sr. Technical Recruiter", "San Francisco"],
      ["Engineering Manager - AI Helpdesk", "Dublin, Ireland"],
      ["Program Manager, Performance and Talent Planning", "US-Remote"],
    ];
    for (const [title, location] of cases) {
      const r = evaluateRelevance({ title, location });
      expect(r.suppressed).toBe(true);
    }
  });
});
