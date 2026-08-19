import type { CompanyConfig, NormalizedJob } from "@applyrn/domain";
import {
  AdapterError,
  type FetchContext,
  type FetchLike,
  type JobSourceAdapter,
  type RawBoardResponse,
} from "../types.js";

/**
 * Oracle Taleo public career-site adapter.
 *
 * Endpoint (reverse-engineered from the live Volkswagen Group of America
 * tenant `vwgoa.taleo.net` 2026-08-19, Taleo 2026PRD.1.2.7.3.0 — the SPA's
 * own SearchHandler.js posts to):
 *   POST {origin}/careersection/rest/jobboard/searchjobs?lang={lang}&portal={portalNo}
 *   Content-Type: application/json
 *   Body: JSON of the faceted-search form (pageNo, activeFilterId, ...) —
 *        the renderer source shows `requisitionList` and `pagingData.totalCount`
 * Response:
 *   { requisitionList: [
 *       { jobId: "JR…", contestNo, column: ["title", ...],
 *         locationsColumns: [1], linkedColumn: 0 } ],
 *     pagingData: { totalCount } }
 *
 * Columns are provider-configured; `linkedColumn` is the job title column,
 * `locationsColumns` are JSON-stringified location arrays. Field names are
 * taken directly from TableRenderer.js / RowRenderer.js / CellRenderer.js.
 *
 * Taleo exposes no trustworthy publication timestamp, so every job is
 * publicationTimeKind = "observed" (first_seen_at is OUR observation time).
 *
 * The watchlist boardKey encodes `origin:section:portal:lang` — e.g.
 * "vwgoa.taleo.net:volkswagen_of_america:10240752087:en" — because a Taleo
 * tenant needs all four to form a request.
 *
 * All data is public. No credentials.
 */

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

type TaleoRequisition = {
  jobId?: string | null;
  contestNo?: string | null;
  positions?: number | null;
  column?: (string | null)[] | null;
  locationsColumns?: number[] | null;
  linkedColumn?: number | null;
};

type TaleoSearchResponse = {
  requisitionList?: TaleoRequisition[];
  pagingData?: { totalCount?: number; pageSize?: number; pageNo?: number } | null;
};

export function parseTaleoBoardKey(boardKey: string): {
  origin: string;
  section: string;
  portal: string;
  lang: string;
} {
  const parts = boardKey.split(":").map((s) => s.trim());
  const origin = (parts[0] ?? boardKey).replace(/^https?:\/\//, "");
  return {
    origin: `https://${origin}`,
    section: parts[1] ?? "",
    portal: parts[2] ?? "",
    lang: parts[3] ?? "en",
  };
}

/** Trim promo junk suffix ("-team-member" style) for a readable title. */
function cleanTitle(title: string): string {
  return title.trim();
}

/** location column is a JSON array of parts; join them. */
function parseLocations(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parts = JSON.parse(raw) as unknown;
    if (Array.isArray(parts)) {
      return (
        parts
          .map((p) => String(p))
          .filter((p) => p.trim().length > 0)
          .join(", ") || undefined
      );
    }
    return String(parts);
  } catch {
    return raw.trim() || undefined;
  }
}

export class TaleoAdapter implements JobSourceAdapter {
  readonly provider = "oracle";

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
        throw new AdapterError("timeout", `Taleo request timed out: ${url}`);
      }
      throw new AdapterError("network", `Taleo network error: ${url}: ${String(err)}`);
    }
    if (res.status === 429) {
      throw new AdapterError("rate_limited", `Taleo rate limited (429): ${url}`, 429);
    }
    if (res.status >= 500) {
      throw new AdapterError(
        "server_error",
        `Taleo server error (${res.status}): ${url}`,
        res.status,
      );
    }
    // Taleo answers unknown routes with 404 "Not Found" and bad bodies with
    // 400 "An Error Occurred in TEE"; both are server-side, not auth.
    if (res.status === 400 || res.status === 404 || !res.ok) {
      throw new AdapterError("server_error", `Taleo status ${res.status}: ${url}`, res.status);
    }
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new AdapterError("malformed", `Taleo response too large: ${url}`);
    }
    return res;
  }

  async fetchBoard(company: CompanyConfig, ctx?: FetchContext): Promise<RawBoardResponse> {
    const { origin, portal, lang } = parseTaleoBoardKey(company.boardKey);
    const url = `${origin}/careersection/rest/jobboard/searchjobs?lang=${encodeURIComponent(lang)}&portal=${encodeURIComponent(portal)}`;
    const res = await this.request(url, ctx, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pageNo: 1,
        activeFilterId: undefined,
      }),
    });
    try {
      const text = await res.text();
      const trimmed = text.trim();
      // Taleo can 200 with an HTML error envelope; catch it early.
      if (trimmed.startsWith("<") || trimmed.startsWith("An Error")) {
        throw new AdapterError("malformed", `Taleo non-JSON envelope: ${url}`);
      }
      return JSON.parse(trimmed);
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      throw new AdapterError("malformed", `Taleo returned non-JSON: ${url}`);
    }
  }

  async normalize(company: CompanyConfig, response: RawBoardResponse): Promise<NormalizedJob[]> {
    const board = response as TaleoSearchResponse;
    if (typeof board !== "object" || board === null || !Array.isArray(board.requisitionList)) {
      throw new AdapterError("malformed", "Taleo payload missing requisitionList");
    }
    const { origin, section, portal, lang } = parseTaleoBoardKey(company.boardKey);
    const jobs: NormalizedJob[] = [];
    for (const raw of board.requisitionList) {
      const job = this.mapRequisition(company, origin, section, portal, lang, raw);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  private mapRequisition(
    company: CompanyConfig,
    origin: string,
    section: string,
    portal: string,
    lang: string,
    raw: TaleoRequisition,
  ): NormalizedJob | null {
    if (typeof raw !== "object" || raw === null) return null;
    if (!raw.jobId || !Array.isArray(raw.column)) return null;
    const col = raw.column;
    const title =
      raw.linkedColumn !== null && raw.linkedColumn !== undefined ? col[raw.linkedColumn] : col[0];
    if (typeof title !== "string" || !title) return null;

    const locations = (raw.locationsColumns ?? [])
      .map((i) => parseLocations(col[i]))
      .filter((l): l is string => typeof l === "string");

    const id = raw.contestNo ?? raw.jobId;
    // Standard Taleo job detail page.
    const jobUrl = `${origin}/careersection/${encodeURIComponent(section)}/jobdetail.ftl?job=${encodeURIComponent(id)}&lang=${encodeURIComponent(lang)}&portal=${encodeURIComponent(portal)}`;

    return {
      provider: "oracle",
      companyId: company.id,
      externalJobId: id,
      title: cleanTitle(title),
      location: locations.length ? locations.join(", ") : undefined,
      jobUrl,
      applyUrl: jobUrl,
      publicationTimeKind: "observed",
    };
  }
}
