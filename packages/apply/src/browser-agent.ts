/**
 * ApplyRN V2 — browser form agent (PRD §22).
 *
 * Opens the apply URL in the user's real Chrome (puppeteer-core, no bundled
 * Chromium), inventories visible form fields, plans each via planField(),
 * fills what it can, and returns a structured report for the session
 * state machine. It NEVER clicks a final submit — submission happens only
 * after the human reviews and approves (the runner performs the click in a
 * separate, explicitly-approved step).
 *
 * Dry-run mode (default for tests): everything except actual typing —
 * produces the same report without touching the page.
 */

import type { ApplicationProfile, FieldPlan } from "./profile.js";
import { planField } from "./profile.js";

export type InventoryField = {
  label: string;
  required: boolean;
  type:
    "text" | "email" | "tel" | "textarea" | "select" | "file" | "checkbox" | "radio" | "unknown";
  selector: string;
};

export type FillResult = {
  filled: { key: string; label: string; value: string }[];
  paused: { label: string; key: string | null; reason: string; required: boolean }[];
  /** True when the page looks like a multi-step application (more pages follow). */
  hasNextStep: boolean;
};

/** Inventory visible form fields on the current page. Runs IN the page. */
export function inventoryFields(): InventoryField[] {
  // labelForElement must be inlined here: this function is serialized via
  // toString() and evaluated inside the page, where closures don't exist.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function labelForElement(el: any): string {
    const id = el.id;
    if (id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label && label.textContent && label.textContent.trim()) return label.textContent.trim();
      } catch {
        // Malformed id (CSS.escape failure): fall through to other label sources.
      }
    }
    const wrapping = el.closest("label");
    if (wrapping && wrapping.textContent && wrapping.textContent.trim())
      return wrapping.textContent.trim();
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const name = el.getAttribute("name");
    if (name && name.trim()) return name.trim().replace(/[_-]/g, " ");
    const placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim();
    return "";
  }

  const controls = Array.from(
    document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select',
    ),
  );
  const out: InventoryField[] = [];
  for (const el of controls) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const type =
      el.tagName === "TEXTAREA"
        ? "textarea"
        : el.tagName === "SELECT"
          ? "select"
          : el.tagName === "INPUT"
            ? (((el as HTMLInputElement).type as InventoryField["type"]) ?? "text")
            : "unknown";
    const required = (el as HTMLInputElement).required || el.hasAttribute("aria-required");
    out.push({
      label: labelForElement(el),
      required,
      type,
      selector: el.id
        ? `#${el.id}`
        : el.getAttribute("name")
          ? `[name="${el.getAttribute("name")}"]`
          : "",
    });
  }
  return out;
}

/**
 * Fill one field on the page. Native setter + input event so React-controlled
 * forms register the change. File inputs are NOT auto-filled here — the
 * runner handles resume upload via elementHandle.uploadFile (paths never
 * enter the page context).
 */
export function fillField(selector: string, value: string): boolean {
  const el = document.querySelector(selector) as
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (!el) return false;
  if (el instanceof HTMLSelectElement) {
    const match = Array.from(el.options).find(
      (o) =>
        o.value.toLowerCase() === value.toLowerCase() ||
        o.text.toLowerCase() === value.toLowerCase(),
    );
    if (!match) return false;
    el.value = match.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) return false;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

export type BrowserLike = {
  goto(url: string): Promise<void>;
  /** Runs a function in the page and returns its JSON result. */
  evaluate<T>(fn: string): Promise<T>;
  evaluateWithArgs<T, A>(fn: string, arg: A): Promise<T>;
  type(selector: string, value: string): Promise<boolean>;
  uploadFile(selector: string, path: string): Promise<boolean>;
  clickNext(): Promise<boolean>;
  screenshotPath?: string;
  close(): Promise<void>;
};

/**
 * Run one fill pass over the current page. Pure orchestration: browser is
 * injected so tests can use a fake.
 */
export async function runFillPass(
  browser: BrowserLike,
  profile: ApplicationProfile,
  opts?: { resumePath?: string; dryRun?: boolean },
): Promise<FillResult> {
  const fields = await browser.evaluate<InventoryField[]>(`(${inventoryFields.toString()})()`);
  const filled: FillResult["filled"] = [];
  const paused: FillResult["paused"] = [];

  for (const field of fields) {
    if (!field.selector) {
      paused.push({
        label: field.label || "(unlabeled field)",
        key: null,
        reason: "field has no stable selector",
        required: field.required,
      });
      continue;
    }
    const plan: FieldPlan = planField(field, profile);
    if (plan.action === "pause") {
      paused.push({
        label: field.label,
        key: plan.key,
        reason: plan.reason,
        required: field.required,
      });
      continue;
    }
    if (plan.key === "resume" && opts?.resumePath) {
      if (!opts.dryRun) await browser.uploadFile(field.selector, opts.resumePath);
      filled.push({ key: "resume", label: field.label, value: opts.resumePath });
      continue;
    }
    if (opts?.dryRun) {
      filled.push({ key: plan.key, label: field.label, value: plan.value });
      continue;
    }
    const ok = await browser.type(field.selector, plan.value);
    if (ok) {
      filled.push({ key: plan.key, label: field.label, value: plan.value });
    } else {
      paused.push({
        label: field.label,
        key: plan.key,
        reason: "type attempt failed (element not interactable?)",
        required: field.required,
      });
    }
  }

  const hasNextStep = await browser
    .evaluate<boolean>(
      `(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type=submit], a'));
      return btns.some(b => /^(continue|next|submit application)$/i.test((b.textContent || b.value || '').trim()));
    })()`,
    )
    .then((v) => Boolean(v));

  return { filled, paused, hasNextStep };
}
