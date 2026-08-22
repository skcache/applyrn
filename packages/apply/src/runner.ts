/**
 * ApplyRN V2 — application runner (PRD §22 orchestration).
 *
 * Owns the end-to-end flow for one application session:
 *   1. create session (pending_approval) + notify human on Telegram
 *   2. human taps APPROVE (callback) → session approved
 *   3. runner opens the form, runs fill passes page-by-page
 *   4. paused fields → consolidated "need input" message → human replies
 *   5. review summary → human taps SUBMIT (final gate) → runner clicks submit
 *   6. submitted → confirmation + dashboard status update via worker API
 *
 * The runner is transport-agnostic: Telegram callbacks arrive as plain
 * action objects (TelegramAction), and the host process (CLI or daemon)
 * wires them in. Nothing here talks to Telegram directly.
 */

import type { ApplicationProfile, PausedFieldInput } from "./types.js";
import {
  approveRun,
  approveSubmission,
  recordFillPass,
  resolvePauses,
  transition,
  type ApplicationSession,
} from "./session.js";
import { runFillPass, type BrowserLike, type FillResult } from "./browser-agent.js";

export type TelegramAction =
  | { kind: "approve"; sessionId: string }
  | { kind: "submit"; sessionId: string }
  | { kind: "abandon"; sessionId: string }
  | { kind: "resume"; sessionId: string; answers: Record<string, string> };

export type RunnerHooks = {
  /** Deliver a message to the human (Telegram). */
  notify(message: string, opts?: { actions?: string[][] }): Promise<void>;
  /** Update job status on the worker (best-effort; never throws). */
  setJobStatus?(jobId: string, status: string): Promise<void>;
  /** Persist session state between steps (file/DB; host decides). */
  saveSession?(session: ApplicationSession): Promise<void>;
};

export type RunOptions = {
  profile: ApplicationProfile;
  resumePath?: string;
  /** Max fill passes (multi-step boards). Safety bound. */
  maxSteps?: number;
};

export class ApplicationRunner {
  constructor(
    private readonly hooks: RunnerHooks,
    private readonly newBrowser: () => Promise<BrowserLike>,
  ) {}

  /** Step 1: create + announce. */
  async createSession(
    input: { id: string; jobId: string; company: string; jobTitle: string; applyUrl: string },
    now = new Date().toISOString(),
  ): Promise<ApplicationSession> {
    const session: ApplicationSession = {
      ...input,
      status: "pending_approval",
      createdAt: now,
      updatedAt: now,
      filled: [],
      paused: [],
    };
    await this.hooks.saveSession?.(session);
    await this.hooks.notify(
      `🤖 Ready to apply: ${session.jobTitle} @ ${session.company}\nReview, then approve to start the agent.`,
      { actions: [[`APPROVE ${session.id}`, `ABANDON ${session.id}`], [session.applyUrl]] },
    );
    return session;
  }

  /** Steps 2-4: run the agent after approval. Returns the final session. */
  async run(sessionIn: ApplicationSession, opts: RunOptions): Promise<ApplicationSession> {
    let session = approveRun(sessionIn);
    await this.hooks.saveSession?.(session);
    const browser = await this.newBrowser();
    try {
      await browser.goto(session.applyUrl);
      session = transition(session, "filling");

      let result: FillResult = { filled: [], paused: [], hasNextStep: false };
      const maxSteps = opts.maxSteps ?? 5;
      for (let step = 0; step < maxSteps; step++) {
        result = await runFillPass(browser, opts.profile, {
          resumePath: opts.resumePath,
          dryRun: false,
        });
        session = recordFillPass(session, result.filled, result.paused);
        await this.hooks.saveSession?.(session);

        if (result.paused.length > 0) {
          const lines = result.paused
            .map((p) => `• ${p.label}${p.required ? " (required)" : ""} — ${p.reason}`)
            .join("\n");
          await this.hooks.notify(
            `⏸ Paused — need your input on ${result.paused.length} field(s):\n${lines}\n\nReply with: ANSWER <label>=<value> (one per line)`,
          );
          return session; // host resumes via handleAction(resume)
        }
        if (!result.hasNextStep) break;
        await browser.clickNext();
      }

      await this.hooks.notify(
        `📋 Review before submit — ${session.jobTitle} @ ${session.company}\n` +
          result.filled.map((f) => `• ${f.label}: ${f.value}`).join("\n") +
          "\n\nApprove to SUBMIT for real.",
        { actions: [[`SUBMIT ${session.id}`, `ABANDON ${session.id}`]] },
      );
      return session; // status: review
    } catch (err) {
      session = transition(session, "failed");
      await this.hooks.saveSession?.(session);
      await this.hooks.notify(
        `❌ Agent failed on ${session.jobTitle} @ ${session.company}: ${err instanceof Error ? err.message : "unknown"}\nThe job is still in your dashboard; apply manually if you like.`,
        { actions: [[session.applyUrl]] },
      );
      return session;
    } finally {
      await browser.close();
    }
  }

  /** Steps 5-6: final human gate + submission + status update. */
  async submit(
    session: ApplicationSession,
    submitSelector = 'button[type="submit"], input[type="submit"]',
  ): Promise<ApplicationSession> {
    const gated = approveSubmission(session); // throws unless status === review
    await this.hooks.saveSession?.(gated);
    const browser = await this.newBrowser();
    try {
      await browser.goto(gated.applyUrl);
      // Re-fill everything (stateless page), then click submit once.
      // NOTE: the host must pass the same profile; values come from the session.
      // The runner re-uses the stored filled values verbatim.
      for (const f of gated.filled) {
        await browser.type(`[name="${f.key}"]`, f.value).catch(() => undefined);
      }
      await browser.evaluate(`(() => {
        const btn = document.querySelector('${submitSelector}');
        if (btn) { btn.click(); return true; }
        return false;
      })()`);
      const submitted = transition(gated, "submitted");
      await this.hooks.saveSession?.(submitted);
      await this.hooks.notify(`✅ Submitted: ${submitted.jobTitle} @ ${submitted.company}`);
      await this.hooks.setJobStatus?.(submitted.jobId, "APPLIED");
      return submitted;
    } catch (err) {
      const failed = transition(gated, "failed");
      await this.hooks.saveSession?.(failed);
      await this.hooks.notify(
        `❌ Submit failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
      return failed;
    } finally {
      await browser.close();
    }
  }

  /** Route a Telegram callback to the right transition. */
  async handleAction(
    action: TelegramAction,
    load: (id: string) => Promise<ApplicationSession | null>,
    opts?: RunOptions,
  ): Promise<ApplicationSession | null> {
    const session = await load(action.sessionId);
    if (!session) return null;
    switch (action.kind) {
      case "approve": {
        if (session.status !== "pending_approval" || !opts) return session;
        return this.run(session, opts);
      }
      case "submit":
        return this.submit(session);
      case "abandon": {
        const s = transition(session, "abandoned");
        await this.hooks.saveSession?.(s);
        await this.hooks.notify(`🚫 Abandoned: ${session.jobTitle} @ ${session.company}`);
        return s;
      }
      case "resume": {
        const resumed = resolvePauses(session, action.answers);
        await this.hooks.saveSession?.(resumed);
        if (resumed.status === "review") {
          await this.hooks.notify(
            `📋 All fields resolved — review:\n` +
              resumed.filled.map((f) => `• ${f.label}: ${f.value}`).join("\n"),
            { actions: [[`SUBMIT ${session.id}`, `ABANDON ${session.id}`]] },
          );
        }
        return resumed;
      }
    }
  }
}
