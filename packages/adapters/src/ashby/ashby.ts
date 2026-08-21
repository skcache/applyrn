import type { CompanyConfig, NormalizedJob } from "@applyrn/domain";
import {
  AdapterError,
  type FetchContext,
  type FetchLike,
  type JobSourceAdapter,
  type RawBoardResponse,
} from "../types.js";

/**
 * Ashby public Job Board API adapter.
 *
 * Endpoint: GET https://api.ashbyhq.com/posting-api/job-board/{board}
 * Returns:  { jobs: [ { id, title, department, team, employmentType,
 *   location, secondaryLocations, workplaceType, publishedAt, jobUrl,
 *   applyUrl, address, compensation, descriptionPlain, descriptionHtml } ] }
 *
 * All data is public. No credentials are sent. The board key comes from the
 * watchlist config, never from source code.
 */

const API_BASE = "https://api.ashbyhq.com/posting-api/job-board";
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Reject boards larger than this; guards against runaway payloads.
 * Ashby's posting-api embeds the FULL job description per job (unlike
 * Greenhouse's list payload), so big boards are genuinely large:
 * OpenAI's is ~12.3MB across 752 postings (verified live 2026-08-21).
 */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

type AshbyJob = {
  id?: string;
  title?: string;
  department?: string | null;
  team?: string | null;
  employmentType?: string | null;
  location?: string | null;
  secondaryLocations?: string[] | null;
  workplaceType?: string | null;
  publishedAt?: string | null;
  jobUrl?: string | null;
  applyUrl?: string | null;
  address?: string | null;
  compensation?: { summary?: string | null; compensationTierSummary?: string | null } | null;
  descriptionPlain?: string | null;
};

type AshbyBoardResponse = { jobs?: AshbyJob[] };

export class AshbyAdapter implements JobSourceAdapter {
  readonly provider = "ashby";
  readonly partialBoardScan = true; // full board in one request

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
        throw new AdapterError("timeout", `Ashby request timed out: ${url}`);
      }
      throw new AdapterError("network", `Ashby network error: ${url}: ${String(err)}`);
    }
    if (res.status === 429) {
      throw new AdapterError("rate_limited", `Ashby rate limited (429): ${url}`, 429);
    }
    if (res.status >= 500) {
      throw new AdapterError(
        "server_error",
        `Ashby server error (${res.status}): ${url}`,
        res.status,
      );
    }
    if (!res.ok) {
      throw new AdapterError(
        "server_error",
        `Ashby unexpected status (${res.status}): ${url}`,
        res.status,
      );
    }
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new AdapterError(
        "malformed",
        `Ashby response exceeds ${MAX_RESPONSE_BYTES} bytes: ${url}`,
      );
    }
    return res;
  }

  async fetchBoard(company: CompanyConfig, ctx?: FetchContext): Promise<RawBoardResponse> {
    const url = `${API_BASE}/${encodeURIComponent(company.boardKey)}`;
    const res = await this.request(url, ctx);
    try {
      return await res.json();
    } catch {
      throw new AdapterError("malformed", `Ashby returned non-JSON: ${url}`);
    }
  }

  async normalize(company: CompanyConfig, response: RawBoardResponse): Promise<NormalizedJob[]> {
    const board = response as AshbyBoardResponse;
    if (typeof board !== "object" || board === null || !Array.isArray(board.jobs)) {
      throw new AdapterError("malformed", "Ashby payload missing jobs array");
    }
    const jobs: NormalizedJob[] = [];
    for (const raw of board.jobs) {
      const job = this.mapJob(company, raw);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  private mapJob(company: CompanyConfig, raw: AshbyJob): NormalizedJob | null {
    if (typeof raw !== "object" || raw === null) return null;
    if (!raw.id || typeof raw.title !== "string" || !raw.title) {
      // Skip malformed rows instead of failing the whole board.
      return null;
    }
    const locations = [raw.location, ...(raw.secondaryLocations ?? [])].filter(
      (l): l is string => typeof l === "string" && l.length > 0,
    );

    const compensation =
      raw.compensation?.compensationTierSummary ?? raw.compensation?.summary ?? undefined;

    return {
      provider: "ashby",
      companyId: company.id,
      externalJobId: raw.id,
      title: raw.title,
      location: locations.join(", ") || undefined,
      employmentType: raw.employmentType ?? undefined,
      department: raw.department ?? undefined,
      team: raw.team ?? undefined,
      descriptionPlain: raw.descriptionPlain ?? undefined,
      jobUrl: raw.jobUrl ?? "",
      applyUrl: raw.applyUrl ?? raw.jobUrl ?? "",
      compensationText: compensation ?? undefined,
      sourcePublishedAt: raw.publishedAt ?? undefined,
      publicationTimeKind: typeof raw.publishedAt === "string" ? "authoritative" : "observed",
    };
  }
}
