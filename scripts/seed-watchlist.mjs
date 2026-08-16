#!/usr/bin/env node
/**
 * ApplyRN watchlist seeder (PRD Issue 12).
 *
 * Reads a watchlist JSON file and upserts every company into D1 with
 * INSERT OR REPLACE, so re-running after edits is safe. The real watchlist
 * is private (config/private/watchlist.json, gitignored); the committed
 * example is a fallback for local dev only.
 *
 * Usage (from repo root):
 *   node scripts/seed-watchlist.mjs                          # local D1
 *   node scripts/seed-watchlist.mjs --remote                 # prod D1
 *   node scripts/seed-watchlist.mjs --file path.json         # custom list
 *
 * Requires `wrangler` on PATH. Runs wrangler from apps/worker so the
 * database binding in wrangler.toml applies.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const wranglerBin = resolve("apps/worker/node_modules/.bin/wrangler");

function pickWatchlist(argv) {
  const fileIdx = argv.indexOf("--file");
  if (fileIdx !== -1 && argv[fileIdx + 1]) return resolve(argv[fileIdx + 1]);
  const privatePath = resolve("config/private/watchlist.json");
  if (existsSync(privatePath)) return privatePath;
  return resolve("fixtures/example-watchlist.json");
}

function sqlFor(companies) {
  const lines = companies.map((c) => {
    const tags = Array.isArray(c.tags) && c.tags.length > 0 ? JSON.stringify(c.tags) : null;
    const createdAt = c.createdAt ?? new Date().toISOString();
    return (
      `INSERT OR REPLACE INTO companies ` +
      `(id, name, careers_url, provider, board_key, enabled, poll_interval_seconds, tags, created_at) ` +
      `VALUES (` +
      `'${String(c.id).replaceAll("'", "''")}', ` +
      `'${String(c.name).replaceAll("'", "''")}', ` +
      `'${String(c.careersUrl ?? "").replaceAll("'", "''")}', ` +
      `'${String(c.provider).replaceAll("'", "''")}', ` +
      `'${String(c.boardKey ?? c.id).replaceAll("'", "''")}', ` +
      `${c.enabled === false ? 0 : 1}, ` +
      `${Number(c.pollIntervalSeconds ?? 120)}, ` +
      `'${tags ?? ""}', ` +
      `'${String(createdAt).replaceAll("'", "''")}')`
    );
  });
  return lines.join(";\n") + ";";
}

const argv = process.argv.slice(2);
const remote = argv.includes("--remote");
const path = pickWatchlist(argv);

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

const sql = sqlFor(companies);
const target = remote ? "remote D1" : "local D1";
console.log(`seeding ${companies.length} companies from ${path} into ${target}...`);

// wrangler is a workspace devDependency; locate it without requiring PATH.
const run = spawnSync(
  existsSync(wranglerBin) ? wranglerBin : "wrangler",
  ["d1", "execute", "applyrn", remote ? "--remote" : "--local", "--command", sql],
  {
    cwd: resolve("apps/worker"),
    stdio: "inherit",
  },
);
if (run.status !== 0) {
  console.error("wrangler d1 execute failed");
  process.exit(run.status ?? 1);
}
console.log("done.");
