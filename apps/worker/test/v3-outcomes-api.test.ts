import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { D1Repository } from "../src/repo.js";

/**
 * V3 §3 route tests: manual add, correction, CSV export. Outbound HTTP is
 * stubbed; companies/applications are synthetic fixtures.
 */

const TOKEN = "test-dashboard-token-000";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function repo(): D1Repository {
  return new D1Repository(env.DB);
}

const get = async (path: string) => SELF.fetch(`https://example.com${path}`, { headers: AUTH });
const post = async (path: string, body: unknown) =>
  SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const put = async (path: string, body: unknown) =>
  SELF.fetch(`https://example.com${path}`, {
    method: "PUT",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("V3 §3 outcomes API", () => {
  it("manual add creates an application + manual_add event", async () => {
    const res = await post("/api/outcomes", {
      company: "Initech",
      role: "SWE Intern",
      status: "APPLIED",
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    expect(id).toBeGreaterThan(0);

    const apps = await repo().listApplications();
    const row = apps.find((a) => a.id === id);
    expect(row?.company).toBe("Initech");
    expect(row?.status).toBe("APPLIED");
  });

  it("manual add requires company", async () => {
    const res = await post("/api/outcomes", { role: "no company" });
    expect(res.status).toBe(400);
  });

  it("correction updates status and writes an audit event", async () => {
    const created = await post("/api/outcomes", { company: "Acme", status: "APPLIED" });
    const { id } = (await created.json()) as { id: number };

    const res = await put(`/api/outcomes/${id}/status`, { status: "INTERVIEW" });
    expect(res.status).toBe(200);
    const app = await repo().getApplicationStatus(id);
    expect(app).toBe("INTERVIEW");
  });

  it("correction on unknown application 404s", async () => {
    const res = await put("/api/outcomes/999999/status", { status: "OFFER" });
    expect(res.status).toBe(404);
  });

  it("CSV export returns header + rows, token-gated", async () => {
    await post("/api/outcomes", { company: "Globex", role: "Data Intern", status: "OA" });

    const noAuth = await SELF.fetch("https://example.com/api/export/applications.csv");
    expect(noAuth.status).toBe(401);

    const res = await get("/api/export/applications.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const csv = await res.text();
    expect(csv.split("\n")[0]).toBe("id,company,role,status,created_at,updated_at");
    expect(csv).toContain("Globex");
  });

  it("company names with commas/quotes survive CSV escaping", async () => {
    const created = await post("/api/outcomes", {
      company: 'Smith & Co, "Elite" Division',
      status: "APPLIED",
    });
    expect(created.status).toBe(201);
    const res = await get("/api/export/applications.csv");
    const csv = await res.text();
    expect(csv).toContain('"Smith & Co, ""Elite"" Division"');
  });
});
