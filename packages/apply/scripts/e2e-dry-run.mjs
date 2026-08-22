/**
 * E2E smoke: load a real job board page and inventory form fields — no
 * typing, no clicking, no submission. Verifies the page-side DOM code
 * against real ATS markup. Run after `pnpm --filter @applyrn/apply build`.
 *
 * Usage: node packages/apply/scripts/e2e-dry-run.mjs <url>
 */
import { launchBrowser } from "../dist/real-browser.js";
import { inventoryFields } from "../dist/browser-agent.js";

const url = process.argv[2] ?? "https://example.com";
const { browser, inner } = await launchBrowser({ headless: true });
try {
  await browser.goto(url);
  const fields = await browser.evaluate(`(${inventoryFields.toString()})()`);
  console.log(`Found ${fields.length} field(s) on ${url}:`);
  for (const f of fields) {
    console.log(
      `  [${f.type}]${f.required ? "*" : ""} ${f.label || "(unlabeled)"} -> ${f.selector}`,
    );
  }
} finally {
  await inner.close();
}
