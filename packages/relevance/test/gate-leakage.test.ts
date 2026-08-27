import { describe, expect, it } from "vitest";
import { evaluateRelevance } from "../src/engine.js";

/**
 * 2026-08-26 gate-leakage audit fixes:
 *  - Bare "engineer"/"engineering" is no longer a positive signal. A title
 *    needs an explicit software-family word (software/data/ml/backend/
 *    frontend/swe/developer/infra/systems/embedded/quant) OR a strong tech
 *    skill to be in-scope. This stops ~30% of live alerts leaking as
 *    physical-world engineering (materials/process/nuclear/structures/
 *    propulsion/hardware/fpga/traction-power...).
 *  - Bare "analyst" removed so real engineering-analytic roles
 *    ("Data Analyst Engineer Intern") are no longer wrongly suppressed.
 */
describe("gate leakage fixes (2026-08-26)", () => {
  const leaked = [
    "Materials Engineering Intern",
    "Process Engineering Intern (Summer 2027)",
    "Nuclear Engineer I",
    "Structures Engineering Intern",
    "Propulsion Engineer New Grad",
    "Hardware Engineer Intern",
    "FPGA Engineering Intern",
    "Traction Power Engineer",
    "Additive Engineering Intern",
    "Architectural Engineering Intern",
  ];
  for (const t of leaked) {
    it(`suppresses physical-engineering: ${t}`, () => {
      expect(evaluateRelevance({ title: t, location: "US" }).suppressed).toBe(true);
    });
  }

  const inScope = [
    { title: "Software Engineering Intern", location: "US" },
    { title: "Embedded Software Engineer Intern", location: "US" },
    { title: "Data Analyst Engineer Intern", location: "US" },
    { title: "ML Analyst Intern", location: "US" },
    { title: "Backend Developer Intern", location: "US" },
    { title: "Python Engineer Intern", location: "US" },
    { title: "Quant Developer Intern", location: "US" },
  ];
  for (const c of inScope) {
    it(`still in-scope: ${c.title}`, () => {
      expect(evaluateRelevance(c).suppressed).toBe(false);
    });
  }
});
