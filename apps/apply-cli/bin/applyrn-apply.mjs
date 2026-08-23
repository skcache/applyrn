#!/usr/bin/env node
/**
 * applyrn-apply — V2 human-supervised application execution (PRD §22).
 *
 * Usage:
 *   applyrn-apply dry-run <job-url>       Inventory a form; fill nothing.
 *   applyrn-apply start <job-id>          Fetch job from worker, create session,
 *                                         send APPROVE button to Telegram.
 *   applyrn-apply listen                  Long-poll Telegram for callbacks
 *                                         (APPROVE/SUBMIT/ABANDON/ANSWER) and
 *                                         drive the runner. Ctrl-C to stop.
 *   applyrn-apply status [session-id]     Show session state(s).
 *
 * Environment (export in your shell profile; no .env loader):
 *   APPLYRN_WORKER_URL      e.g. https://applyrn-worker.<account>.workers.dev
 *   APPLYRN_TOKEN           DASHBOARD_TOKEN
 *   TELEGRAM_BOT_TOKEN      bot that sends alerts + receives callbacks
 *   TELEGRAM_CHAT_ID        your chat
 *   APPLYRN_PROFILE         path to profile JSON (default ~/.applyrn/profile.json)
 *   APPLYRN_RESUME          path to resume PDF (uploaded on request)
 *
 * SAFETY: nothing is ever submitted without you pressing SUBMIT in Telegram
 * after seeing the filled-form review. Sensitive fields always pause.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// R2-9: the misspelled APPLYYRN_* variants used to take precedence over the
// documented names — read ONLY the documented names, in one place.
const WORKER_URL = process.env.APPLYRN_WORKER_URL ?? "";
const TOKEN = process.env.APPLYRN_TOKEN ?? "";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID ?? "";
const PROFILE_PATH =
  process.env.APPLYRN_PROFILE ?? path.join(os.homedir(), ".applyrn", "profile.json");
const SESSIONS_DIR = path.join(os.homedir(), ".applyrn", "sessions");
const RESUME_PATH = process.env.APPLYRN_RESUME;
// Which resume variant this session used (e.g. "backend", "fullstack").
const RESUME_LABEL = process.env.APPLYRN_RESUME_LABEL ?? null;

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function loadProfile() {
  if (!existsSync(PROFILE_PATH)) {
    die(
      `no profile at ${PROFILE_PATH}. Create it with your answers:\n` +
        `{"version":1,"answers":[{"key":"email","value":"you@x.com","kind":"factual"},...],\n "pausedCategories":[],"labelStopList":["ssn","salary"]}`,
    );
  }
  return JSON.parse(readFileSync(PROFILE_PATH, "utf8"));
}

async function workerApi(pathName, init = {}) {
  const res = await fetch(`${WORKER_URL}${pathName}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`worker ${pathName} -> HTTP ${res.status}`);
  return res.json();
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

const sessionPath = (id) => {
  // R2-2 (sec audit run-2): ids are internally generated `s<base36><n>`; any
  // other shape must never touch the filesystem (path traversal).
  if (!/^s[a-z0-9]+$/.test(id)) return null;
  const p = path.join(SESSIONS_DIR, `${id}.json`);
  return p.startsWith(SESSIONS_DIR + path.sep) ? p : null;
};
async function saveSession(session) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2), { mode: 0o600 });
}
async function loadSession(id) {
  const p = sessionPath(id);
  if (!p || !existsSync(p)) return null;
  let s;
  try {
    s = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // malformed file is not a session
  }
  return isValidSession(s) ? s : null;
}

/**
 * R2-2: a loaded session drives browser navigation and form submission —
 * validate the minimum shape before anything trusts it. applyUrl must be
 * http(s); file:// and other schemes are rejected.
 */
function isValidSession(s) {
  return (
    s !== null &&
    typeof s === "object" &&
    typeof s.id === "string" &&
    /^s[a-z0-9]+$/.test(s.id) &&
    typeof s.jobId === "string" &&
    typeof s.applyUrl === "string" &&
    /^https?:\/\//i.test(s.applyUrl) &&
    typeof s.status === "string"
  );
}

// Lazy imports so --help works without puppeteer installed.
async function getRunner() {
  const { ApplicationRunner } = await import("@applyrn/apply");
  const hooks = {
    notify: async (message, opts) => {
      const keyboard = opts?.actions?.map((row) =>
        row.map((labelOrUrl) => ({
          text: labelOrUrl.startsWith("http") ? "OPEN JOB" : labelOrUrl,
          ...(labelOrUrl.startsWith("http") ? { url: labelOrUrl } : { callback_data: labelOrUrl }),
        })),
      );
      await tg("sendMessage", {
        chat_id: TG_CHAT,
        text: message,
        reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
      });
    },
    saveSession,
    setJobStatus: async (jobId, status) => {
      try {
        await workerApi(`/api/jobs/${jobId}/application`, {
          method: "PUT",
          body: JSON.stringify({ status }),
        });
      } catch {
        // Dashboard update is best-effort; the submission itself already happened.
      }
    },
  };
  const { launchBrowser } = await import("@applyrn/apply");
  return new ApplicationRunner(
    hooks,
    async () => (await launchBrowser({ headless: false })).browser,
  );
}

let sessionCounter = 0;
function newSessionId() {
  return `s${Date.now().toString(36)}${sessionCounter++}`;
}

/**
 * Only http(s) URLs may be driven by the agent. Blocks javascript:, data:,
 * file:, and anything else puppeteer would happily navigate to.
 */
