/**
 * ApplyRN Worker — bootstrap stage (Issue 0 / PR #1).
 * Health endpoint only; the poll cycle and D1 read paths land in later PRs.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "applyrn-worker" }, { headers: JSON_HEADERS });
    }

    return Response.json({ error: "not found" }, { status: 404, headers: JSON_HEADERS });
  },
} satisfies ExportedHandler;
