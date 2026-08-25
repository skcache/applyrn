import { describe, expect, it } from "vitest";
import { evaluateRelevance } from "../src/engine.js";

describe("score spread (2026-08-25 rescoring)", () => {
  it("produces a meaningful range, not a single cluster", () => {
    const cases: {
      title: string;
      location?: string;
      descriptionPlain?: string;
      sourcePublishedAt?: string;
      note: string;
    }[] = [
      // bare minimum passer, no description, old posting
      { title: "Engineering Intern", location: "US", note: "floor" },
      // classic match
      {
        title: "Software Engineering Intern",
        location: "New York, NY",
        sourcePublishedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
        note: "classic",
      },
      // strong stack in title + fresh + hub
      {
        title: "Backend Software Engineer Intern (Python/Go)",
        location: "San Francisco, CA",
        sourcePublishedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        note: "strong",
      },
      // rich description with many skills
      {
        title: "Machine Learning Intern",
        location: "Remote",
        descriptionPlain:
          "Work with pytorch, kubernetes, aws, golang, typescript, react, sql and docker. We use machine learning at scale.",
        sourcePublishedAt: new Date().toISOString(),
        note: "rich-desc",
      },
      // generic engineering, no level word in title but intern in desc
      {
        title: "Systems Engineer",
        location: "Austin, TX",
        descriptionPlain: "This internship program is for students.",
        note: "generic",
      },
    ];
    const scores: number[] = [];
    for (const c of cases) {
      const r = evaluateRelevance(c);
      scores.push(r.score);
    }
    const uniq = new Set(scores).size;
    expect(uniq).toBeGreaterThanOrEqual(4);
    // floor must be well below the old constant-70
    expect(Math.min(...scores)).toBeLessThan(60);
    // ceiling should still reach high
    expect(Math.max(...scores)).toBeGreaterThanOrEqual(85);
  });
});
