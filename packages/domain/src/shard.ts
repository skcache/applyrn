/**
 * Deterministic sharding helpers (audit 2026-08-22 W2).
 *
 * Lives in @applyrn/domain (pure functions, no I/O) so EVERY consumer —
 * the scheduler, D1Repository.getSystemStatus, the /api/tick sweep, and
 * therefore the GitHub fallback matrix — computes the SAME shard count
 * from the same hash-aware formula. Previously repo.ts mirrored a weaker
 * ceil(n/40) formula while the scheduler used this data-driven one, so
 * the two fallback triggers under-covered the tail buckets whenever the
 * id hash overfilled a bucket (exactly during primary-cron outages, the
 * scenario the fallbacks exist for).
 */

/** Free-plan hard cap: 50 subrequests per invocation. */
export const MAX_FETCHES_PER_INVOCATION = 40;

/**
 * Smallest shard count whose worst hash bucket fits the per-invocation
 * fetch budget. ceil(n / MAX) is a lower bound but NOT a guarantee: the
 * company-id hash is imperfect and can overfill a bucket (measured: 160
 * ids -> 41 in one bucket), so the count must come from the real
 * distribution.
 */
export function shardCountFor(companies: readonly { id: string }[]): number {
  let k = Math.max(1, Math.ceil(companies.length / MAX_FETCHES_PER_INVOCATION));
  while (true) {
    const buckets = new Array<number>(k).fill(0);
    for (const c of companies) {
      const idx = companyShard(c.id, k);
      buckets[idx] = (buckets[idx] ?? 0) + 1;
    }
    let worst = 0;
    for (const n of buckets) if (n > worst) worst = n;
    if (worst <= MAX_FETCHES_PER_INVOCATION) return k;
    k++; // one more shard reduces every bucket; iterate until within budget
  }
}

/** Stable bucket for a company: same id always lands in the same shard. */
export function companyShard(companyId: string, shardCount: number): number {
  let h = 0;
  for (let i = 0; i < companyId.length; i++) {
    h = (h * 31 + companyId.charCodeAt(i)) >>> 0;
  }
  return h % shardCount;
}

/** Which shard runs on this minute; 1-min cron rotates shards round-robin. */
export function minuteShard(now: string, shardCount: number): number {
  return Math.floor(new Date(now).getTime() / 60_000) % shardCount;
}
