#!/usr/bin/env node
/**
 * V3 coverage fix C1 (2026-08-22): build watchlist rows for Simplify-listed
 * companies we were missing, on adapters we already support. Extracts each
 * company's board key from its listing URL and writes the candidate file for
 * validate-simplify-candidates.mjs (which live-probes every board).
 *
 * Usage: node scripts/build-simplify-watchlist.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const listings = JSON.parse(readFileSync(path.join(os.tmpdir(), "simplify-listings.json"), "utf8"));
const missing = new Set(
  JSON.parse(readFileSync(path.join(os.tmpdir(), "simplify-missing.json"), "utf8")),
);

function atsOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const h = u.host;
  const segs = u.pathname.split("/").filter(Boolean);
  if (h.includes("greenhouse")) {
    // boards.greenhouse.io/<boardKey>/jobs/<id> — key is the first path segment.
    const key = segs[0];
    return key && key !== "embed" ? { provider: "greenhouse", boardKey: key } : null;
  }
  if (h.includes("lever")) {
    const key = segs[0];
    return key ? { provider: "lever", boardKey: key } : null;
  }
  if (h.includes("ashbyhq")) {
    const key = segs[1];
    return key ? { provider: "ashby", boardKey: key } : null;
  }
  if (h.includes("smartrecruiters")) {
    const key = segs[1] ?? segs[0];
    return key ? { provider: "smartrecruiters", boardKey: key } : null;
  }
  if (h.endsWith("myworkdayjobs.com")) {
    // https://<tenant>.wd<N>.myworkdayjobs.com/[<locale>/]<site>/job/...
    const tenant = h.split(".")[0];
    if (segs[0] && /^en-[a-z]{2}(-[A-Z]{2})?$/i.test(segs[0])) {
      return segs[1] ? { provider: "workday", boardKey: `${tenant}:${segs[1]}` } : null;
    }
    return segs[0] ? { provider: "workday", boardKey: `${tenant}:${segs[0]}` } : null;
  }
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
  if (!ats?.boardKey) continue;
  rows.push({
    id: `simplify-${slug(cn)}`,
    name: cn,
    careersUrl: d.url?.split("/apply")[0] ?? "",
    provider: ats.provider,
    boardKey: ats.boardKey,
    enabled: true,
  });
}
console.log(`candidates: ${rows.length}`);
writeFileSync(path.join(os.tmpdir(), "simplify-candidates.json"), JSON.stringify(rows, null, 2));
