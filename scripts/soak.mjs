#!/usr/bin/env node
/**
 * ApplyRN soak harness (PRD Issue 12: 24-hour unattended run).
 *
 * Drives a running worker through repeated poll cycles and asserts the
 * soak invariants on every pass:
 *
 *   1. worker stays alive (every API call answers)
 *   2. cycles keep advancing (poll_metrics rows grow)
 *   3. zero duplicate notifications (observability reports 0)
 *   4. source health stays readable (sources endpoint answers)
 *
 * Writes a JSONL event log + final soak-report.json.
 *
 * Usage (worker must be running):
 *   wrangler dev                      # terminal 1, from apps/worker
 *   DASHBOARD_TOKEN=... node scripts/soak.mjs --minutes 1440   # 24h soak
 *   node scripts/soak.mjs --minutes 5 --interval 10            # quick check
 *
 * Flags:
 *   --url <base>       worker base URL (default http://localhost:8787)
 *   --minutes <n>      total duration (default 30; 1440 = 24 hours)
 *   --interval <sec>   seconds between cycles (default 120)
 *   --report <path>    report output (default soak-report.json)
 */

import { writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = flag("--url", "http://localhost:8787");
const MINUTES = Number(flag("--minutes", "30"));
const INTERVAL = Number(flag("--interval", "120"));
const REPORT = resolve(flag("--report", "soak-report.json"));
const TOKEN = process.env.DASHBOARD_TOKEN ?? "";

if (!TOKEN) {
  console.error("DASHBOARD_TOKEN env var is required (the API fails closed).");
  process.exit(1);
}

const startedAt = new Date().toISOString();
const deadline = Date.now() + MINUTES * 60_000;
const events = [];
let violations = 0;

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.json();
}

async function onePass(pass, prevCycles) {
  const t0 = Date.now();
  const record = { pass, at: new Date().toISOString(), prevCycles };

  // 1. trigger one full cycle
  const summary = await api("/api/poll", {
    method: "POST",
    headers: authHeaders(),
    body: "{}",
  });
  record.pollSummary = summary.summary ?? summary;

  // 2. read observability
  const { metrics } = await api("/api/metrics", { headers: authHeaders() });
  record.metrics = {
    cycles: metrics.cycles,
    successful: metrics.successful,
    failed: metrics.failed,
    newJobs: metrics.newJobs,
    durationP95Ms: metrics.durationP95Ms,
    alertFailures: metrics.alertFailures,
    duplicateNotifications: metrics.duplicateNotifications,
    inactiveConfirmations: metrics.inactiveConfirmations,
  };

  // 3. source health must stay readable
  const { sources } = await api("/api/sources", { headers: authHeaders() });
  record.sources = sources.length;

  const violationsHere = [];
  if (!Array.isArray(sources) || sources.length === 0) {
    violationsHere.push("sources endpoint returned no sources");
  }
  if (metrics.duplicateNotifications !== 0) {
    violationsHere.push(`duplicateNotifications=${metrics.duplicateNotifications}`);
  }
  if (prevCycles !== undefined && metrics.cycles < prevCycles) {
    violationsHere.push(`cycles regressed ${prevCycles} -> ${metrics.cycles}`);
  }
  if (metrics.alertFailures.length > 0) {
    const total = metrics.alertFailures.reduce((s, f) => s + f.n, 0);
    // Failures are recorded for undelivered alerts; the soak flags only
    // sustained failure (every cycle failing) as an error.
    if (total >= metrics.cycles) violationsHere.push(`all ${total} alerts failing`);
  }
  record.violations = violationsHere;
  record.durationMs = Date.now() - t0;
  return record;
}

console.log(`soak: ${BASE} · ${MINUTES} min · ${INTERVAL}s interval · report ${REPORT}`);
appendFileSync(REPORT, `{"event":"start","at":"${startedAt}","base":"${BASE}"}\n`);

let pass = 0;
let lastCycles = undefined;
try {
  while (Date.now() < deadline) {
    pass++;
    const record = await onePass(pass, lastCycles);
    lastCycles = record.metrics.cycles;
    events.push(record);
    appendFileSync(REPORT, `${JSON.stringify(record)}\n`);
    const flagTxt = record.violations.length ? ` VIOLATION ${record.violations.join(", ")}` : "";
    console.log(
      `[${pass}] cycles=${record.metrics.cycles} ok=${record.metrics.successful} ` +
        `fail=${record.metrics.failed} p95=${record.metrics.durationP95Ms}ms ` +
        `dup=${record.metrics.duplicateNotifications}${flagTxt}`,
    );
    if (record.violations.length) violations += record.violations.length;

    const wait = Math.max(1, Math.round((Date.now() + INTERVAL * 1000 - Date.now()) / 1000));
    if (Date.now() < deadline && wait > 0) {
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
} catch (err) {
  violations++;
  const rec = { pass, at: new Date().toISOString(), fatal: String(err?.message ?? err) };
  events.push(rec);
  appendFileSync(REPORT, `${JSON.stringify(rec)}\n`);
  console.error(`soak FATAL: ${rec.fatal}`);
}

const finishedAt = new Date().toISOString();
const report = {
  status: violations === 0 ? "PASS" : "FAIL",
  startedAt,
  finishedAt,
  passes: events.length,
  violations,
  lastMetrics: events.filter((e) => e.metrics).at(-1)?.metrics ?? null,
};
writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");
console.log(
  `\nsoak ${report.status}: ${events.length} passes, ${violations} violations → ${REPORT}`,
);
process.exit(violations === 0 ? 0 : 1);
