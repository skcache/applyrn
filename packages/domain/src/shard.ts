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
 * Primary cron firing interval in minutes (cadence change 2026-09-23).
 *
 * MUST match the `crons` expression in apps/worker/wrangler.toml (six
 * firings per hour, one every 10 minutes). Each firing handles ONE shard, so
 * a company is polled once per CRON_INTERVAL_MINUTES x shardCount — with the
 * current 226-company prod watchlist (shardCount 7, worst bucket 40) that is
 * 70 minutes per company (previously ~5 minutes), and invocation volume
 * drops 1440 -> 144 per day. shardCountFor raises the shard count as the
 * watchlist grows, so the realized cadence stretches in step
 * (10 x k minutes); the per-company poll_interval_seconds gate (3600) is the
 * hard floor that keeps any extra trigger (pinger, GitHub fallback) from
 * polling a company early.
 */
export const CRON_INTERVAL_MINUTES = 10;

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

/**
 * Which shard runs in this cron firing slot. Rotation is by firing SLOT,
 * not by wall-clock minute, so every shard is visited once per shardCount
 * firings at ANY cron period: consecutive firings advance the slot by one
 * and `slot % shardCount` cycles through all buckets. A naive minute-based
 * rotation pins a single shard forever when the cron only fires on exact
 * hour multiples (an hourly cron always evaluates minute 0).
 *
 * `periodMinutes` is the cron firing interval in minutes.
 */
export function minuteShard(now: string, shardCount: number, periodMinutes = 1): number {
  return Math.floor(new Date(now).getTime() / (60_000 * periodMinutes)) % shardCount;
}
