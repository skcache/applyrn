/**
 * Structured logger: one JSON line per event, so Cloudflare logs are
 * greppable and queryable (PRD Issue 11 observability).
 *
 * Levels: info (cycle summaries, heartbeat), warn (recoverable failures),
 * error (unexpected). No secrets are ever logged; callers decide fields.
 */

export type LogFields = Record<string, string | number | boolean | null | undefined>;

function emit(level: "info" | "warn" | "error", event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};