function assertHttpUrl(url, what) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    die(`${what} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    die(`${what} must be http(s), got: ${parsed.protocol}`);
  }
  return url;
}

async function cmdDryRun(jobUrl) {
  assertHttpUrl(jobUrl, "job-url");
  const { launchBrowser } = await import("@applyrn/apply");
  const { runFillPass } = await import("@applyrn/apply");
  const profile = loadProfile();
  const { browser, inner } = await launchBrowser({ headless: true });
  try {
    await browser.goto(jobUrl);
    const result = await runFillPass(browser, profile, { dryRun: true });
    console.log("WOULD FILL:");
    for (const f of result.filled) console.log(`  ✓ ${f.label}: ${f.value}`);
    console.log("WOULD PAUSE:");
    for (const p of result.paused) console.log(`  ⏸ ${p.label} — ${p.reason}`);
    console.log(result.hasNextStep ? "(multi-step form detected)" : "(single page)");
  } finally {
    await inner.close();
  }
}

async function cmdStart(jobId) {
  const { jobs } = await workerApi("/api/jobs");
  const job = jobs.find((j) => j.id === jobId || j.externalJobId === jobId);
  if (!job) die(`job ${jobId} not found in the recent tape`);
  const runner = await getRunner();
  await runner.createSession({
    id: newSessionId(),
    jobId: job.id,
    company: job.companyName,
    jobTitle: job.title,
    applyUrl: assertHttpUrl(job.applyUrl || job.jobUrl, "board apply URL"),
  });
  console.log("Session created. Check Telegram to approve.");
}

async function cmdListen() {
  let offset = 0;
  console.log("Listening for Telegram callbacks… (Ctrl-C to stop)");
  const OPERATOR_ID = TG_CHAT ? String(TG_CHAT) : null;
  while (true) {
    let updates;
    try {
      updates = await tg("getUpdates", { timeout: 25, offset });
    } catch (err) {
      // R2-8: network hiccup must not kill the loop; back off and retry.
      console.error(
        `getUpdates failed (${err instanceof Error ? err.message : err}); retrying in 5s`,
      );
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    if (!updates?.ok) {
      // Telegram API error (429/500): back off instead of hot-looping.
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    for (const u of updates.result ?? []) {
      offset = u.update_id + 1;
      const cq = u.callback_query;
      const data = cq?.data;
      if (!data) continue;
      // R2-1 (sec audit run-2): only the operator may drive sessions. Every
      // other sender is dropped before the verb is even parsed.
      if (OPERATOR_ID && String(cq.from?.id ?? "") !== OPERATOR_ID) {
        console.warn(`dropped callback from unauthorized sender ${cq.from?.id}`);
        if (cq.id) await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
        continue;
      }
      const msg = cq?.message;
      const [verb, sessionId, ...rest] = data.split(" ");
      const runner = await getRunner();
      const load = loadSession;
      try {
        if (verb === "APPROVE") {
          const s = await loadSession(sessionId);
          if (!s) continue;
          await runner.handleAction({ kind: "approve", sessionId }, load, {
            profile: loadProfile(),
            resumePath: RESUME_PATH,
            resumeLabel: RESUME_LABEL,
          });
        } else if (verb === "SUBMIT") {
          const s = await loadSession(sessionId);
          if (!s) continue;
          await runner.handleAction({ kind: "submit", sessionId }, load);
        } else if (verb === "ABANDON") {
          await runner.handleAction({ kind: "abandon", sessionId }, load);
        } else if (verb === "ANSWER" && rest.length > 0) {
          // ANSWER <sessionId> <label>=<value> ...
          const answers = {};
          for (const pair of rest) {
            const eq = pair.indexOf("=");
            if (eq > 0) answers[pair.slice(0, eq)] = pair.slice(eq + 1);
          }
          await runner.handleAction({ kind: "resume", sessionId, answers }, load);
        }
      } catch (err) {
        // R2-8: one bad callback/session must not kill the listen loop.
        console.error(`callback '${data}' failed: ${err instanceof Error ? err.message : err}`);
      }
      if (msg?.message_id && cq?.id) {
        await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
      }
    }
  }
}

async function cmdStatus(id) {
  if (id) {
    const s = await loadSession(id);
    console.log(s ? JSON.stringify(s, null, 2) : `no session ${id}`);
    return;
  }
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const files = (await import("node:fs")).readdirSync(SESSIONS_DIR);
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const s = JSON.parse(readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
    console.log(`${s.id}  ${s.status.padEnd(16)} ${s.company} — ${s.jobTitle}`);
  }
}

const [, , cmd, arg] = process.argv;
if (!WORKER_URL || !TOKEN) {
  // dry-run doesn't need the worker
  if (cmd !== "dry-run") die("set APPLYRN_WORKER_URL and APPLYRN_TOKEN");
}
switch (cmd) {
  case "dry-run":
    if (!arg) die("usage: applyrn-apply dry-run <job-url>");
    await cmdDryRun(arg);
    break;
  case "start":
    if (!arg) die("usage: applyrn-apply start <job-id>");
    await cmdStart(arg);
    break;
  case "listen":
    await cmdListen();
    break;
  case "status":
    await cmdStatus(arg);
    break;
  default:
    console.log(
      "applyrn-apply — human-supervised application execution\n\n" +
        "  dry-run <url>   inventory a form, fill nothing\n" +
        "  start <job-id>  create a session + APPROVE button in Telegram\n" +
        "  listen          handle Telegram callbacks\n" +
        "  status [id]     show sessions\n",
    );
}
