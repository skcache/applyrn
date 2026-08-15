import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";

/**
 * Applies the real D1 migrations (injected as TEST_MIGRATIONS by
 * vitest.config.ts) to the test database. Runs outside per-test-file
 * storage isolation; applyD1Migrations only applies un-applied migrations,
 * so calling it from every file is safe.
 */
await applyD1Migrations(
  env.DB,
  (env as typeof env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
);
