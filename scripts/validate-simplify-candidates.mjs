#!/usr/bin/env node
/**
 * V3 C1 live validation: probe every candidate board through the REAL public
 * API endpoints (same ones the adapters use) and keep only boards that
 * respond 200 with a parseable payload. Writes the validated watchlist file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const candidates = JSON.parse(
  readFileSync(path.join(os.tmpdir(), "simplify-candidates.json"), "utf8"),
);

async function probe(row) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12_000);
  try {
    let url;
    switch (row.provider) {
      case "greenhouse":
        url = `https://boards-api.greenhouse.io/v1/boards/${row.boardKey}/jobs`;
        break;
      case "lever":
        url = `https://api.lever.co/v0/postings/${row.boardKey}?mode=json`;
        break;
      case "ashby":
        url = `https://api.ashbyhq.com/posting-api/job-board/${row.boardKey}`;
        break;
      case "smartrecruiters":
        url = `https://api.smartrecruiters.com/v1/companies/${row.boardKey}/postings?limit=10`;
        break;
      case "workday": {
        // boardKey = tenant:site (we normalize locale-prefixed sites away)
        const [tenant, site] = row.boardKey.split(":");
        if (!tenant || !site) return { ok: false, reason: "bad workday key" };
        url = `https://${tenant}.wd1.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Accept-Language": "en-US",
          },
          body: JSON.stringify({ appliedFacets: {}, searchText: "", limit: 20, offset: 0 }),
          signal: controller.signal,
        });
        clearTimeout(t);
        if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
        const body = await res.json();
        return {
          ok: Array.isArray(body.jobPostings),
          reason: `${body.jobPostings?.length ?? 0} postings`,
        };
      }
      default:
        return { ok: false, reason: "unknown provider" };
    }
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const text = await res.text();
    try {
      JSON.parse(text);
      return { ok: true, reason: "parsed" };
    } catch {
      return { ok: false, reason: "non-JSON" };
    }
  } catch (err) {
    return { ok: false, reason: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(t);
  }
}

const validated = [];
const failed = [];
for (const row of candidates) {
  const result = await probe(row);
  if (result.ok) {
    validated.push(row);
    console.log(`✓ ${row.name} (${row.provider}/${row.boardKey})`);
  } else {
    failed.push({ ...row, reason: result.reason });
    console.log(`✗ ${row.name} (${row.provider}/${row.boardKey}) — ${result.reason}`);
  }
}
console.log(`\nvalidated: ${validated.length} / failed: ${failed.length}`);
writeFileSync(
  path.join(os.tmpdir(), "simplify-validated.json"),
  JSON.stringify(validated, null, 2),
);
writeFileSync(path.join(os.tmpdir(), "simplify-failed.json"), JSON.stringify(failed, null, 2));
