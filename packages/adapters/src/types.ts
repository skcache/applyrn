import type { CompanyConfig, NormalizedJob } from "@applyrn/domain";

/** Raw provider payload, opaque to the rest of the system. */
export type RawBoardResponse = unknown;

/** Adapter error taxonomy. Callers use `code` for backoff decisions. */
export type AdapterErrorCode =
  "timeout" | "rate_limited" | "server_error" | "malformed" | "network";

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly status?: number;

  constructor(code: AdapterErrorCode, message: string, status?: number) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.status = status;
  }
}

/** A fetch-like function so adapters stay testable without a network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Provider adapter contract (PRD section 3).
 * Provider-specific logic lives only inside adapters; the core engine never
 * sees a provider JSON shape.
 */
export interface JobSourceAdapter {
  /** Provider id, e.g. "greenhouse". Must match companies.provider. */
  provider: string;

  /**
   * True when fetchBoard returns the COMPLETE board (greenhouse/ashby/lever).
   * False when it fetches only the newest page (workday/smartrecruiters/
   * taleo): a partial view can NOT witness absence, so the detection engine
   * must never mark jobs missing from these providers — otherwise any job
   * pushed off page 1 by churn is falsely inactivated and re-alerted when
   * churn brings it back (verified 2026-08-21; the "Databricks vanished"
   * episode).
   */
  readonly partialBoardScan: boolean;

  /** Fetch the raw board payload for a company. */
  fetchBoard(company: CompanyConfig, ctx?: FetchContext): Promise<RawBoardResponse>;

  /** Convert a raw payload into normalized jobs. */
  normalize(company: CompanyConfig, response: RawBoardResponse): Promise<NormalizedJob[]>;
}

export type FetchContext = {
  /** Abort signal propagated from the caller (timeout, cancellation). */
  signal?: AbortSignal;
};

/** Optional capability: authoritative per-job detail (e.g. first_published). */
export interface SupportsJobDetail {
  fetchJobDetail(
    company: CompanyConfig,
    externalJobId: string,
    ctx?: FetchContext,
  ): Promise<RawBoardResponse>;
  normalizeDetail(
    company: CompanyConfig,
    response: RawBoardResponse,
    externalJobId: string,
  ): Promise<NormalizedJob | null>;
}

export function isDetailCapable(
  adapter: JobSourceAdapter,
): adapter is JobSourceAdapter & SupportsJobDetail {
  return typeof (adapter as Partial<SupportsJobDetail>).fetchJobDetail === "function";
}
