/**
 * Real-Chrome browser adapter (puppeteer-core). Launches the user's own
 * Chrome with their existing profile so SSO/logged-in sessions work, drives
 * pages via the BrowserLike contract, and exposes a separate, explicit
 * submit action that is ONLY called after human approval.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserLike } from "./browser-agent.js";

type PuppeteerPage = {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  setViewport(viewport: { width: number; height: number }): Promise<void>;
  evaluate<T>(fn: string | ((arg?: unknown) => unknown), arg?: unknown): Promise<T>;
  type(selector: string, value: string): Promise<void>;
  uploadFile(selector: string, path: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, opts?: Record<string, unknown>): Promise<unknown>;
  screenshot(opts: Record<string, unknown>): Promise<unknown>;
};

type PuppeteerBrowser = {
  newPage(): Promise<PuppeteerPage>;
  close(): Promise<void>;
};

export const CHROME_PATHS =
  process.platform === "darwin"
    ? [
        // Automation-first: the headless shell launches reliably in any context;
        // installed Chrome/Brave can be blocked by macOS TCC in background shells.
        path.join(
          os.homedir(),
          "Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell",
        ),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ]
    : process.platform === "linux"
      ? ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]
      : ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"];

/** Find an installed Chromium-family browser. */
export async function findChrome(): Promise<string> {
  for (const p of CHROME_PATHS) {
    try {
      await fs.access(p);
      return p;
    } catch {
      continue;
    }
  }
  throw new Error("No Chrome/Chromium found. Install Google Chrome or set APPLYRN_CHROME_PATH.");
}

/**
 * Open a BrowserLike session against a real browser. Uses a throwaway
 * profile dir by default (never touches the user's cookies unless
 * opts.useRealProfile — applications often need SSO; opt in explicitly).
 */
export async function launchBrowser(opts?: {
  chromePath?: string;
  headless?: boolean;
  useRealProfile?: boolean;
}): Promise<{ browser: BrowserLike; inner: PuppeteerBrowser }> {
  const { default: puppeteer } = await import("puppeteer-core");
  const executablePath =
    opts?.chromePath ?? process.env.APPLYRN_CHROME_PATH ?? (await findChrome());
  // Audit note (V2): only attach the user's real profile when explicitly
  // requested — SSO-gated application portals may need it. Otherwise launch
  // with NO userDataDir so each session is fully isolated; passing a
  // mkdtemp dir breaks chrome-headless-shell (instant exit).
  const useRealProfile = opts?.useRealProfile === true && process.platform === "darwin";
  const browser = (await puppeteer.launch({
    executablePath,
    headless: opts?.headless ?? true,
    ...(useRealProfile
      ? {
          userDataDir: path.join(os.homedir(), "Library/Application Support/Google/Chrome"),
        }
      : {}),
    // --no-sandbox is required in some CI/container contexts; harmless locally.
    args: ["--no-first-run", "--no-sandbox", "--disable-features=Translate"],
    protocolTimeout: 60_000,
  })) as unknown as PuppeteerBrowser;

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 }).catch(() => undefined);

  const browserLike: BrowserLike = {
    async goto(url) {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 45_000 });
    },
    async evaluate<T>(fn: string): Promise<T> {
      // fn is a serialized IIFE string from browser-agent.ts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await page.evaluate(fn as any)) as T;
    },
    async evaluateWithArgs<T, A>(fn: string, arg: A): Promise<T> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await page.evaluate(fn as any, arg)) as T;
    },
    async type(selector: string, value: string): Promise<boolean> {
      try {
        await page.waitForSelector(selector, { timeout: 5_000 });
        await page.type(selector, value);
        return true;
      } catch {
        return false;
      }
    },
    async uploadFile(selector: string, filePath: string): Promise<boolean> {
      try {
        const el = await page.waitForSelector(selector, { timeout: 5_000 });
        if (!el) return false;
        await (el as unknown as { uploadFile(p: string): Promise<void> }).uploadFile(filePath);
        return true;
      } catch {
        return false;
      }
    },
    async clickNext(): Promise<boolean> {
      try {
        // Click "Continue"/"Next" — never "Submit" (that is approveSubmission's job).
        const clicked = await page.evaluate(`(() => {
          const btns = Array.from(document.querySelectorAll('button, input[type=submit], a'));
          const next = btns.find(b => /^(continue|next)$/i.test((b.textContent || b.value || '').trim()));
          if (next) { next.click(); return true; }
          return false;
        })()`);
        return Boolean(clicked);
      } catch {
        return false;
      }
    },
    close: async () => {
      await browser.close().catch(() => undefined);
    },
  };

  return { browser: browserLike, inner: browser };
}
