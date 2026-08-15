/**
 * Dashboard API client. All requests carry the shared token (PRD 14).
 * The token is read from sessionStorage; the gate screen sets it.
 */

const TOKEN_KEY = "applyrn.token";

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export type ApiError = { status: number; message: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    clearToken();
    throw { status: 401, message: "unauthorized" } as ApiError;
  }
  if (!res.ok) {
    throw { status: res.status, message: `request failed (${res.status})` } as ApiError;
  }
  return (await res.json()) as T;
}

export type JobView = {
  id: string;
  companyId: string;
  companyName: string;
  provider: string;
  externalJobId: string;
  title: string;
  location?: string;
  employmentType?: string;
  department?: string;
  team?: string;
  descriptionPlain?: string;
  jobUrl: string;
  applyUrl: string;
  compensationText?: string;
  sourcePublishedAt?: string;
  publicationTimeKind: "authoritative" | "observed";
  firstSeenAt: string;
  detectedAt: string;
  lastSeenAt: string;
  status: string;
  matchScore?: number;
  matchReasonsJson?: string;
  applicationStatus?: string;
  applicationAppliedAt?: string;
};

export type SourceHealth = {
  companyId: string;
  name: string;
  provider: string;
  boardKey: string;
  enabled: boolean;
  pollIntervalSeconds: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  failureStreak: number;
  backoffUntil?: string;
  lastHttpStatus?: number;
  lastErrorCode?: string;
};

export type SystemStatus = {
  companyCount: number;
  cadenceSeconds: number;
  lastPollAt?: string;
};

export type ApplicationView = {
  jobId: string;
  status: string;
  appliedAt?: string;
  jobTitle: string;
  jobDetectedAt: string;
  jobProvider: string;
  companyName: string;
};

export const APPLICATION_STATUSES = [
  "DETECTED",
  "SAVED",
  "APPLIED",
  "OA",
  "INTERVIEW",
  "FINAL",
  "OFFER",
  "REJECTED",
  "GHOSTED",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const api = {
  jobs: () => request<{ jobs: JobView[] }>("/jobs"),
  job: (id: string) => request<{ job: JobView }>(`/jobs/${encodeURIComponent(id)}`),
  sources: () => request<{ sources: SourceHealth[] }>("/sources"),
  status: () => request<{ status: SystemStatus }>("/status"),
  applications: () => request<{ applications: ApplicationView[] }>("/applications"),
  setApplicationStatus: (jobId: string, status: ApplicationStatus) =>
    request<{ application: { status: string; appliedAt?: string } }>(
      `/jobs/${encodeURIComponent(jobId)}/application`,
      { method: "PUT", body: JSON.stringify({ status }) },
    ),
};

export function matchReasons(job: JobView): string[] {
  if (!job.matchReasonsJson) return [];
  try {
    const parsed = JSON.parse(job.matchReasonsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/** Relative age like "18s", "4m", "2h", "3d". */
export function ageLabel(iso: string, now: number = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
