/**
 * V3 §5 — deadline reminder sweep.
 *
 * Runs on the same cron as the Gmail poll. Pings Telegram (audible) for
 * applications whose assessment deadline falls within the reminder window
 * and hasn't been reminded yet. One reminder per deadline — no nagging.
 */

import type { GmailRepo } from "./gmail.js";
import { log } from "./logger.js";

/** Remind when the deadline is within this many hours. */
export const REMINDER_WINDOW_HOURS = 48;

export type ReminderOutcome = {
  reminded: number;
  errors: number;
};

export async function sweepDeadlines(
  repo: GmailRepo,
  now: string,
  notify: (message: string, opts?: { silent?: boolean }) => Promise<void>,
): Promise<ReminderOutcome> {
  const outcome: ReminderOutcome = { reminded: 0, errors: 0 };
  let due;
  try {
    due = await repo.listApplicationsWithUpcomingDeadlines(now, REMINDER_WINDOW_HOURS);
  } catch (err) {
    log.warn(`deadline sweep: list failed ${err instanceof Error ? err.message : err}`);
    return { reminded: 0, errors: 1 };
  }

  for (const app of due) {
    const hoursLeft = Math.max(
      0,
      Math.round((Date.parse(app.deadline_at) - Date.parse(now)) / 3600_000),
    );
    const role = app.role ? ` — ${app.role}` : "";
    try {
      // Tier-1 audible: an expiring OA is exactly what the phone is for.
      await notify(
        `⏰ OA deadline in ~${hoursLeft}h: ${app.company}${role}\nDeadline: ${app.deadline_at}`,
        { silent: false },
      );
      await repo.markDeadlineReminded(app.id, now);
      outcome.reminded++;
    } catch (err) {
      outcome.errors++;
      log.warn(
        `deadline sweep: notify failed for ${app.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return outcome;
}
