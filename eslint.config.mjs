import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.wrangler/**",
      "**/coverage/**",
      "engineering-notebook.html",
      "**/worker-configuration.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node scripts (watchlist/soak tooling + the V2 apply CLI) run outside
    // the browser/worker.
    files: ["scripts/**/*.mjs", "apps/apply-cli/**/*.mjs", "packages/apply/scripts/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
