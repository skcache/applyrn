import { useEffect, useState } from "react";
import {
  APPLICATION_STATUSES,
  ageLabel,
  api,
  clearToken,
  getToken,
  matchReasons,
  setToken,
  type ApplicationStatus,
  type ApplicationView,
  type JobView,
  type SourceHealth,
} from "./api";

/**
 * ApplyRN — the quiet recruiting terminal (PRD section 7).
 * Dark graphite canvas, large type, hairline separators, minimal chrome.
 */

type View = "live" | "applications" | "sources";

/** Small status dropdown used in tape rows and the detail view. */
function StatusSelect({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (status: ApplicationStatus) => void;
}) {
  return (
    <select
      value={value ?? "DETECTED"}
      onChange={(e) => onChange(e.target.value as ApplicationStatus)}
      onClick={(e) => e.stopPropagation()}
      className="border border-zinc-800 bg-[#0c0e11] px-1.5 py-0.5 text-xs text-zinc-300 focus:border-zinc-600 focus:outline-none"
    >
      {APPLICATION_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

function Applications({
  applications,
  onStatus,
}: {
  applications: ApplicationView[];
  onStatus: (jobId: string, status: ApplicationStatus) => void;
}) {
  return (
    <div className="border border-zinc-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left">
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Company
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Role
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Status
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Detected
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Applied
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Detection → applied
            </th>
          </tr>
        </thead>
        <tbody>
          {applications.map((app) => {
            const latency =
              app.appliedAt && app.jobDetectedAt
                ? ageLabel(app.jobDetectedAt, Date.parse(app.appliedAt))
                : "—";
            return (
              <tr key={app.jobId} className="border-t border-zinc-800/70">
                <td className="px-4 py-2.5 text-zinc-300">{app.companyName}</td>
                <td className="px-4 py-2.5 text-zinc-100">{app.jobTitle}</td>
                <td className="px-4 py-2.5">
                  <StatusSelect value={app.status} onChange={(s) => onStatus(app.jobId, s)} />
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-500">
                  {new Date(app.jobDetectedAt).toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-500">
                  {app.appliedAt ? new Date(app.appliedAt).toLocaleString() : "—"}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-500">{latency}</td>
              </tr>
            );
          })}
          {applications.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-10 text-center text-sm text-zinc-600">
                Nothing tracked yet. Set a status on any job in the tape.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function useData<T>(
  loader: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    loader()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
    // deps intentionally loose: reload() triggers refetch via tick
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }, [...(deps as any[]), tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

function Gate({ onAuthed }: { onAuthed: () => void }) {
  const [token, setTokenInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!token.trim()) return;
    setToken(token.trim());
    try {
      await api.status();
      onAuthed();
    } catch {
      setError("That token was rejected. Check DASHBOARD_TOKEN.");
      clearToken();
    }
  };

  return (
    <div className="min-h-screen bg-[#0c0e11] text-zinc-200 flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">APPLYRN</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-500">
          Your recruiting terminal. Enter the dashboard token to open the tape.
        </p>
        <input
          type="password"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="dashboard token"
          className="mt-6 w-full border border-zinc-800 bg-transparent px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
        />
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        <button
          onClick={submit}
          className="mt-4 w-full border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-500 hover:text-white transition-colors"
        >
          Open
        </button>
      </div>
    </div>
  );
}

function TapeRow({
  job,
  now,
  onSelect,
}: {
  job: JobView;
  now: number;
  onSelect: (job: JobView) => void;
}) {
  const reasons = matchReasons(job);
  return (
    <tr
      onClick={() => onSelect(job)}
      className="border-t border-zinc-800/70 cursor-pointer hover:bg-zinc-900/60 transition-colors"
    >
      <td className="py-3 pr-4 font-mono text-xs text-zinc-500 whitespace-nowrap">
        {ageLabel(job.detectedAt, now)}
      </td>
      <td className="py-3 pr-4 text-sm text-zinc-300 whitespace-nowrap">{job.companyName}</td>
      <td className="py-3 pr-4 text-sm text-zinc-100">
        {job.title}
        {job.applicationStatus && job.applicationStatus !== "DETECTED" && (
          <span className="ml-2 text-xs text-amber-200/70 uppercase tracking-wide">
            {job.applicationStatus}
          </span>
        )}
      </td>
      <td className="py-3 pr-4 text-right font-mono text-xs text-zinc-400 whitespace-nowrap">
        {job.matchScore !== undefined && job.matchScore !== null ? job.matchScore : "—"}
      </td>
      <td className="py-3 pl-2 text-right text-xs uppercase tracking-wide text-zinc-500 whitespace-nowrap">
        {job.provider}
        {reasons.length > 0 && (
          <span className="ml-2 hidden text-zinc-600 lg:inline">
            · {reasons.slice(0, 2).join(", ")}
          </span>
        )}
      </td>
    </tr>
  );
}

function Detail({
  job,
  onBack,
  onOpen,
  onStatus,
}: {
  job: JobView;
  onBack: () => void;
  onOpen: (url: string) => void;
  onStatus: (status: ApplicationStatus) => void;
}) {
  const reasons = matchReasons(job);
  const rows: [string, string][] = [];
  if (job.location) rows.push(["Location", job.location]);
  if (job.employmentType) rows.push(["Employment", job.employmentType]);
  if (job.compensationText) rows.push(["Compensation", job.compensationText]);
  if (job.department) rows.push(["Department", job.department]);
  if (job.team) rows.push(["Team", job.team]);
  rows.push(["Provider", job.provider]);
  rows.push(["First seen", new Date(job.firstSeenAt).toLocaleString()]);
  rows.push(["Detected", new Date(job.detectedAt).toLocaleString()]);
  if (job.publicationTimeKind === "authoritative" && job.sourcePublishedAt) {
    rows.push(["Published", new Date(job.sourcePublishedAt).toLocaleString()]);
  }
  if (job.applicationAppliedAt) {
    rows.push(["Applied", new Date(job.applicationAppliedAt).toLocaleString()]);
  }

  return (
    <div className="border border-zinc-800 bg-zinc-950/60">
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <button
          onClick={onBack}
          className="text-xs uppercase tracking-wide text-zinc-500 hover:text-zinc-300"
        >
          ← Tape
        </button>
        <span className="text-xs uppercase tracking-wide text-zinc-600">{job.provider}</span>
      </div>
      <div className="px-5 py-6">
        <p className="text-xs uppercase tracking-wide text-zinc-500">{job.companyName}</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">{job.title}</h2>
        {job.matchScore !== undefined && job.matchScore !== null && (
          <p className="mt-2 text-sm text-amber-200/80">
            {job.matchScore} MATCH
            {reasons.length > 0 && (
              <span className="ml-2 text-zinc-500">{reasons.map((r) => `✓ ${r}`).join("  ")}</span>
            )}
          </p>
        )}
        <div className="mt-5 grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div
              key={k}
              className="flex justify-between border-b border-zinc-800/60 py-1.5 text-sm"
            >
              <span className="text-zinc-500">{k}</span>
              <span className="text-zinc-300">{v}</span>
            </div>
          ))}
        </div>
        {job.descriptionPlain && (
          <p className="mt-5 max-w-2xl text-sm leading-6 text-zinc-400">{job.descriptionPlain}</p>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-zinc-500">Status</span>
            <StatusSelect value={job.applicationStatus} onChange={onStatus} />
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => onOpen(job.applyUrl)}
              className="border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-400 hover:text-white transition-colors"
            >
              APPLY NOW
            </button>
            <button
              onClick={() => onOpen(job.jobUrl)}
              className="border border-zinc-800 px-4 py-2 text-sm text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-colors"
            >
              DETAILS
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Sources({ sources }: { sources: SourceHealth[] }) {
  return (
    <div className="border border-zinc-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left">
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Company
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Provider
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Status
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Last success
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Failures
            </th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => {
            const healthy = s.enabled && !s.backoffUntil && s.failureStreak === 0;
            const backoff = s.enabled && !!s.backoffUntil;
            const status = !s.enabled
              ? "disabled"
              : backoff
                ? "backoff"
                : healthy
                  ? "healthy"
                  : "degraded";
            return (
              <tr key={s.companyId} className="border-t border-zinc-800/70">
                <td className="px-4 py-2.5 text-zinc-200">{s.name}</td>
                <td className="px-4 py-2.5 text-zinc-400 capitalize">{s.provider}</td>
                <td
                  className={`px-4 py-2.5 text-xs uppercase tracking-wide ${status === "healthy" ? "text-zinc-400" : status === "backoff" ? "text-amber-200/80" : "text-red-400/90"}`}
                >
                  {status}
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-500">
                  {s.lastSuccessAt ? new Date(s.lastSuccessAt).toLocaleString() : "never"}
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-500">{s.failureStreak}</td>
              </tr>
            );
          })}
          {sources.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-sm text-zinc-600">
                No sources configured.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function App() {
  const [authed, setAuthed] = useState(() => getToken() !== null);
  const [view, setView] = useState<View>("live");
  const [selected, setSelected] = useState<JobView | null>(null);
  const now = useNow(5000);

  const jobs = useData(() => api.jobs(), [authed]);
  const sources = useData(() => api.sources(), [authed]);
  const status = useData(() => api.status(), [authed]);
  const applications = useData(() => api.applications(), [authed, view === "applications"]);

  const setStatus = async (jobId: string, s: ApplicationStatus) => {
    try {
      await api.setApplicationStatus(jobId, s);
      applications.reload();
      jobs.reload();
    } catch {
      // Surface silently; next reload shows the server truth.
    }
  };

  if (!authed) {
    return <Gate onAuthed={() => setAuthed(true)} />;
  }

  const sys = status.data?.status;

  const open = (url: string) => {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="min-h-screen bg-[#0c0e11] text-zinc-200">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8 lg:px-10">
        {/* Header */}
        <header className="flex items-baseline justify-between border-b border-zinc-800 pb-4">
          <h1 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-100">
            ApplyRN
          </h1>
          <div className="flex items-center gap-5 text-xs text-zinc-500">
            <button
              onClick={() => {
                setView("live");
                setSelected(null);
              }}
              className={`uppercase tracking-wide ${view === "live" ? "text-zinc-100" : "hover:text-zinc-300"}`}
            >
              Live
            </button>
            <button
              onClick={() => {
                setView("applications");
                setSelected(null);
              }}
              className={`uppercase tracking-wide ${view === "applications" ? "text-zinc-100" : "hover:text-zinc-300"}`}
            >
              Applications
            </button>
            <button
              onClick={() => {
                setView("sources");
                setSelected(null);
              }}
              className={`uppercase tracking-wide ${view === "sources" ? "text-zinc-100" : "hover:text-zinc-300"}`}
            >
              Sources
            </button>
            <button
              onClick={() => {
                clearToken();
                setAuthed(false);
              }}
              className="uppercase tracking-wide text-zinc-600 hover:text-zinc-400"
            >
              Sign out
            </button>
          </div>
        </header>

        {/* System state */}
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-800 py-3">
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            {sys ? `${sys.companyCount} companies · ${sys.cadenceSeconds}s cadence` : "loading…"}
          </span>
          <span className="text-xs uppercase tracking-wide text-zinc-600">
            {sys?.lastPollAt ? `last poll ${ageLabel(sys.lastPollAt, now)} ago` : "no polls yet"}
          </span>
        </div>

        {/* Body */}
        <main className="flex-1 py-6">
          {jobs.error && <p className="text-sm text-red-400">{jobs.error}</p>}
          {view === "live" && !selected && (
            <div className="border border-zinc-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-left">
                    <th className="py-2 pr-4 text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Age
                    </th>
                    <th className="py-2 pr-4 text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Company
                    </th>
                    <th className="py-2 pr-4 text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Role
                    </th>
                    <th className="py-2 pr-4 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Match
                    </th>
                    <th className="py-2 pl-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Source
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(jobs.data?.jobs ?? []).map((job) => (
                    <TapeRow key={job.id} job={job} now={now} onSelect={setSelected} />
                  ))}
                  {jobs.data && jobs.data.jobs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-sm text-zinc-600">
                        No jobs detected yet. The tape stays quiet until the first poll finds
                        something.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {view === "live" && selected && (
            <Detail
              job={selected}
              onBack={() => setSelected(null)}
              onOpen={open}
              onStatus={(s) => {
                setSelected({ ...selected, applicationStatus: s });
                void setStatus(selected.id, s);
              }}
            />
          )}
          {view === "applications" && (
            <Applications
              applications={applications.data?.applications ?? []}
              onStatus={setStatus}
            />
          )}
          {view === "sources" && <Sources sources={sources.data?.sources ?? []} />}
        </main>

        <footer className="border-t border-zinc-800 pt-4 text-xs text-zinc-600">
          Find it early. Apply right now.
        </footer>
      </div>
    </div>
  );
}
