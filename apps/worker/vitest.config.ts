import { fileURLToPath } from "node:url";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
      const migrations = await readD1Migrations(migrationsPath);
      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            // Test-only binding: the real migrations, applied in setup.
            TEST_MIGRATIONS: migrations,
            // Synthetic test-only values. Never real secrets in the repo.
            TELEGRAM_BOT_TOKEN: "test-bot-token-000",
            TELEGRAM_CHAT_ID: "000000000",
            DASHBOARD_TOKEN: "test-dashboard-token-000",
          },
        },
      };
    }),
  ],
  test: {
    dir: "test",
    setupFiles: ["./test/apply-migrations.ts"],
    // Seed-heavy integration tests (63-company watchlists, 100-replay
    // idempotency) run slower on CI than on a dev Mac. The 5s default was
    // a timeout cascade risk: a timed-out test aborts mid-cycle and leaks
    // state into the next test in the file.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
