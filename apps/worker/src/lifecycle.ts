/**
 * V3 §2 — application lifecycle state machine (guarded hybrid).
 *
 * `application_events` is the source of truth; `applications.status` is a
 * denormalized cache updated ONLY through applyEvent(). Duplicate events of
 * the same class are no-ops (idempotency); illegal transitions are rejected.
 */

/** Every legal status — used to whitelist user-supplied values. */
export const ALL_STATUSES: readonly AppStatus[] = [
  "APPLIED", "OA", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN",
];

export type AppStatus = "APPLIED" | "OA" | "INTERVIEW" | "OFFER" | "REJECTED" | "WITHDRAWN";

/** Which classifier event maps to which status. */
export const EVENT_TO_STATUS: Record<string, AppStatus> = {
  application_confirmation: "APPLIED",
  assessment_invite: "OA",
  interview_invite: "INTERVIEW",
  offer: "OFFER",
  rejection: "REJECTED",
};

/** Legal from→to transitions. `{any}→WITHDRAWN` handled separately. */
const ALLOWED: Record<AppStatus, AppStatus[]> = {
  APPLIED: ["OA", "INTERVIEW", "OFFER", "REJECTED"],
  OA: ["INTERVIEW", "OFFER", "REJECTED"],
  INTERVIEW: ["OFFER", "REJECTED"],
  OFFER: [], // offer is terminal-positive; acceptance happens outside the system
  REJECTED: [],
  WITHDRAWN: [],
};

export type TransitionResult =
  { action: "promote"; to: AppStatus } | { action: "noop"; reason: string };

/**
 * Decide what an incoming event does to the current status.
 * - same-class repeat (e.g. two confirmations) → noop
 * - illegal transition (e.g. OA → APPLIED) → noop
 */
export function planTransition(current: AppStatus, eventClass: string): TransitionResult {
  const to = EVENT_TO_STATUS[eventClass];
  if (!to) return { action: "noop", reason: `event ${eventClass} has no status mapping` };
  if (current === to) return { action: "noop", reason: "duplicate status" };
  if (!ALLOWED[current].includes(to)) {
    return { action: "noop", reason: `illegal transition ${current} -> ${to}` };
  }
  return { action: "promote", to };
}

/** WITHDRAWN is reachable from any non-terminal status. */
export function canWithdraw(current: AppStatus): boolean {
  return current !== "WITHDRAWN" && current !== "OFFER";
}
