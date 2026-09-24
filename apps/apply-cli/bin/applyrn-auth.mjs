#!/usr/bin/env node
/**
 * applyrn-auth — one-time Gmail OAuth linking for V3 outcome tracking.
 *
 * Runs the RFC 8252 loopback-IP flow entirely locally:
 *   1. starts a throwaway HTTP server on 127.0.0.1:<random port>
 *   2. opens (or prints) the Google consent URL
 *   3. captures ?code=, exchanges it for tokens via fetch
 *   4. stores ONLY the refresh token in prod D1 via /api/gmail/token
 *
 * Scopes: gmail.readonly — nothing more. The worker later refreshes access
 * tokens with pure fetch(); no Google SDK anywhere in this repo.
 *
 * Env: APPLYRN_WORKER_URL, APPLYRN_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 * (client secret lives in your GCP console → Credentials → OAuth client of type
 * "Desktop app"; desktop-app secrets are not treated as sensitive by Google's
 * threat model, but keep it out of git anyway).
 */

import http from "node:http";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const WORKER_URL = process.env.APPLYRN_WORKER_URL ?? "";
const TOKEN = process.env.APPLYRN_TOKEN ?? "";
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
// Readonly is all V3 needs: poll + read messages. No send, no modify.
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

if (!WORKER_URL || !TOKEN) die("set APPLYRN_WORKER_URL and APPLYRN_TOKEN");
if (!CLIENT_ID || !CLIENT_SECRET) die("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");

// 1. Loopback listener on a random port.
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1`);
  if (url.searchParams.get("state") !== expectedState) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h2>❌ state mismatch — ignoring</h2>");
    return;
  }
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(code ? "<h2>✅ Linked. You can close this tab.</h2>" : `<h2>❌ ${err ?? "no code"}</h2>`);
  if (code) {
    server.closeAllConnections?.();
    server.close(() => finish(code));
  } else {
    server.close();
    die(`consent failed: ${err}`);
  }
});

let redirectUri = "";
let expectedState = "";
let pkceVerifier = "";
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  redirectUri = `http://127.0.0.1:${port}`;
  // Minor-fix: CSRF state + PKCE (Google supports S256) for the loopback flow.
  expectedState = crypto.randomBytes(16).toString("hex");
  pkceVerifier = crypto.randomBytes(32).toString("base64url");
  const state = expectedState;
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force refresh_token even on prior grants
    include_granted_scopes: "false",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const consentUrl = `${AUTH_ENDPOINT}?${params}`;
  console.log("Opening browser for Gmail consent…\n" + consentUrl);
  // Best-effort open; print URL regardless so headless use still works.
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawnSync(opener, [consentUrl], { stdio: "ignore" });
});

async function finish(code) {
  try {
    // 2. Code → tokens (pure fetch; identical to what the Worker will do).
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: pkceVerifier,
      }),
    });
    if (!res.ok) die(`token exchange failed: HTTP ${res.status} ${await res.text()}`);
    const tok = await res.json();
    if (!tok.refresh_token) {
      die(
        "Google did not return a refresh_token. Re-run with prompt=consent " +
          "(already set) or revoke the app at https://myaccount.google.com/permissions and retry.",
      );
    }
    // 3. Persist via the worker API (token-gated like every other route).
    const wr = await fetch(`${WORKER_URL}/api/gmail/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: tok.refresh_token, scope: tok.scope ?? SCOPE }),
    });
    if (!wr.ok) die(`worker rejected token: HTTP ${wr.status} ${await wr.text()}`);
    console.log(
      "✅ Gmail linked. The worker polls Gmail with every poll cycle (~every 12 minutes).",
    );
    console.log(`   scope granted: ${tok.scope}`);
  } catch (err) {
    die(err.message);
  }
}

// The redirect_uri must byte-match between consent and exchange — it is
// captured from the actual listening port above.
