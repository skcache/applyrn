import { describe, expect, it } from "vitest";
import { pollGmail, type GmailRepo } from "../src/gmail.js";
import { ALL_STATUSES } from "../src/lifecycle.js";

/**
 * I4 regression: a duplicate (replayed) classified event must still promote
 * its application. The old `!inserted → continue` silently dropped the
 * transition whenever anything threw between insert and recordApplicationEvent,
 * permanently losing it.
 */

function fakeRepo(overrides: Partial<GmailRepo> = {}): {
  repo: GmailRepo;
  events: { eventClass: string; from: string; to: string; emailEventId: number | null }[];
} {
  const events: {
    eventClass: string;
    from: string;
    to: string;
    emailEventId: number | null;
  }[] = [];
  let status = "APPLIED" as string;
  const repo: GmailRepo = {
    getGmailRefreshToken: async () => "fake-refresh-token",
    saveGmailRefreshToken: async () => undefined,
    insertEmailEvent: async () => 42, // same rowid even on "duplicate"
    hasEmailEvent: async () => false,
    getLastGmailHistoryId: async () => null,
    saveGmailHistoryId: async () => undefined,
    setApplicationDeadline: async () => undefined,
    listApplicationsWithUpcomingDeadlines: async () => [],
    markDeadlineReminded: async () => undefined,
    setInterviewSchedule: async () => undefined,
    getIcsAttachment: async () => null,
    findApplicationByDomain: async () => ({
      id: 7,
      company: "Acme",
      role: "SWE Intern",
    }),
    createApplication: async () => 8,
    getApplicationStatus: async () => status,
    recordApplicationEvent: async (input: {
      applicationId: number;
      eventClass: string;
      emailEventId?: number | null;
      fromStatus: string;
      toStatus: string;
      occurredAt: string;
      now: string;
    }) => {
      events.push({
        eventClass: input.eventClass,
        from: input.fromStatus,
        to: input.toStatus,
        emailEventId: input.emailEventId ?? null,
      });
      status = input.toStatus;
    },
    correctApplicationStatus: async () => undefined,
    ...overrides,
  } as never;
  return { repo, events };
}

const env = {
  GOOGLE_CLIENT_ID: "x",
  GOOGLE_CLIENT_SECRET: "y",
};

async function stubGmailApi(repo: GmailRepo) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/messages?")) {
      return new Response(JSON.stringify({ messages: [{ id: "msg-1" }], historyId: "900" }), {
        status: 200,
      });
    }
    if (url.includes("/messages/msg-1")) {
      const payload = {
        id: "msg-1",
        threadId: "t1",
        historyId: "900",
        internalDate: Date.now().toString(),
        payload: {
          headers: [
            { name: "From", value: '"Acme Careers" <careers@acme.greenhouse.io>' },
            { name: "Subject", value: "Update on your application" },
            { name: "Date", value: new Date().toUTCString() },
          ],
          parts: [],
          body: {
            data: Buffer.from("we have decided to move forward with other candidates").toString(
              "base64url",
            ),
          },
        },
      };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "at-123", expires_in: 3600 }), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  void repo;
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe("pollGmail replay-safety (I4)", () => {
  it("duplicate event still promotes and threads emailEventId", async () => {
    const { repo, events } = fakeRepo({
      // Simulate the duplicate path: the row already exists → null rowid.
      insertEmailEvent: async () => null,
    });
    const restore = await stubGmailApi(repo);
    try {
      const outcome = await pollGmail(env, repo, new Date().toISOString());
      expect(outcome.ok).toBe(true);
      // The rejection email must STILL promote APPLIED→REJECTED despite being
      // a duplicate insert.
      expect(events).toHaveLength(1);
      expect(events[0]?.eventClass).toBe("rejection");
      expect(events[0]?.from).toBe("APPLIED");
      expect(events[0]?.to).toBe("REJECTED");
    } finally {
      restore();
    }
  });

  it("non-ATS senders are stored but never promote (run-3 F1)", async () => {
    const { repo, events } = fakeRepo();
    const restore = await stubGmailApi(repo);
    try {
      // Poison attempt: random sender, subject contains company tokens + a
      // rejection phrase. Must NOT touch application 7's status.
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/messages?")) {
          return new Response(
            JSON.stringify({ messages: [{ id: "msg-evil" }], historyId: "901" }),
            { status: 200 },
          );
        }
        if (url.includes("/messages/msg-evil")) {
          const payload = {
            id: "msg-evil",
            threadId: "t2",
            historyId: "901",
            internalDate: Date.now().toString(),
            payload: {
              headers: [
                { name: "From", value: '"Random Person" <spam@evil.example>' },
                {
                  name: "Subject",
                  value: "Acme SWE Intern update — unable to offer you a position",
                },
                { name: "Date", value: new Date().toUTCString() },
              ],
              parts: [],
              body: {
                data: Buffer.from("sorry, no longer under consideration").toString("base64url"),
              },
            },
          };
          return new Response(JSON.stringify(payload), { status: 200 });
        }
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "at-evil", expires_in: 3600 }), {
            status: 200,
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch;
      const outcome = await pollGmail(env, repo, new Date().toISOString());
      expect(outcome.ok).toBe(true);
      expect(events).toHaveLength(0); // no promotion
      expect(outcome.promoted).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("ALL_STATUSES whitelist covers every lifecycle state", () => {
    expect(ALL_STATUSES).toContain("APPLIED");
    expect(ALL_STATUSES).toContain("OA");
    expect(ALL_STATUSES).toContain("INTERVIEW");
    expect(ALL_STATUSES).toContain("OFFER");
    expect(ALL_STATUSES).toContain("REJECTED");
    expect(ALL_STATUSES).toContain("WITHDRAWN");
  });
});
