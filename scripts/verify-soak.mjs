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

  // 1. Cycles keep advancing (a row in the last 25 minutes). The cutoff is
  // passed as an ISO literal computed here: SQLite's datetime('now') emits
  // "YYYY-MM-DD HH:MM" (space) which compares wrong against our ISO "T"
  // stored timestamps — a known false-positive trap in this checker.
  //
  // Window choice: it must match the REALIZED worst-case cadence, not the
  // designed one. GitHub Actions free-tier scheduled workflows are NOT
  // reliable on `*/5` — observed production median gap between GH Poll runs
  // is ~17 min (GitHub queues schedule events; delays lengthen under load).
  // During a Cloudflare-cron outage the GH fallback is the only trigger, so
  // a 15-minute window false-FAILs a healthy-but-fallback-driven system.
  // 25 min ≈ 1.5× the observed median gap: tight enough to catch a truly
  // dead system, loose enough not to cry wolf during a known platform
  // outage that the fallback is already covering.
  const recentCutoff = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  const recent = runWrangler(
    `SELECT COUNT(*) AS n FROM poll_metrics WHERE finished_at >= '${recentCutoff}'`,
  );
  const recentCycles = Number(recent[0]?.n ?? 0);
  checks.push({
    name: "cycles.advancing",
    pass: recentCycles > 0,
    detail: `${recentCycles} in last 25m`,
  });

  // 2. Failure rate stays under the 5% acceptance threshold (PRD: metrics
  //     show <5% failure rate across 24h). Strict-zero is wrong for live
  //     boards: single sources blip (network, 5xx) and self-recover via
  //     backoff — that's the system working. 5%+ is a systemic problem
  //     (dead cron, subrequest caps, provider outage).
  const failstats = runWrangler(
    `SELECT COALESCE(SUM(companies_polled),0) AS polled, COALESCE(SUM(failed),0) AS failed
     FROM poll_metrics WHERE finished_at >= '${CLEAN_SINCE}'`,
  );
  const polledTotal = Number(failstats[0]?.polled ?? 0);
  const failedTotal = Number(failstats[0]?.failed ?? 0);
  const failRate = polledTotal > 0 ? (failedTotal / polledTotal) * 100 : 0;
  checks.push({
    name: "cycles.failRateUnder5pct",
    pass: failRate < 5,
    detail: `${failedTotal}/${polledTotal} polls failed (${failRate.toFixed(2)}%)`,
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

  // 3b. No undelivered backlog older than 2h. A growing backlog means the
  //     alert pipeline is broken (Telegram config, subrequest caps, etc.)
  //     even though cycles look healthy — the 2026-08-17 soak caught 111
  //     stuck notifications exactly this way.
  const staleUndelivered = runWrangler(
    `SELECT COUNT(*) AS n FROM notifications WHERE delivered = 0 AND attempted_at < '${new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()}'`,
  );
  const staleUndeliveredCount = Number(staleUndelivered[0]?.n ?? 0);
  checks.push({
    name: "notifications.noStaleUndelivered",
    pass: staleUndeliveredCount === 0,
    detail: `${staleUndeliveredCount} undelivered > 2h old`,
  });

  // 4. Every source readable (no PERSISTENT failure). A single transient
  //     timeout (failure_streak = 1) is real-world noise that self-recovers
  //     via backoff — the same tolerance as cycles.failRateUnder5pct.
  //     streak >= 2 means the source has failed two consecutive polls, i.e.
  //     genuinely degraded (provider outage or a systemic fetch bug).
  const failing = runWrangler(`SELECT COUNT(*) AS n FROM source_state WHERE failure_streak >= 2`);
  const failingSources = Number(failing[0]?.n ?? 0);
  checks.push({
    name: "sources.readable",
    pass: failingSources === 0,
    detail: `${failingSources} persistently failing`,
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
