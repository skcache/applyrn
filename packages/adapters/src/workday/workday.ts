import type { CompanyConfig, NormalizedJob } from "@applyrn/domain";
import {
  AdapterError,
  type FetchContext,
  type FetchLike,
  type JobSourceAdapter,
  type RawBoardResponse,
} from "../types.js";
import { readJsonWithCap } from "../body-cap.js";

/**
 * Workday public Candidate Experience (CXS) adapter.
 *
 * Endpoint (LIVE-VERIFIED 2026-08-19 against abcfws.wd1.myworkdayjobs.com,
 * per the SPA's own client bundle): the jobs list is a POST to
 *   {origin}/wday/cxs/{tenant}/{siteId}/jobs
 * with JSON body { appliedFacets: {}, searchText: "", limit, offset } and
 * Accept-Language. Response:
 *   { total, userAuthenticated, jobPostings: [
 *       { title, externalPath: "/job/Titusville-FL/Team-Member_JR107575",
 *         locationsText: "Titusville, FL", postedOn: "Posted Today",
 *         bulletFields: ["JR107575"] } ] }
 *
 * The full job URL is origin + externalPath (e.g.
 * https://abcfws.wd1.myworkdayjobs.com/job/Titusville-FL/Team-Member_JR107575).
 *
 * No auth, no API key. The boardKey in the watchlist must contain the tenant
 * AND site id — we encode it as "tenant:site" so a single config field drives
 * both URL segments (e.g. "abcfws:abcfws"). postedOn is human relative text
 * ("Posted Today"), never a trustworthy timestamp, so every job is
 * publicationTimeKind = "observed" (first_seen_at is OUR observation time).
 *
 * All data is public. The board key comes from the watchlist config.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

type WorkdayJobPosting = {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: (string | null)[] | null;
};

type WorkdayJobsResponse = {
  total?: number;
  jobPostings?: WorkdayJobPosting[];
};

/**
 * Watchlist boardKey encodes "host:tenant:siteId" — e.g. for Adobe:
 * "adobe.wd5.myworkdayjobs.com:adobe:external_experienced". The live CXS URL
 * is /wday/cxs/{tenant}/{siteId}/jobs where tenant is the SHORT tenant name
 * (the host subdomain), so a bare host is not enough. Backward-compatible
 * fallbacks: "host" derives tenant from the first host label and siteId =
 * tenant; "host:siteId" keeps the derived tenant.
 */
