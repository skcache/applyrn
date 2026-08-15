import type { CompanyConfig, NormalizedJob } from "@applyrn/domain";
import {
  AdapterError,
  type FetchContext,
  type FetchLike,
  type JobSourceAdapter,
  type RawBoardResponse,
} from "../types.js";

/**
 * Lever public Postings API adapter.
 *
 * Endpoint: GET https://api.lever.co/v0/postings/{board}?mode=json
 * Returns:  an array of postings with id, text (title), hostedUrl,
 *   applyUrl, categories { team, commitment, location, department,
 *   allLocations }, createdAt, updatedAt.
 *
 * All data is public. No credentials are sent.
 *
 * Publication semantics (PRD section 4.3): Lever does not expose a
 * trustworthy publication timestamp, so every job is recorded with
 * publicationTimeKind = "observed". first_seen_at is ApplyRN's own
 * observation time and is never relabeled as true publication time.
 */

const API_BASE = "https://api.lever.co/v0/postings";
const REQUEST_TIMEOUT_MS = 10_000;
/** Reject boards larger than this; guards against runaway payloads. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

type LeverPosting = {
  id?: string;
  text?: string;
  hostedUrl?: string | null;
  applyUrl?: string | null;
  categories?: {
    team?: string | null;
    commitment?: string | null;
    location?: string | null;
    department?: string | null;
    allLocations?: string[] | null;
  } | null;
  descriptionPlain?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
};

export class LeverAdapter implements JobSourceAdapter {
  readonly provider = "lever";

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
        throw new AdapterError("timeout", `Lever request timed out: ${url}`);
      }
      throw new AdapterError("network", `Lever network error: ${url}: ${String(err)}`);
    }
    if (res.status === 429) {
      throw new AdapterError("rate_limited", `Lever rate limited (429): ${url}`, 429);
    }
    if (res.status >= 500) {
      throw new AdapterError(
        "server_error",
        `Lever server error (${res.status}): ${url}`,
        res.status,
      );
    }
    if (!res.ok) {
      throw new AdapterError(
        "server_error",
        `Lever unexpected status (${res.status}): ${url}`,
        res.status,
      );
    }
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new AdapterError(
        "malformed",
        `Lever response exceeds ${MAX_RESPONSE_BYTES} bytes: ${url}`,
      );
    }
    return res;
  }

  async fetchBoard(company: CompanyConfig, ctx?: FetchContext): Promise<RawBoardResponse> {
    const url = `${API_BASE}/${encodeURIComponent(company.boardKey)}?mode=json`;
    const res = await this.request(url, ctx);
    try {
      return await res.json();
    } catch {
      throw new AdapterError("malformed", `Lever returned non-JSON: ${url}`);
    }
  }

  async normalize(company: CompanyConfig, response: RawBoardResponse): Promise<NormalizedJob[]> {
    if (!Array.isArray(response)) {
      throw new AdapterError("malformed", "Lever payload is not an array");
    }
    const jobs: NormalizedJob[] = [];
    for (const raw of response) {
      const job = this.mapPosting(company, raw as LeverPosting);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  private mapPosting(company: CompanyConfig, raw: LeverPosting): NormalizedJob | null {
    if (typeof raw !== "object" || raw === null) return null;
    if (!raw.id || typeof raw.text !== "string" || !raw.text) {
      // Skip malformed rows instead of failing the whole board.
      return null;
    }
    const categories = raw.categories ?? {};
    // allLocations usually includes the primary location; dedupe in order.
    const locations = [categories.location, ...(categories.allLocations ?? [])].filter(
      (l, i, arr): l is string => typeof l === "string" && l.length > 0 && arr.indexOf(l) === i,
    );

    return {
      provider: "lever",
      companyId: company.id,
      externalJobId: raw.id,
      title: raw.text,
      location: locations.join(", ") || undefined,
      employmentType: categories.commitment ?? undefined,
      department: categories.department ?? undefined,
      team: categories.team ?? undefined,
      descriptionPlain: raw.descriptionPlain ?? undefined,
      jobUrl: raw.hostedUrl ?? "",
      applyUrl: raw.applyUrl ?? raw.hostedUrl ?? "",
      // Lever exposes createdAt (posting creation), not publication time.
      // Honest labeling: observed, first_seen_at records OUR observation.
      publicationTimeKind: "observed",
    };
  }
}
