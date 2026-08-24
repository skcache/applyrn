/**
 * V3 §6 — ICS (iCalendar) attachment parsing for interview invites.
 *
 * Zero-dependency parser for the subset of RFC 5545 that interview invites
 * actually use: VEVENT with DTSTART/DTEND/SUMMARY/LOCATION. Handles:
 *   - line folding (continuation lines start with a space/tab)
 *   - UTC form          DTSTART:20260901T170000Z
 *   - offset form       DTSTART;TZO=...:20260901T170000+0000 — treated as-is
 *   - floating local    DTSTART:20260901T170000  → interpreted as UTC (documented
 *                         limitation; invites from US ATSes are usually UTC)
 *   - all-day           DTSTART;VALUE=DATE:20260901 → midnight UTC
 */

export type IcsEvent = {
  start: string | null; // ISO
  end: string | null;
  summary: string | null;
  location: string | null;
};

/** Unfold continuation lines and split into property records. */
function unfold(ics: string): string[] {
  const rawLines = ics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out.filter((l) => l.length > 0);
}

/** Convert an iCal date(-time) value to ISO. Returns null when unparseable. */
export function parseIcsDate(value: string): string | null {
  // TZID-parameter times arrive via the prop (handled by caller); a raw value
  // with an explicit numeric offset (20260901T170000-0700) is honored here.
  const v = value.trim();
  const off = v.match(/^(\d{8}T\d{6})([+-]\d{4})$/);
  if (off) {
    const base = parseIcsDate(off[1] ?? "");
    if (!base) return null;
    const sign = off[2]?.[0] === "-" ? -1 : 1;
    const hh = Number(off[2]?.slice(1, 3) ?? 0);
    const mm = Number(off[2]?.slice(3, 5) ?? 0);
    const ms = Date.parse(base) - sign * (hh * 3600_000 + mm * 60_000);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  // DATE value: YYYYMMDD
  const dateOnly = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    return new Date(
      Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 0, 0, 0),
    ).toISOString();
  }
  // DATETIME: YYYYMMDDTHHMMSS(Z)? or YYYYMMDDTHHMM(Z)?
  const dt = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!dt) return null;
  const iso = `${dt[1]}-${dt[2]}-${dt[3]}T${dt[4]}:${dt[5]}:${dt[6] ?? "00"}.000${dt[7] ?? "Z"}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Parse the first VEVENT from an .ics payload. Malformed input returns an
 * event with null fields rather than throwing — a broken invite must not
 * kill the poll.
 */
export function parseIcsEvent(ics: string): IcsEvent {
  const ev: IcsEvent = { start: null, end: null, summary: null, location: null };
  try {
    let inEvent = false;
    for (const line of unfold(ics)) {
      if (line.startsWith("BEGIN:VEVENT")) inEvent = true;
      else if (line.startsWith("END:VEVENT")) break;
      else if (!inEvent || line.startsWith("BEGIN")) continue;

      const sep = line.indexOf(":");
      if (sep === -1) continue;
      const prop = line.slice(0, sep).toUpperCase();
      const value = line.slice(sep + 1);

      if (prop.startsWith("DTSTART")) {
        ev.start = parseIcsDate(value) ?? ev.start;
      } else if (prop.startsWith("DTEND")) {
        ev.end = parseIcsDate(value) ?? ev.end;
      } else if (prop.startsWith("SUMMARY")) {
        ev.summary = value.trim() || null;
      } else if (prop.startsWith("LOCATION")) {
        ev.location = value.trim() || null;
      }
    }
  } catch {
    // fall through with whatever we collected
  }
  return ev;
}
