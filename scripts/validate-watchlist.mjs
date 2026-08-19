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
  smartrecruiters: (key) =>
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(key)}/postings?limit=2`,
  // Workday: POST {origin}/wday/cxs/{tenant}/{siteId}/jobs (validator uses fetch
  // with method POST to exercise the same path the adapter uses).
  workday: (key) => {
    const [host, site = host] = String(key)
      .split(":")
      .map((s) => s.trim().replace(/^https?:\/\//, ""));
    return {
      url: `https://${host}/wday/cxs/${encodeURIComponent(host)}/${encodeURIComponent(site)}/jobs`,
      method: "POST",
    };
  },
  oracle: (key) => {
    const [host, , portal = "", lang = "en"] = String(key)
      .split(":")
      .map((s) => s.trim());
    return {
      url: `https://${host.replace(/^https?:\/\//, "")}/careersection/rest/jobboard/searchjobs?lang=${encodeURIComponent(lang)}&portal=${encodeURIComponent(portal)}`,
      method: "POST",
    };
  },
};

const TIMEOUT_MS = 15_000;

/** Body shape for provider endpoints that need a POST (Workday/Taleo). */
function bodyFor(provider) {
  if (provider === "workday")
    return JSON.stringify({ appliedFacets: {}, searchText: "", limit: 2, offset: 0 });
  if (provider === "oracle") return JSON.stringify({ pageNo: 1 });
  return undefined;
}

/** Content type for the provider POSTs. */
function headersFor(provider) {
  if (provider === "workday") {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Accept-Language": "en-US",
    };
  }
  if (provider === "oracle")
    return { Accept: "application/json", "Content-Type": "application/json" };
  return { Accept: "application/json" };
}

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
  const target = build(company.boardKey ?? company.id);
  const url = typeof target === "string" ? target : target.url;
  const method = typeof target === "string" ? "GET" : target.method;
  const body = bodyFor(company.provider, company.boardKey);
  const headers = headersFor(company.provider);
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const code = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
    return { ok: false, error: `${code}: could not reach board`, ms: Date.now() - started };
  }
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}`, ms: latencyMs };
  }
  try {
    const text = await res.text();
    const bodyJson =
      text.trim().startsWith("{") || text.trim().startsWith("[") ? JSON.parse(text) : null;
    const list = Array.isArray(bodyJson)
      ? bodyJson
      : (bodyJson?.jobPostings ?? bodyJson?.requisitionList ?? bodyJson?.content);
    const jobs = Array.isArray(list) ? list : bodyJson?.jobs;
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
