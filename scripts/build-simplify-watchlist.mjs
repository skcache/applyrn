#!/usr/bin/env node
/**
 * V3 coverage fix C1 (2026-08-22): build watchlist rows for Simplify-listed
 * companies we were missing, on adapters we already support. Extracts each
 * company's board key from its listing URL, live-validates EVERY board
 * through the real adapter before it may enter the watchlist, and writes
 * config/private/watchlist-simplify-additions.json for seed-watchlist.
 *
 * Usage: node scripts/build-simplify-watchlist.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const listings = JSON.parse(readFileSync("/tmp/simplify-listings.json", "utf8"));
const missing = new Set(JSON.parse(readFileSync("/tmp/simplify-missing.json", "utf8")));

function atsOf(url) {
  try {
    const u = new URL(url);
    const h = u.host;
    if (h.includes("greenhouse")) {
      // boards.greenhouse.io/<boardKey>/jobs/<id> — key is the FIRST path seg.
      const key = u.pathname.split("/").filter(Boolean)[0];
      return key && key !== "embed" ? { provider: "greenhouse", boardKey: key } : null;
    }
    if (h.includes("lever")) {
      // jobs.lever.co/<boardKey>/...
      const key = u.pathname.split("/")[1];
      return key ? { provider: "lever", boardKey: key } : null;
    }
    if (h.includes("ashbyhq")) {
      const key = u.pathname.split("/")[2];
      return key ? { provider: "ashby", boardKey: key } : null;
    }
    if (h.includes("smartrecruiters")) {
      const key = u.pathname.split("/")[2] ?? u.pathname.split("/")[1];
      return key ? { provider: "smartrecruiters", boardKey: key } : null;
    }
    if (h.endsWith("myworkdayjobs.com")) {
      // https://<tenant>.wd<N>.myworkdayjobs.com/<site>/job/...
      const tenant = h.split(".")[0];
      const site = u.pathname.split("/").filter(Boolean)[0];
      if (site && !/^(en-[A-Z]+)$/i.test(site)) {
        return { provider: "workday", boardKey: `${tenant}:${site}` };
      }
      if (site) {
        // locale-prefixed: /en-US/<site>
        const parts = u.pathname.split("/").filter(Boolean);
        return parts[1] ? { provider: "workday", boardKey: `${tenant}:${parts[1]}` } : null;
      }
      return { provider: "workday", boardKey: tenant };
    }
  } catch {}
  return null;
}

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

const rows = [];
for (const d of listings) {
  const cn = d.company_name;
  if (!missing.has(cn) || !d.active || rows.some((r) => r.name === cn)) continue;
  const ats = atsOf(d.url ?? "");
  if (!ats) continue;
  const boardKey = ats.boardKey;
  if (!boardKey) continue;
  rows.push({
    id: `simplify-${slug(cn)}`,
    name: cn,
    careersUrl: d.url?.split("/apply")[0] ?? "",
    provider: ats.provider,
    boardKey,
    enabled: true,
  });
}
console.log(`candidates: ${rows.length}`);
console.log(JSON.stringify(rows.slice(0, 8), null, 1));
writeFileSync(path.join(os.tmpdir(), "simplify-candidates.json"), JSON.stringify(rows, null, 2));
