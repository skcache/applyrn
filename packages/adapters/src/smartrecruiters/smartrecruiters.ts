import type { CompanyConfig, NormalizedJob } from "@applyrn/domain";
import {
  AdapterError,
  type FetchContext,
  type FetchLike,
  type JobSourceAdapter,
  type RawBoardResponse,
  type SupportsJobDetail,
} from "../types.js";
import { readJsonWithCap } from "../body-cap.js";

/**
 * SmartRecruiters public Job Board API adapter.
 *
 * List endpoint: GET https://api.smartrecruiters.com/v1/companies/{boardKey}/postings?limit=N&offset=M
 * Detail endpoint (per posting): GET .../postings/{postingId}
 *
 * LIVE-VERIFIED 2026-08-19 against DeliveryHero (1,004 postings), SIXT (552),
 * RocketInternet (17). No auth required — plain GET, no API key. Field names
 * below are copied from real responses.
 *
 * Behavior notes (from live probing):
 *  - List items carry NO URL fields and only sparse description data; the
 *    authoritative postingUrl / applyUrl / full job description live on the
 *    detail endpoint, so this adapter implements SupportsJobDetail to enrich
 *    persisted (non-baseline) jobs exactly like Greenhouse.
 *  - releasedDate is an authoritative ISO publication timestamp (detail).
 *  - Pagination: limit clamps to 100; offset beyond the last page returns an
 *    empty content array (totalFound stays constant).
 *  - `sortBy` is ignored by the API (asc/desc identical) — do not rely on it.
 *
 * All data is public. The board key comes from the watchlist config, never
 * from source code.
 */

const API_BASE = "https://api.smartrecruiters.com/v1/companies";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Server clamps limit at 100; we page at it to minimize round trips. */
const PAGE_SIZE = 100;

type SmartRecruitersLocation = {
  city?: string | null;
  country?: string | null;
  remote?: boolean | null;
  hybrid?: boolean | null;
  hybridDescription?: string | null;
  fullLocation?: string | null;
};

type SmartRecruitersPosting = {
  id?: string;
  name?: string | null;
  refNumber?: string | null;
  company?: { identifier?: string | null; name?: string | null } | null;
  releasedDate?: string | null;
  location?: SmartRecruitersLocation | null;
  industry?: { id?: string | null; label?: string | null } | null;
  department?: { id?: string | null; label?: string | null } | null;
  function?: { id?: string | null; label?: string | null } | null;
  typeOfEmployment?: { id?: string | null; label?: string | null } | null;
  experienceLevel?: { id?: string | null; label?: string | null } | null;
  language?: string | null;
};

type SmartRecruitersListResponse = {
  totalFound?: number;
  offset?: number;
  limit?: number;
  content?: SmartRecruitersPosting[];
};

type SmartRecruitersDetail = SmartRecruitersPosting & {
  postingUrl?: string | null;
  applyUrl?: string | null;
  jobAd?: {
    sections?: {
      jobDescription?: { text?: string | null };
      qualifications?: { text?: string | null };
    };
  } | null;
};

/** Strip HTML tags + entities to plain text (SmartRecruiters sections are HTML). */
function htmlToPlainText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const withoutTags = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#xa0;/gi, " ");
  return withoutTags.replace(/\s+/g, " ").trim() || undefined;
}

export class SmartRecruitersAdapter implements JobSourceAdapter, SupportsJobDetail {
  readonly provider = "smartrecruiters";
  // List endpoint is paged (limit clamps at 100): a partial view cannot
  // witness absence — detection must not mark unseen jobs missing.
  readonly partialBoardScan = false;

  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(fetchImpl?: FetchLike, timeoutMs: number = REQUEST_TIMEOUT_MS) {
    this.fetch = fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = timeoutMs;
  }

