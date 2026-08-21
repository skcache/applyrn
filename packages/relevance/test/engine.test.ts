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
  it("covers the user's full declared engineering-track scope", () => {
    // Every family the user listed as in-scope (all US + early-career):
    const cases: [string, string, string][] = [
      // [title, expected reason label, location]
      ["Software Engineering Intern", "Software engineering", "San Francisco, CA"],
      ["Backend Engineering Intern", "Backend", "New York, NY"],
      ["Infrastructure Engineering Intern", "Infrastructure / cloud", "Seattle, WA"],
      ["Platform Engineering Intern", "Systems / platform", "Austin, TX"],
      ["DevOps Engineering Intern", "DevOps / SRE", "Remote, US"],
      ["SRE Intern", "DevOps / SRE", "Remote, US"],
      ["Embedded Software Intern", "Embedded", "Boston, MA"],
      ["Firmware Engineering Intern", "Embedded", "San Jose, CA"],
      ["Machine Learning Intern", "ML / AI", "San Francisco, CA"],
      ["ML Engineering Intern", "ML / AI", "Remote, US"],
      ["Data Engineering Intern", "Data", "New York, NY"],
      ["Data Science Intern", "Data", "Seattle, WA"],
      ["Test Automation Engineering Intern", "Test / automation", "Remote, US"],
      ["QA Engineering Intern", "Test / automation", "San Francisco, CA"],
      ["Test Infrastructure Intern", "Test / automation", "Denver, CO"],
      ["Developer Tools Intern", "Developer tools", "Remote, US"],
      ["DevTools Engineering Intern", "Developer tools", "San Francisco, CA"],
      ["Cloud Engineering Intern", "Infrastructure / cloud", "Remote, US"],
    ];
    for (const [title, label, location] of cases) {
      const r = evaluateRelevance({ title, location });
      expect(r.suppressed).toBe(false, `${title} should be in scope`);
      expect(r.reasons).toContain(label);
    }
  });

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

  it("allows full-time roles within the 0-2 YoE ceiling (no intern marker needed)", () => {
    // The user widened scope: full-time is fine as long as experience is 0-2 YoE.
    for (const title of [
      "Software Engineer",
      "Backend Engineer",
      "Machine Learning Engineer",
      "Data Engineer",
    ]) {
      const r = evaluateRelevance({
        title,
        location: "San Francisco, CA",
        descriptionPlain: "0-2 years of experience required",
      });
      expect(r.suppressed, `${title} (0-2 YoE) should be in scope`).toBe(false);
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("suppresses a full-time title with no early-career signal at all", () => {
    // A plain mid-level engineering title with no junior marker and no stated
    // experience requirement fails the 0-2 YoE scope gate.
    const r = evaluateRelevance({ title: "Platform Engineer", location: "New York, NY" });
    expect(r.suppressed).toBe(true);
    expect(r.suppressionReason).toMatch(/0-2 YoE scope|Not/i);
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
    expect(r.suppressionReason).toMatch(/years of experience/);
  });

  it("suppresses an explicit 3+ years ceiling (over 0-2 YoE scope)", () => {
    const r = evaluateRelevance({
      title: "Machine Learning Engineer",
      location: "San Francisco, CA",
      descriptionPlain: "3+ years of relevant experience in production ML systems",
    });
    expect(r.suppressed).toBe(true);
  });

  it("allows an explicit 2-year ceiling (at the 0-2 YoE boundary)", () => {
    const r = evaluateRelevance({
      title: "DevOps Engineer",
      location: "Remote, US",
      descriptionPlain: "2 years of professional experience or equivalent",
    });
    expect(r.suppressed).toBe(false);
  });

  it("does not treat company-age prose as an experience requirement", () => {
    const r = evaluateRelevance({
      title: "Software Engineer",
      location: "Remote, US",
      descriptionPlain: "0-2 years of experience. We are a 10-year-old startup built by engineers.",
    });
    expect(r.suppressed).toBe(false);
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

  it("suppresses a bare ambiguous title with no software signal (2026-08-21)", () => {
    // REVERSED 2026-08-21: the old rule kept bare "Intern" in scope ("missing
    // a plausible internship is worse"), but the production alert log filled
    // with Store/Culinary/Events interns riding that allowance. The title
    // must now carry an explicit software/eng-track signal.
    const r = evaluateRelevance({
      title: "Intern",
      location: "San Francisco, CA",
      descriptionPlain: "We are hiring an intern for the summer.",
    });
    expect(r.suppressed).toBe(true);
    expect(r.suppressionReason).toMatch(/No software/i);
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

describe("2026-08-21 hardening: title-level software signal required", () => {
  it("suppresses every false positive from the 08-21 production alert log", () => {
    const cases: [string, string][] = [
      // Target posts one per store location; they flooded the alerts.
      ["Store Executive Intern (Store Leadership Intern)", "Brooklyn, NY"],
      ["Store Executive Intern – Bay 100", "Minneapolis, MN"],
      // Dining-hall / campus-service roles.
      ["Part-Time Culinary Service Associate | Columba Hall", "Notre Dame, IN"],
      ["Clerk Intern", "Remote, US"],
      // Non-software engineering disciplines.
      ["Entry-Level Bridge Engineer", "San Francisco, CA"],
      ["Manufacturing Technician I", "North Chicago, IL"],
      ["Process Engineer Intern", "Houston, TX"],
      ["Mechanical Engineering Intern", "Detroit, MI"],
      // Events / generalist internships with zero tech signal.
      ["Strategic Events Intern (Fall 2026)", "In-Office"],
      // TAM leader slipped through as a non-engineering role.
      ["Technical Account Management (TAM) Leader", "Remote"],
    ];
    for (const [title, location] of cases) {
      const r = evaluateRelevance({ title, location });
      expect(r.suppressed, `${title} must be suppressed`).toBe(true);
    }
  });

  it("keeps genuinely in-scope titles that share words with the blocklist", () => {
    const cases: string[] = [
      "Software Engineer Intern",
      "Data Science Intern",
      "Backend Developer Intern",
      "Full-Stack Software Engineering Intern",
      "Machine Learning Intern",
      "Site Reliability Engineer Intern",
      "Security Engineer Intern",
      "Python Developer Intern",
      "Embedded Firmware Intern",
      "Quantitative Developer Intern",
      "DevOps Intern",
      "Cloud Infrastructure Intern",
    ];
    for (const title of cases) {
      const r = evaluateRelevance({ title, location: "San Francisco, CA" });
      expect(r.suppressed, `${title} must stay in scope`).toBe(false);
    }
  });
});

describe("part-time software scope (2026-08-21 user addition)", () => {
  it("admits part-time SWE titles without an intern marker", () => {
    for (const title of [
      "Part-Time Software Engineer",
      "Part Time Software Developer",
      "Part-Time Backend Engineer (Remote)",
    ]) {
      const r = evaluateRelevance({ title, location: "Remote, US" });
      expect(r.suppressed, `${title} should be in scope`).toBe(false);
      expect(r.reasons).toContain("Part-time");
    }
  });

  it("admits hours-phrased roles ('15-20 hours per week')", () => {
    const r = evaluateRelevance({
      title: "Software Developer",
      location: "Remote, US",
      descriptionPlain: "This is a part-year role requiring 15-20 hours per week.",
    });
    expect(r.suppressed).toBe(false);
  });

  it("still suppresses part-time NON-software roles", () => {
    for (const title of [
      "Part-Time Store Associate",
      "Part-Time Barista",
      "Part-Time Receptionist",
    ]) {
      const r = evaluateRelevance({ title, location: "Remote, US" });
      expect(r.suppressed, `${title} must stay suppressed`).toBe(true);
    }
  });

  it("part-time does not override seniority gates", () => {
    const r = evaluateRelevance({
      title: "Part-Time Senior Software Engineer",
      location: "Remote, US",
    });
    expect(r.suppressed).toBe(true);
    expect(r.suppressionReason).toMatch(/Senior\/leadership/i);
  });
});
