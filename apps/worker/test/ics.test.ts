import { describe, expect, it } from "vitest";
import { parseIcsDate, parseIcsEvent } from "../src/ics.js";

const SAMPLE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Acme//Interview Scheduling//EN",
  "BEGIN:VEVENT",
  "UID:abc-123@acme",
  "DTSTAMP:20260823T120000Z",
  "DTSTART:20260901T170000Z",
  "DTEND:20260901T174500Z",
  "SUMMARY:Interview — Jane Doe (Software Engineer Intern) at Acme",
  "LOCATION:https://meet.google.com/xyz-interview",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("V3 §6 ICS parsing", () => {
  it("parses a standard UTC invite", () => {
    const ev = parseIcsEvent(SAMPLE);
    expect(ev.start).toBe("2026-09-01T17:00:00.000Z");
    expect(ev.end).toBe("2026-09-01T17:45:00.000Z");
    expect(ev.summary).toContain("Jane Doe");
    expect(ev.location).toContain("meet.google.com");
  });

  it("unfolds folded continuation lines", () => {
    const folded = [
      "BEGIN:VEVENT",
      "DTSTART:20260901T1700",
      "00Z",
      "SUMMARY:Interview with a very long summary line that the sender",
      "  wrapped mid-sentence for no reason",
      "END:VEVENT",
    ].join("\n");
    const ev = parseIcsEvent(folded);
    expect(ev.start).toBe("2026-09-01T17:00:00.000Z");
    expect(ev.summary).toContain("wrapped mid-sentence");
  });

  it("parses all-day DATE values as midnight UTC", () => {
    const ev = parseIcsEvent("BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260915\r\nEND:VEVENT");
    expect(ev.start).toBe("2026-09-15T00:00:00.000Z");
  });

  it("tolerates missing seconds", () => {
    const ev = parseIcsEvent("BEGIN:VEVENT\r\nDTSTART:20260901T170000Z\r\nEND:VEVENT");
    expect(ev.start).toBe("2026-09-01T17:00:00.000Z");
  });

  it("returns null fields for garbage input instead of throwing", () => {
    const ev = parseIcsEvent("this is not an ics file at all <<<>>> ???");
    expect(ev.start).toBeNull();
    expect(ev.summary).toBeNull();
  });

  it("parseIcsDate rejects nonsense", () => {
    expect(parseIcsDate("hello")).toBeNull();
    expect(parseIcsDate("20261345T990000Z")).toBeNull();
  });
});
