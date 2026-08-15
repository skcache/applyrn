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
          },
        },
      };
    }),
  ],
  test: {
    dir: "test",
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
