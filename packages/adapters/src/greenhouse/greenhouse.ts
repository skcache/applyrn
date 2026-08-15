import type { CompanyConfig, NormalizedJob, PublicationTimeKind } from "@applyrn/domain";
import {
  AdapterError,
  type FetchContext,
  type FetchLike,
  type JobSourceAdapter,
  type RawBoardResponse,
} from "../types.js";

/**
 * Greenhouse public Job Board API adapter.
 *
 * List endpoint: GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs
 * Detail endpoint: GET .../boards/{token}/jobs/{id}  (first_published lives here)
 *
 * All data is public. No credentials are sent. The board key comes from the
 * watchlist config, never from source code.
 */

const API_BASE = "https://boards-api.greenhouse.io/v1/boards";
const REQUEST_TIMEOUT_MS = 10_000;

type GreenhouseJob = {
  id?: number | string;
  title?: string;
  location?: { name?: string } | null;
  absolute_url?: string;
  content?: string;
  updated_at?: string;
  first_published?: string;
  department?: { name?: string } | null;
  office?: { name?: string } | null;
};

type GreenhouseListResponse = { jobs?: GreenhouseJob[] };

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Minimal HTML to plain text: strip tags, decode entities, collapse whitespace. */
export function htmlToPlainText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const withoutTags = html.replace(/<[^>]*>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim() || undefined;
}

export class GreenhouseAdapter implements JobSourceAdapter {
  readonly provider = "greenhouse";

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
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new AdapterError(
          "timeout",
          `Greenhouse request timed out after ${this.timeoutMs}ms: ${url}`,
        );
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new AdapterError("timeout", `Greenhouse request aborted: ${url}`);
      }
      throw new AdapterError("network", `Greenhouse network error: ${url}: ${String(err)}`);
    }
    if (res.status === 429) {
      throw new AdapterError("rate_limited", `Greenhouse rate limited (429): ${url}`, 429);
    }
    if (res.status >= 500) {
      throw new AdapterError(
        "server_error",
        `Greenhouse server error (${res.status}): ${url}`,
        res.status,
      );
    }
    if (!res.ok) {
      throw new AdapterError(
        "server_error",
        `Greenhouse unexpected status (${res.status}): ${url}`,
        res.status,
      );
    }
    return res;
  }

  private async requestJson(url: string, ctx?: FetchContext): Promise<unknown> {
    const res = await this.request(url, ctx);
    try {
      return await res.json();
    } catch {
      throw new AdapterError("malformed", `Greenhouse returned non-JSON: ${url}`);
    }
  }

  async fetchBoard(company: CompanyConfig, ctx?: FetchContext): Promise<RawBoardResponse> {
    const url = `${API_BASE}/${encodeURIComponent(company.boardKey)}/jobs`;
    return this.requestJson(url, ctx);
  }

  async fetchJobDetail(
    company: CompanyConfig,
    externalJobId: string,
    ctx?: FetchContext,
  ): Promise<RawBoardResponse> {
    const url = `${API_BASE}/${encodeURIComponent(company.boardKey)}/jobs/${encodeURIComponent(externalJobId)}`;
    return this.requestJson(url, ctx);
  }

  async normalize(company: CompanyConfig, response: RawBoardResponse): Promise<NormalizedJob[]> {
    const list = response as GreenhouseListResponse;
    if (typeof list !== "object" || list === null || !Array.isArray(list.jobs)) {
      throw new AdapterError("malformed", "Greenhouse list payload missing jobs array");
    }
    const jobs: NormalizedJob[] = [];
    for (const raw of list.jobs) {
      const job = this.mapJob(company, raw, "observed");
      if (job) jobs.push(job);
    }
    return jobs;
  }

  /** Normalize a detail payload into a job, upgrading timestamps when authoritative. */
  async normalizeDetail(
    company: CompanyConfig,
    response: RawBoardResponse,
    externalJobId: string,
  ): Promise<NormalizedJob | null> {
    const raw = response as GreenhouseJob;
    if (typeof raw !== "object" || raw === null) return null;
    const base = this.mapJob(company, raw, "observed");
    if (!base || String(raw.id) !== externalJobId) return null;
    const kind: PublicationTimeKind =
      typeof raw.first_published === "string" ? "authoritative" : "observed";
    return {
      ...base,
      sourcePublishedAt: raw.first_published ?? base.sourcePublishedAt,
      publicationTimeKind: kind,
    };
  }

  private mapJob(
    company: CompanyConfig,
    raw: GreenhouseJob,
    kind: PublicationTimeKind,
  ): NormalizedJob | null {
    if (typeof raw !== "object" || raw === null) return null;
    if (raw.id === undefined || raw.id === null || typeof raw.title !== "string" || !raw.title) {
      // Skip malformed rows instead of failing the whole board (one bad row
      // must not hide the other jobs).
      return null;
    }
    const externalJobId = String(raw.id);
    const jobUrl = typeof raw.absolute_url === "string" ? raw.absolute_url : "";
    const descriptionPlain = htmlToPlainText(raw.content);
    return {
      provider: "greenhouse",
      companyId: company.id,
      externalJobId,
      title: raw.title,
      location: raw.location?.name,
      department: raw.department?.name ?? raw.office?.name,
      descriptionPlain,
      jobUrl,
      applyUrl: jobUrl,
      sourcePublishedAt: typeof raw.first_published === "string" ? raw.first_published : undefined,
      sourceUpdatedAt: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
      publicationTimeKind: kind,
    };
  }
}