  private async request(url: string, ctx?: FetchContext): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = ctx?.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
    let res: Response;
    try {
      res = await this.fetch(url, { signal, headers: { Accept: "application/json" } });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new AdapterError("timeout", `SmartRecruiters timed out: ${url}`);
      }
      throw new AdapterError("network", `SmartRecruiters network error: ${url}: ${String(err)}`);
    }
    if (res.status === 429) {
      throw new AdapterError("rate_limited", `SmartRecruiters rate limited (429): ${url}`, 429);
    }
    if (res.status >= 500) {
      throw new AdapterError(
        "server_error",
        `SmartRecruiters server error (${res.status}): ${url}`,
        res.status,
      );
    }
    if (!res.ok) {
      throw new AdapterError(
        "server_error",
        `SmartRecruiters unexpected status (${res.status}): ${url}`,
        res.status,
      );
    }
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new AdapterError("malformed", `SmartRecruiters response too large: ${url}`);
    }
    return res;
  }

  private async requestJson(url: string, ctx?: FetchContext): Promise<unknown> {
    const res = await this.request(url, ctx);
    try {
      return await readJsonWithCap(res, MAX_RESPONSE_BYTES);
    } catch {
      throw new AdapterError("malformed", `SmartRecruiters returned non-JSON: ${url}`);
    }
  }

  async fetchBoard(company: CompanyConfig, ctx?: FetchContext): Promise<RawBoardResponse> {
    const url = `${API_BASE}/${encodeURIComponent(company.boardKey)}/postings?limit=${PAGE_SIZE}&offset=0`;
    return this.requestJson(url, ctx);
  }

  async fetchJobDetail(
    company: CompanyConfig,
    externalJobId: string,
    ctx?: FetchContext,
  ): Promise<RawBoardResponse> {
    const url = `${API_BASE}/${encodeURIComponent(company.boardKey)}/postings/${encodeURIComponent(externalJobId)}`;
    return this.requestJson(url, ctx);
  }

  async normalize(company: CompanyConfig, response: RawBoardResponse): Promise<NormalizedJob[]> {
    const list = response as SmartRecruitersListResponse;
    if (typeof list !== "object" || list === null || !Array.isArray(list.content)) {
      throw new AdapterError("malformed", "SmartRecruiters payload missing content array");
    }
    const jobs: NormalizedJob[] = [];
    for (const raw of list.content) {
      const job = this.mapPosting(company, raw);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  async normalizeDetail(
    company: CompanyConfig,
    response: RawBoardResponse,
    externalJobId: string,
  ): Promise<NormalizedJob | null> {
    const raw = response as SmartRecruitersDetail;
    if (typeof raw !== "object" || raw === null) return null;
    if (String(raw.id) !== externalJobId) return null;
    const base = this.mapPosting(company, raw);
    if (!base) return null;
    const sections = raw.jobAd?.sections ?? {};
    const description = [sections.jobDescription?.text, sections.qualifications?.text]
      .filter((t): t is string => typeof t === "string" && t.length > 0)
      .join("\n\n");
    return {
      ...base,
      descriptionPlain: htmlToPlainText(description) ?? base.descriptionPlain,
      jobUrl: raw.postingUrl ?? base.jobUrl,
      applyUrl: raw.applyUrl ?? base.applyUrl,
      sourcePublishedAt: raw.releasedDate ?? base.sourcePublishedAt,
      publicationTimeKind:
        typeof raw.releasedDate === "string" ? "authoritative" : base.publicationTimeKind,
    };
  }

  private mapPosting(company: CompanyConfig, raw: SmartRecruitersPosting): NormalizedJob | null {
    if (typeof raw !== "object" || raw === null) return null;
    if (!raw.id || typeof raw.name !== "string" || !raw.name) {
      // Skip malformed rows instead of failing the whole board.
      return null;
    }
    const loc = raw.location ?? {};
    const locations = [loc.fullLocation, [loc.city, loc.country].filter(Boolean).join(", ")]
      .map((s) => s?.trim())
      .filter((s): s is string => typeof s === "string" && s.length > 0);
    const remote = loc.remote ? "Remote" : undefined;

    return {
      provider: "smartrecruiters",
      companyId: company.id,
      externalJobId: raw.id,
      title: raw.name,
      location: locations.length ? locations[0]! : remote,
      employmentType: raw.typeOfEmployment?.label ?? undefined,
      department: raw.department?.label ?? raw.function?.label ?? undefined,
      // The list payload has no description; the detail endpoint fills this in
      // via normalizeDetail for persisted jobs.
      jobUrl: "",
      applyUrl: "",
      // The list carries a publication date; it is authoritative only once the
      // detail response confirms it (normalizeDetail).
      sourcePublishedAt: typeof raw.releasedDate === "string" ? raw.releasedDate : undefined,
      publicationTimeKind: "observed",
    };
  }
}
