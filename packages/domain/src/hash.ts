/**
 * Deterministic identity + content hashing helpers.
 * Pure Web Crypto (crypto.subtle), available in Workers and Node 20+.
 */

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Deterministic job row id: hash of the natural unique key
 * (provider, companyId, externalJobId). Stable across polls and runs.
 */
export async function jobId(
  provider: string,
  companyId: string,
  externalJobId: string,
): Promise<string> {
  return sha256Hex(`${provider}\u0000${companyId}\u0000${externalJobId}`);
}

/**
 * Material-fields hash for edit detection. Only fields a candidate would
 * reasonably read before applying; description is excluded so prose tweaks
 * do not create churn. Mirrors PRD section 10.5 material fields.
 */
export async function contentHash(job: {
  title: string;
  location?: string;
  employmentType?: string;
  department?: string;
  team?: string;
  compensationText?: string;
}): Promise<string> {
  const parts = [
    job.title,
    job.location ?? "",
    job.employmentType ?? "",
    job.department ?? "",
    job.team ?? "",
    job.compensationText ?? "",
  ];
  return sha256Hex(parts.join("\u0000"));
}