export function parseWorkdayBoardKey(boardKey: string): {
  origin: string;
  tenant: string;
  siteId: string;
} {
  const clean = (s: string) => s.trim().replace(/^https?:\/\//, "");
  const parts = boardKey.split(":").map(clean);
  const host = parts[0] ?? boardKey.trim();
  const shortTenant = (host.split(".")[0] ?? host).toLowerCase();
  // Count-aware: 1 part = host only; 2 parts = host:siteId (tenant derived);
  // 3 parts = host:tenant:siteId (explicit tenant).
  let tenant = shortTenant;
  let siteId = shortTenant;
  if (parts.length >= 3) {
    tenant = parts[1] || shortTenant;
    siteId = parts[2] || tenant;
  } else if (parts.length === 2) {
    siteId = parts[1] || shortTenant;
  }
  return { origin: `https://${host}`, tenant, siteId };
}

/** Human relative text like "Posted Today"/"30+ days ago" → no timestamp. */
function normalizePostedOn(raw: string | undefined): string | undefined {
  return raw?.trim() ? raw.trim() : undefined;
}
void normalizePostedOn; // kept for potential future use; NOT part of the payload (hash churn)

export class WorkdayAdapter implements JobSourceAdapter {
  readonly provider = "workday";
  // CXS rejects limit>20: page-1 view only, cannot witness absence.
  readonly partialBoardScan = false;

  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(fetchImpl?: FetchLike, timeoutMs: number = REQUEST_TIMEOUT_MS) {
    this.fetch = fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = timeoutMs;
  }

  private async request(url: string, ctx?: FetchContext, init?: RequestInit): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = ctx?.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
    let res: Response;
    try {
      res = await this.fetch(url, { signal, ...init });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new AdapterError("timeout", `Workday request timed out: ${url}`);
      }
      throw new AdapterError("network", `Workday network error: ${url}: ${String(err)}`);
    }
    if (res.status === 429) {
      throw new AdapterError("rate_limited", `Workday rate limited (429): ${url}`, 429);
    }
    if (res.status >= 500) {
      throw new AdapterError(
        "server_error",
        `Workday server error (${res.status}): ${url}`,
        res.status,
      );
    }
    if (!res.ok) {
      throw new AdapterError(
        "server_error",
        `Workday unexpected status (${res.status}): ${url}`,
        res.status,
      );
    }
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new AdapterError("malformed", `Workday response too large: ${url}`);
    }
    return res;
  }

  async fetchBoard(company: CompanyConfig, ctx?: FetchContext): Promise<RawBoardResponse> {
    const { origin, tenant, siteId } = parseWorkdayBoardKey(company.boardKey);
    const url = `${origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(siteId)}/jobs`;
    // Live CXS rejects limit > 20 with HTTP 400 (verified against nvidia
    // 2026-08-21: limit=100 -> {"errorCode":"HTTP_400"}, limit=20 -> 200).
    // One page per poll cycle: detection is incremental (new postings are
    // found by diffing against persisted state), so paging the full board
    // is unnecessary for correctness — the newest postings sort first.
    const res = await this.request(url, ctx, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Accept-Language": "en-US",
      },
      body: JSON.stringify({ appliedFacets: {}, searchText: "", limit: 20, offset: 0 }),
    });
    try {
      return await readJsonWithCap(res, MAX_RESPONSE_BYTES);
    } catch {
      throw new AdapterError("malformed", `Workday returned non-JSON: ${url}`);
    }
  }

  async normalize(company: CompanyConfig, response: RawBoardResponse): Promise<NormalizedJob[]> {
    const board = response as WorkdayJobsResponse;
    if (typeof board !== "object" || board === null || !Array.isArray(board.jobPostings)) {
      throw new AdapterError("malformed", "Workday payload missing jobPostings array");
    }
    const { origin } = parseWorkdayBoardKey(company.boardKey);
    const jobs: NormalizedJob[] = [];
    for (const raw of board.jobPostings) {
      const job = this.mapPosting(company, origin, raw);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  private mapPosting(
    company: CompanyConfig,
    origin: string,
    raw: WorkdayJobPosting,
  ): NormalizedJob | null {
    if (typeof raw !== "object" || raw === null) return null;
    if (typeof raw.title !== "string" || !raw.title || typeof raw.externalPath !== "string") {
      // Skip malformed rows instead of failing the whole board.
      return null;
    }
    // bulletFields[0] is the requisition id (e.g. "JR107575"); fall back to the
    // externalPath slug when absent so the id stays stable across polls.
    const externalId = (Array.isArray(raw.bulletFields) && raw.bulletFields[0]) || raw.externalPath;
    // Audit 2026-08-22 V1 (phishing-pivot): externalPath is board-controlled.
    // Raw concatenation let a value without a leading slash hijack the URL
    // authority ("@evil.com/x" -> userinfo trick, host becomes evil.com;
    // ".evil.com" -> attacker subdomain) while passing every scheme-only
    // guard downstream — landing an attacker-host link in the APPLY NOW
    // button. Real CXS paths always start with "/": enforce that, then pin
    // the constructed URL to the expected origin host.
    if (!raw.externalPath.startsWith("/")) {
      return null; // hostile/malformed path: skip the row, never trust it
    }
    let jobUrl: string;
    try {
      const parsed = new URL(raw.externalPath, origin);
      if (parsed.hostname !== new URL(origin).hostname) return null;
      jobUrl = parsed.toString();
    } catch {
      return null;
    }
    const title = raw.title;

    return {
      provider: "workday",
      companyId: company.id,
      externalJobId: externalId,
      title,
      location: raw.locationsText?.trim() || undefined,
      jobUrl,
      applyUrl: jobUrl,
      // postedOn is human text, not a timestamp: honest labeled "observed".
      sourcePublishedAt: undefined,
      publicationTimeKind: "observed",
      // NOTE: deliberately NOT stored. postedOn is relative text ("Posted
      // Today" -> "Posted 1 Day Ago" -> ...) that changes daily; putting it
      // in compensationText churned the content hash every day, producing
      // endless spurious "edited" decisions (audit 2026-08-21 §3.3/§5.9).
    };
  }
}
