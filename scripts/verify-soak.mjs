#!/usr/bin/env node
/**
 * ApplyRN soak-completion check (V0 acceptance #19: 24-hour unattended soak).
 *
 * Read-only verification against the LIVE production worker + D1. Unlike
 * soak.mjs this needs no DASHBOARD_TOKEN: it asserts the invariants from
 * raw database rows (stronger than the HTTP surface) plus a public /health
 * ping. Designed to run from a cron / CI-less terminal at the 24h mark.
 *
 * Usage (from repo root; requires local wrangler auth):
 *   node scripts/verify-soak.mjs
 *
 * Exit 0 = PASS, 1 = FAIL. Prints a concise verdict.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const WORKER_URL = process.env.WORKER_URL ?? "https://applyrn-worker.siddhankuwar116.workers.dev";
// First fully-clean post-shard cycle (D-011). Rows before this are the
// pre-fix 50/13 era and must NOT count against the 24h soak.
const CLEAN_SINCE = process.env.CLEAN_SINCE ?? "2026-08-16T19:30:00.000Z";

const wranglerBin = resolve("apps/worker/node_modules/.bin/wrangler");
const D1 = ["d1", "execute", "applyrn", "--remote", "--json"];

function runWrangler(sql) {
  if (!existsSync(wranglerBin)) {
    throw new Error(`wrangler not found at ${wranglerBin} (run from repo root)`);
  }
  const res = spawnSync(wranglerBin, [...D1, "--command", sql], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (res.status !== 0) {
    throw new Error(`wrangler failed (${res.status}): ${res.stderr}`);
  }
  const parsed = JSON.parse(res.stdout);
  return parsed[0]?.results ?? [];
}

const checks = [];
const started = new Date().toISOString();

async function main() {
  // 0. Worker alive (public endpoint, no auth).
  let health = { ok: false };
  try {
    const r = await fetch(`${WORKER_URL}/health`, { signal: AbortSignal.timeout(15_000) });
    health = await r.json();
  } catch {
    /* health.ok stays false */
  }
  checks.push({ name: "worker.alive", pass: health.ok === true, detail: `${WORKER_URL}/health` });

  // 1. Cycles keep advancing (a row in the last 5 minutes).
  const recent = runWrangler(
    `SELECT COUNT(*) AS n FROM poll_metrics WHERE finished_at >= datetime('now', '-5 minutes')`,
  );
  const recentCycles = Number(recent[0]?.n ?? 0);
  checks.push({
    name: "cycles.advancing",
    pass: recentCycles > 0,
    detail: `${recentCycles} in last 5m`,
  });

  // 2. Zero failure cycles since the clean deploy.
  const failed = runWrangler(
    `SELECT COUNT(*) AS n FROM poll_metrics WHERE failed > 0 AND finished_at >= '${CLEAN_SINCE}'`,
  );
  const failedCycles = Number(failed[0]?.n ?? 0);
  checks.push({
    name: "cycles.zeroFailures",
    pass: failedCycles === 0,
    detail: `${failedCycles} failed cycles`,
  });

  // 3. Zero duplicate delivered notifications.
  const dups = runWrangler(
    `SELECT COUNT(*) AS n FROM (SELECT job_id FROM notifications WHERE delivered = 1 GROUP BY job_id HAVING COUNT(*) > 1)`,
  );
  const dupCount = Number(dups[0]?.n ?? 0);
  checks.push({
    name: "notifications.zeroDuplicates",
    pass: dupCount === 0,
    detail: `${dupCount} dupes`,
  });

  // 4. Every source readable (no failure streaks).
  const failing = runWrangler(`SELECT COUNT(*) AS n FROM source_state WHERE failure_streak > 0`);
  const failingSources = Number(failing[0]?.n ?? 0);
  checks.push({
    name: "sources.readable",
    pass: failingSources === 0,
    detail: `${failingSources} failing`,
  });

  // 5. Snapshot totals for the report.
  const totals = runWrangler(
    `SELECT (SELECT COUNT(*) FROM poll_metrics WHERE finished_at >= '${CLEAN_SINCE}') AS cycles,
            (SELECT COUNT(*) FROM jobs) AS jobs,
            (SELECT COUNT(*) FROM notifications) AS notifications,
            (SELECT COUNT(*) FROM companies WHERE enabled = 1) AS companies`,
  );
  const t = totals[0] ?? {};

  const passed = checks.every((c) => c.pass);
  console.log(`soak-check ${passed ? "PASS" : "FAIL"} at ${started}`);
  for (const c of checks) console.log(`  ${c.pass ? "ok " : "FAIL"} ${c.name}: ${c.detail}`);
  console.log(
    `  totals: cycles=${t.cycles} jobs=${t.jobs} notifications=${t.notifications} companies=${t.companies}`,
  );
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(`soak-check ERROR: ${err.message}`);
  process.exit(1);
});
