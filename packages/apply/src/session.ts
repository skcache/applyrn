/**
 * ApplyRN V2 — application session state machine (PRD §22).
 *
 *   detected → approved → filling → review → submitting → submitted
 *                    ↘ paused (unknown/sensitive) ↙
 *                                 → abandoned
 *
 * Invariants:
 * - NOTHING submits without an explicit `approveSubmission` after the user
 *   has seen the filled-form summary.
 * - Every pause records WHY, so the runner can surface one consolidated
 *   "need your input on N fields" message instead of a ping per field.
 * - Sessions are pure state + event log: persistence and browser live in
 *   the app-runner; this module stays fully unit-testable.
 */

export type SessionStatus =
  | "pending_approval" // created from a job alert; waiting for the human
  | "approved" // human said go; agent may open the form
  | "filling" // agent is working through fields
  | "paused" // agent needs input on ≥1 field
  | "review" // form filled as far as possible; awaiting submit approval
  | "submitting" // human approved submission; agent pressing the button
  | "submitted" // done
  | "failed" // browser/board error (retryable)
  | "abandoned"; // human closed it out

export type PausedField = {
  label: string;
  key: string | null;
  reason: string;
  required: boolean;
};

export type ApplicationSession = {
  id: string;
  jobId: string;
  company: string;
  jobTitle: string;
  applyUrl: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /** Fields the agent filled, for the review summary. */
  filled: { key: string; label: string; value: string }[];
  /** Fields that blocked full-auto completion. */
  paused: PausedField[];
  /** Free-text notes (e.g. what the human typed into a paused field). */
  notes?: string;
  /** Which resume variant was used (set from RunOptions at approve time). */
  resumeLabel?: string;
};

/** The only legal transitions. Everything else throws. */
const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  pending_approval: ["approved", "abandoned"],
  approved: ["filling", "failed", "abandoned"],
  filling: ["review", "paused", "failed", "abandoned"],
  paused: ["filling", "review", "abandoned"], // resume after human input
  review: ["submitting", "filling", "abandoned"], // back to filling = edits requested
  submitting: ["submitted", "paused", "failed"], // paused = refill verification aborted pre-click
  failed: ["filling", "abandoned"],
  submitted: [],
  abandoned: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: SessionStatus, to: SessionStatus) {
    super(`illegal transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Pure transition: returns a NEW session with updated status/timestamps. */
export function transition(session: ApplicationSession, to: SessionStatus): ApplicationSession {
  if (!TRANSITIONS[session.status].includes(to)) {
    throw new InvalidTransitionError(session.status, to);
  }
  return {
    ...session,
    status: to,
    updatedAt: new Date().toISOString(),
    ...(to === "review" ? {} : {}),
  };
}

/** Human approves the initial run (the PRD's first gate). */
export function approveRun(session: ApplicationSession): ApplicationSession {
  return transition(session, "approved");
}

/**
 * Agent reports its fill pass result: what it filled, what blocked.
 * Filling with zero pauses goes straight to review; any pause stops there.
 * (approved → filling happens implicitly as the agent starts work.)
 */
export function recordFillPass(
  session: ApplicationSession,
  filled: ApplicationSession["filled"],
  paused: PausedField[],
): ApplicationSession {
  // I3 fix: multi-step forms fill page-by-page. ACCUMULATE fields across
  // passes (merged by key) so the review summary and submit refill see every
  // field from every step — not just the last pass.
  const merged = new Map(session.filled.map((f) => [f.key || f.label, f]));
  for (const f of filled) merged.set(f.key || f.label, f);
  const allFilled = [...merged.values()];
  const withFills = { ...session, filled: allFilled, paused };
  const inFlight = withFills.status === "approved" ? transition(withFills, "filling") : withFills;
  return transition(inFlight, paused.length > 0 ? "paused" : "review");
}

/** Human supplied answers/values for the paused fields; agent resumes. */
export function resolvePauses(
  session: ApplicationSession,
  resolutions: Record<string, string>,
): ApplicationSession {
  // I13 fix: accept BOTH "<label>=<value>" and "<n>=<value>" (1-based paused
  // index) — labels contain spaces and can't round-trip through compact
  // Telegram replies.
  const byLabel = new Map(session.paused.map((p, i) => [p.label, { ...p, _n: String(i + 1) }]));
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(resolutions)) {
    const hit = session.paused.find((p) => p.label === k) ?? session.paused[Number(k) - 1] ?? null;
    if (hit) normalized[hit.label] = v;
    else normalized[k] = v; // unknown keys pass through unchanged
  }
  void byLabel;
  const resolvedPaused = session.paused.filter((p) => !normalized[p.label]);
  const extraFilled = Object.entries(normalized).map(([label, value]) => ({
    key: session.paused.find((p) => p.label === label)?.key ?? "manual",
    label,
    value,
  }));
  const next: ApplicationSession = {
    ...session,
    filled: [...session.filled, ...extraFilled],
    paused: resolvedPaused,
  };
  return transition(next, resolvedPaused.length > 0 ? "paused" : "review");
}

/** Final human gate: explicit consent before anything is sent. */
export function approveSubmission(session: ApplicationSession): ApplicationSession {
  if (session.status !== "review") {
    throw new InvalidTransitionError(session.status, "submitting");
  }
  return transition(session, "submitting");
}
