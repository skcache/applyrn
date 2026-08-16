import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        // Default to the live production worker; override with
        // DASHBOARD_API_TARGET=http://localhost:8787 for local dev.
        target:
          process.env.DASHBOARD_API_TARGET ?? "https://applyrn-worker.siddhankuwar116.workers.dev",
        changeOrigin: true,
      },
    },
  },
});
