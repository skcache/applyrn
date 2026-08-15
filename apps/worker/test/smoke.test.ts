import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker smoke", () => {
  it("health endpoint responds", async () => {
    const res = await exports.default.fetch("https://applyrn-worker.test/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("DB binding is wired", () => {
    expect(env.DB).toBeTruthy();
  });

  it("unknown routes 404", async () => {
    const res = await exports.default.fetch("https://applyrn-worker.test/nope");
    expect(res.status).toBe(404);
  });
});
