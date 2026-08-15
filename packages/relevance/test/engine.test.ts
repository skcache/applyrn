import { describe, expect, it } from "vitest";
import { evaluateRelevance } from "../src/engine.js";

describe("hard suppressions", () => {
  it("suppresses staff-level roles", () => {
    const r = evaluateRelevance({ title: "Staff Software Engineer" });
    expect(r.suppressed).toBe(true);
    expect(r.suppressionReason).toMatch(/staff/i);
  });

  it("suppresses director and VP roles", () => {
    expect(evaluateRelevance({ title: "Director of Engineering" }).suppressed).toBe(true);
    expect(evaluateRelevance({ title: "VP of Platform" }).suppressed).toBe(true);
  });

  it("suppresses explicit 5+ years experience minimums", () => {
    const r = evaluateRelevance({
      title: "Software Engineer",
      descriptionPlain: "Requires 5+ years of professional experience",
    });
    expect(r.suppressed).toBe(true);
  });

  it("suppresses PhD-required roles", () => {
    const r = evaluateRelevance({ title: "Research Scientist", descriptionPlain: "PhD required" });
    expect(r.suppressed).toBe(true);
  });

  it("suppresses clearly non-software roles", () => {
    expect(evaluateRelevance({ title: "Barista" }).suppressed).toBe(true);
    expect(evaluateRelevance({ title: "Delivery Driver" }).suppressed).toBe(true);
  });

  it("does not suppress intern roles that mention senior keywords in descriptions", () => {
    // Senior keywords in prose are not enough; the title is an internship.
    const r = evaluateRelevance({
      title: "Software Engineering Intern",
      descriptionPlain: "You will work alongside staff engineers",
    });
    expect(r.suppressed).toBe(false);
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
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.reasons).toContain("Internship");
    expect(r.reasons).toContain("Software engineering");
    expect(r.reasons).toContain("Python");
    expect(r.reasons).toContain("Backend");
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

  it("gives a low but non-zero score to a weak match (ranks, does not gate)", () => {
    const r = evaluateRelevance({ title: "Technical Program Manager", location: "Remote" });
    expect(r.suppressed).toBe(false);
    expect(r.score).toBeLessThanOrEqual(30);
    expect(r.reasons.some((x) => x === "Remote")).toBe(true);
  });

  it("every score is explainable", () => {
    const r = evaluateRelevance({ title: "Software Engineering Intern", location: "Remote" });
    expect(r.reasons.length).toBeGreaterThan(0);
    for (const reason of r.reasons) {
      expect(typeof reason).toBe("string");
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it("an empty or generic posting scores zero but is not suppressed", () => {
    const r = evaluateRelevance({ title: "Position" });
    expect(r.suppressed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });
});
