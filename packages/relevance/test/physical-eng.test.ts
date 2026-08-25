import { describe, expect, it } from "vitest";
import { evaluateRelevance } from "../src/engine.js";

/**
 * 2026-08-25 user report: "Water Resources Engineering Intern" alerted.
 * Bare "engineering" is in-scope, so physical-world engineering disciplines
 * must be excluded explicitly. These lock that in.
 */
describe("physical-world engineering exclusion (user report 2026-08-25)", () => {
  const suppressed = [
    { title: "Water Resources Engineering Intern", location: "" },
    { title: "Water/Wastewater Engineering Intern", location: "" },
    { title: "Reservoir Engineer Intern", location: "Houston, TX" },
    { title: "Graduate - Subsurface Technology Reservoir Engineer", location: "" },
    { title: "Traffic and ITS Engineering Intern", location: "" },
    { title: "Entry-Level Traffic Engineer", location: "" },
  ];
  for (const c of suppressed) {
    it(`suppresses: ${c.title}`, () => {
      expect(evaluateRelevance(c).suppressed).toBe(true);
    });
  }

  const alerts = [
    { title: "Software Engineering Intern", location: "" },
    { title: "2027 Systems Safety Engineering Intern", location: "" },
    { title: "Computer Vision Engineering Intern", location: "" },
    {
      title: "Data Acquisition Software Engineer",
      location: "",
      descriptionPlain:
        "Recent graduates or those graduating soon are encouraged to apply. This is an entry-level role.",
    },
  ];
  for (const c of alerts) {
    it(`still alerts: ${c.title}`, () => {
      const r = evaluateRelevance(c);
      expect(r.suppressed).toBe(false);
      expect(r.score).toBeGreaterThanOrEqual(15);
    });
  }
});
