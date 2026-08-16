#!/usr/bin/env node
/**
 * ApplyRN watchlist validator (PRD Issue 12).
 *
 * Reads a watchlist JSON file and live-checks every board: provider key
 * resolves, the board API responds, and the payload parses as a job list.
 *
 * Usage:
 *   node scripts/validate-watchlist.mjs [path/to/watchlist.json]
 *
 * Defaults to config/private/watchlist.json; falls back to the committed
 * example when the private one does not exist.
 *
 * Exit code: 0 when every company validates, 1 otherwise.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PROVIDERS = {
  greenhouse: (key) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(key)}/jobs`,
  ashby: (key) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(key)}`,
  lever: (key) => `https://api.lever.co/v0/postings/${encodeURIComponent(key)}?mode=json`,
};

const TIMEOUT_MS = 15_000;

function pickWatchlist(argv) {
  const explicit = argv[2];
  if (explicit) return resolve(explicit);
  const privatePath = resolve("config/private/watchlist.json");
  if (existsSync(privatePath)) return privatePath;
  return resolve("fixtures/example-watchlist.json");
}

async function check(company) {
  const build = PROVIDERS[company.provider];
  if (!build) {
    return { ok: false, error: `unknown provider "${company.provider}"` };
  }
  const url = build(company.boardKey ?? company.id);
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const code = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
    return { ok: false, error: `${code}: could not reach board`, ms: Date.now() - started };
  }
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}`, ms: latencyMs };
  }
  try {
    const body = await res.json();
    const jobs = Array.isArray(body) ? body : body?.jobs;
    if (!Array.isArray(jobs)) {
      return { ok: false, error: "payload is not a job list", ms: latencyMs };
    }
    return { ok: true, jobs: jobs.length, ms: latencyMs };
  } catch {
    return { ok: false, error: "payload is not JSON", ms: latencyMs };
  }
}

const path = pickWatchlist(process.argv);
let companies;
try {
  companies = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`cannot read watchlist ${path}: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(companies)) {
  console.error(`watchlist ${path} must be a JSON array of companies`);
  process.exit(1);
}

console.log(`watchlist: ${path} (${companies.length} companies)\n`);
let failed = 0;
for (const company of companies) {
  const r = await check(company);
  if (r.ok) {
    console.log(
      `  ok   ${company.id.padEnd(24)} ${company.provider.padEnd(11)} ${r.jobs} jobs  ${r.ms}ms`,
    );
  } else {
    failed++;
    console.log(`  FAIL ${company.id.padEnd(24)} ${company.provider.padEnd(11)} ${r.error}`);
  }
}
console.log(`\n${companies.length - failed}/${companies.length} boards validated`);
if (failed > 0) process.exit(1);
