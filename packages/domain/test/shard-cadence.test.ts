import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CRON_INTERVAL_MINUTES, companyShard, minuteShard, shardCountFor } from "../src/shard.js";

/**
 * Cadence guards (2026-09-23 change: hourly, was ~2 minutes).
 *
 * The primary cron fires every CRON_INTERVAL_MINUTES and each firing runs
 * exactly ONE shard, so every company is polled once per
 * CRON_INTERVAL_MINUTES x shardCount — 12 x 5 = 60 minutes at the current
 * 154-company watchlist. Two invariants keep that promise honest:
 *
 *   1. the wrangler.toml cron step matches CRON_INTERVAL_MINUTES (the
 *      rotation assumes exactly one firing per slot)
 *   2. slot rotation visits EVERY shard within shardCount firings at any
 *      shard count — a wall-clock-minute rotation would pin a single shard
 *      forever once the cron only fires on whole-hour multiples
 */

const wranglerPath = fileURLToPath(new URL("../../../apps/worker/wrangler.toml", import.meta.url));

describe("cron cadence config", () => {
  it("keeps the wrangler.toml cron step in sync with CRON_INTERVAL_MINUTES", () => {
    const toml = readFileSync(wranglerPath, "utf8");
    const listMatch = toml.match(/^crons\s*=\s*\[([^\]]*)\]/m);
    expect(listMatch, "wrangler.toml must declare a crons array").toBeTruthy();
    const entries = [...listMatch![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    // One expression only: the rotation math assumes every firing runs the
    // poll cycle; a second (e.g. Gmail-only) cron would need handler changes.
    expect(entries).toHaveLength(1);

    const [minute] = entries[0]!.split(" ");
    const step = minute!.match(/^\*\/(\d+)$/);
    expect(step, `expected a */N minute cron, got "${entries[0]}"`).toBeTruthy();
    expect(Number(step![1])).toBe(CRON_INTERVAL_MINUTES);
    // Whole firings per hour keeps the cadence arithmetic clean.
    expect(60 % CRON_INTERVAL_MINUTES).toBe(0);
  });

  it("rotates through every shard within shardCount firings, for any shard count", () => {
    const base = Date.parse("2026-09-23T00:00:00Z");
    const slotAt = (slot: number) =>
      new Date(base + slot * CRON_INTERVAL_MINUTES * 60_000).toISOString();

    for (const k of [1, 2, 3, 4, 5, 6, 8, 12]) {
      const slots = Array.from({ length: k }, (_, i) =>
        minuteShard(slotAt(i), k, CRON_INTERVAL_MINUTES),
      );
      expect(new Set(slots).size, `k=${k} must cover every shard`).toBe(k);
      // Slot k wraps back to shard 0: the rotation period is exactly
      // CRON_INTERVAL_MINUTES x shardCount minutes.
      expect(minuteShard(slotAt(k), k, CRON_INTERVAL_MINUTES)).toBe(slots[0]);
    }
  });

  it("polls each company exactly once per rotation across a 154-company watchlist", () => {
    const ids = Array.from({ length: 154 }, (_, i) => `company-${String(i).padStart(3, "0")}`);
    const k = shardCountFor(ids.map((id) => ({ id })));
    expect(k).toBeGreaterThan(1);

    const base = Date.parse("2026-09-23T00:00:00Z");
    const seen = new Map<string, number>();
    for (let slot = 0; slot < k; slot++) {
      const now = new Date(base + slot * CRON_INTERVAL_MINUTES * 60_000).toISOString();
      const shard = minuteShard(now, k, CRON_INTERVAL_MINUTES);
      for (const id of ids) {
        if (companyShard(id, k) === shard) seen.set(id, (seen.get(id) ?? 0) + 1);
      }
    }
    expect(seen.size).toBe(ids.length);
    for (const count of seen.values()) expect(count).toBe(1);
  });
});
