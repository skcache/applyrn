import {
  contentHash,
  type CompanyConfig,
  type JobRecord,
  type NormalizedJob,
} from "@applyrn/domain";

/**
 * Pure detection engine: baseline, dedupe, edit detection, and the
 * active/inactive lifecycle. No I/O. The repository layer applies the
 * decisions; the notifier sends only for decisions that require it.
 *
 * Invariants guaranteed here:
 * - First successful poll for a company => every fetched job is BASELINE, and
 *   baseline jobs never alert.
 * - A job unseen after baseline is NEW exactly once. Replays of the same
 *   board produce UNCHANGED only.
 * - A materially edited job is EDITED, never a second NEW.
 * - A job absent from 2 consecutive successful polls becomes INACTIVE.
 * - An inactive job that reappears is REOPENED and may alert again.
 */

/** How many consecutive absences mark a job inactive (PRD section 10.3). */
export const INACTIVE_AFTER_ABSENCES = 2;

export type DetectionDecision =
  | { kind: "baseline"; job: NormalizedJob }
  | { kind: "new"; job: NormalizedJob }
  | { kind: "unchanged"; externalJobId: string }
  | { kind: "edited"; job: NormalizedJob }
  | { kind: "missing"; externalJobId: string; absentCount: number; nowInactive: boolean }
  | { kind: "reopened"; job: NormalizedJob };

export type DetectInput = {
  company: CompanyConfig;
  fetched: NormalizedJob[];
  existing: JobRecord[];
  /** True when the company has no successful poll yet (first-run baseline). */
  firstRun: boolean;
};

export async function detectJobs(input: DetectInput): Promise<DetectionDecision[]> {
  const { fetched, existing, firstRun } = input;

  if (firstRun) {
    return fetched.map((job) => ({ kind: "baseline" as const, job }));
  }

  const decisions: DetectionDecision[] = [];
  const existingById = new Map(existing.map((j) => [j.externalJobId, j]));
  const seenExternalIds = new Set<string>();

  for (const job of fetched) {
    seenExternalIds.add(job.externalJobId);
    const prev = existingById.get(job.externalJobId);
    if (!prev) {
      decisions.push({ kind: "new", job });
      continue;
    }
    if (prev.status === "inactive") {
      decisions.push({ kind: "reopened", job });
      continue;
    }
    const hash = await contentHash(job);
    if (hash === prev.contentHash) {
      decisions.push({ kind: "unchanged", externalJobId: job.externalJobId });
    } else {
      decisions.push({ kind: "edited", job });
    }
  }

  // Jobs we knew about that are absent this poll.
  for (const prev of existing) {
    if (seenExternalIds.has(prev.externalJobId)) continue;
    if (prev.status === "inactive") continue; // already gone; nothing to do
    const absentCount = prev.absentCount + 1;
    const nowInactive = absentCount >= INACTIVE_AFTER_ABSENCES;
    decisions.push({
      kind: "missing",
      externalJobId: prev.externalJobId,
      absentCount,
      nowInactive,
    });
    // Keep the decision output deterministic (sorted by external id).
  }

  // Deterministic ordering: fetched order first, then missing by id.
  decisions.sort((a, b) => {
    const ka = decisionKey(a);
    const kb = decisionKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return decisions;
}

function decisionKey(d: DetectionDecision): string {
  switch (d.kind) {
    case "baseline":
    case "new":
    case "edited":
    case "reopened":
      return `${d.kind}:${d.job.externalJobId}`;
    case "unchanged":
      return `unchanged:${d.externalJobId}`;
    case "missing":
      return `missing:${d.externalJobId}`;
  }
}

/** True when this decision must produce a Telegram alert. */
export function shouldAlert(d: DetectionDecision): boolean {
  return d.kind === "new" || d.kind === "reopened";
}

/** True when this decision must be persisted. Baseline persists silently. */
export function shouldPersist(d: DetectionDecision): boolean {
  return d.kind !== "unchanged";
}

/** The job to persist/notify for a decision, when present. */
export function jobOf(d: DetectionDecision): NormalizedJob | null {
  switch (d.kind) {
    case "baseline":
    case "new":
    case "edited":
    case "reopened":
      return d.job;
    default:
      return null;
  }
}
