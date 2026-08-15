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
  type SystemStatus,
} from "./api";

/**
 * ApplyRN — an editorial recruiting terminal.
 *
 * Visual architecture (PRD 7, PR #12): IDENTITY → SYSTEM STATE → LIVE
 * MARKET → DETAIL. Oversized display type anchors the first viewport;
 * system state is a quiet editorial block, not a utility strip; the feed
 * uses hairline rules instead of a bordered spreadsheet. One warm coral
 * accent, used sparingly. Typography over decoration.
 */

type View = "live" | "applications" | "sources";

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
    <div
      className="flex min-h-screen items-center justify-center px-6"
      style={{ background: "var(--bg)" }}
    >
      <div className="w-full max-w-sm">
        <h1 className="wordmark">ApplyRN</h1>
        <p className="mt-6 text-sm leading-6" style={{ color: "var(--text-2)" }}>
          Your recruiting terminal. Enter the dashboard token to open the tape.
        </p>
        <input
          type="password"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="dashboard token"
          className="mt-8 w-full border bg-transparent px-3 py-2.5 text-sm outline-none transition-colors focus:border-[var(--text-3)]"
          style={{ borderColor: "var(--divider-strong)", color: "var(--text)" }}
        />
        {error && (
          <p className="mt-3 text-xs" style={{ color: "var(--accent)" }}>
            {error}
          </p>
        )}
        <button
          onClick={submit}
          className="mt-6 px-5 py-2 text-sm font-medium transition-colors"
          style={{ color: "var(--accent)" }}
        >
          Open →
        </button>
      </div>
    </div>
  );
}

/** Small status dropdown used in applications and the detail view. */
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
      className="w-28 cursor-pointer border bg-transparent px-1.5 py-0.5 text-[11px] uppercase tracking-[0.14em] outline-none transition-colors hover:border-[var(--text-3)] focus:border-[var(--text-3)]"
      style={{ borderColor: "var(--divider-strong)", color: "var(--text-2)" }}
    >
      {APPLICATION_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

/** Status as editorial text, not a badge. */
function StatusText({ status }: { status: string | undefined }) {
  if (!status || status === "DETECTED") return null;
  const later = ["APPLIED", "OA", "INTERVIEW", "FINAL", "OFFER"].includes(status);
  const closed = ["REJECTED", "GHOSTED"].includes(status);
  const color = closed ? "var(--text-3)" : later ? "var(--accent-soft)" : "var(--text-2)";
  return (
    <span className="ml-3 text-[10.5px] font-medium uppercase tracking-[0.18em]" style={{ color }}>
      {status}
    </span>
  );
}

function Applications({
  applications,
  onStatus,
}: {
  applications: ApplicationView[];
  onStatus: (jobId: string, status: ApplicationStatus) => void;
}) {
  if (applications.length === 0) {
    return (
      <p className="py-16 text-sm" style={{ color: "var(--text-3)" }}>
        Nothing tracked yet. Set a status on any job in the tape.
      </p>
    );
  }
  return (
    <div className="sm:grid sm:grid-cols-[1.2fr_1.6fr_auto_auto_auto] sm:gap-x-8">
      {applications.map((app, i) => {
        const latency =
          app.appliedAt && app.jobDetectedAt
            ? ageLabel(app.jobDetectedAt, Date.parse(app.appliedAt))
            : "—";
        return (
          <div key={app.jobId} className="sm:contents">
            <div className="py-5 text-[15px]" style={{ color: "var(--text-2)" }}>
              {app.companyName}
            </div>
            <div className="py-5 text-[15px]" style={{ color: "var(--text)" }}>
              {app.jobTitle}
            </div>
            <div className="py-5">
              <StatusSelect value={app.status} onChange={(s) => onStatus(app.jobId, s)} />
            </div>
            <div className="mono py-5 text-xs" style={{ color: "var(--text-3)" }}>
              detected {ageLabel(app.jobDetectedAt)}
            </div>
            <div className="mono py-5 text-xs" style={{ color: "var(--text-3)" }}>
              {app.appliedAt ? `applied ${ageLabel(app.appliedAt)} · → ${latency}` : "not applied"}
            </div>
            {i < applications.length - 1 && <hr className="rule sm:col-span-5" />}
          </div>
        );
      })}
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
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={() => onSelect(job)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="group w-full cursor-pointer border-0 bg-transparent text-left"
    >
      <div className="grid grid-cols-1 gap-x-8 gap-y-1.5 px-1 py-5 transition-colors duration-200 sm:grid-cols-[3.5rem_1.1fr_2.2fr_3.5rem_auto] sm:items-baseline sm:py-6">
        {/* AGE */}
        <div className="mono text-xs" style={{ color: hover ? "var(--text-2)" : "var(--text-3)" }}>
          {ageLabel(job.detectedAt, now)}
        </div>
        {/* COMPANY */}
        <div
          className="text-[15px] transition-colors duration-200 sm:hidden lg:block"
          style={{ color: hover ? "var(--text)" : "var(--text-2)" }}
        >
          {job.companyName}
        </div>
        {/* ROLE */}
        <div>
          <span
            className="text-[17px] font-medium tracking-[-0.01em] transition-colors duration-200"
            style={{ color: hover ? "var(--text)" : "var(--text)" }}
          >
            {job.title}
          </span>
          <StatusText status={job.applicationStatus} />
          <span
            className="ml-3 text-sm transition-opacity duration-200"
            style={{ color: "var(--accent)", opacity: hover ? 1 : 0 }}
          >
            ↗
          </span>
        </div>
        {/* MATCH */}
        <div
          className="mono text-sm text-right transition-colors duration-200"
          style={{ color: hover ? "var(--text-2)" : "var(--text-3)" }}
        >
          {job.matchScore !== undefined && job.matchScore !== null ? job.matchScore : "—"}
        </div>
        {/* SOURCE */}
        <div
          className="text-right text-[11px] uppercase tracking-[0.14em] transition-colors duration-200 sm:block"
          style={{ color: "var(--text-faint)" }}
        >
          {job.provider}
        </div>
      </div>
    </button>
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
    <div>
      <div className="flex items-baseline justify-between">
        <button onClick={onBack} className="nav-link">
          ← Tape
        </button>
        <span className="section-label">{job.provider}</span>
      </div>

      <p className="mt-14 text-sm" style={{ color: "var(--text-2)" }}>
        {job.companyName}
      </p>
      <h2
        className="mt-3 text-3xl font-semibold tracking-[-0.02em] sm:text-4xl"
        style={{ color: "var(--text)" }}
      >
        {job.title}
      </h2>

      {job.matchScore !== undefined && job.matchScore !== null && (
        <p className="mt-5 text-sm" style={{ color: "var(--text-2)" }}>
          <span className="mono" style={{ color: "var(--text)" }}>
            {job.matchScore}
          </span>{" "}
          match
          {reasons.length > 0 && (
            <span className="ml-3" style={{ color: "var(--text-3)" }}>
              {reasons.map((r) => `✓ ${r}`).join("  ")}
            </span>
          )}
        </p>
      )}

      <hr className="rule my-8" />

      <div className="grid grid-cols-1 gap-x-10 gap-y-3 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-6 text-sm">
            <span style={{ color: "var(--text-3)" }}>{k}</span>
            <span style={{ color: "var(--text-2)" }}>{v}</span>
          </div>
        ))}
      </div>

      {job.descriptionPlain && (
        <p className="mt-8 max-w-2xl text-[15px] leading-7" style={{ color: "var(--text-2)" }}>
          {job.descriptionPlain}
        </p>
      )}

      <div className="mt-12 flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-3">
          <span className="section-label">Status</span>
          <StatusSelect value={job.applicationStatus} onChange={onStatus} />
        </div>
        <div className="flex items-center gap-6">
          <button
            onClick={() => onOpen(job.applyUrl)}
            className="text-sm font-medium transition-colors"
            style={{ color: "var(--accent)" }}
          >
            APPLY NOW →
          </button>
          <button
            onClick={() => onOpen(job.jobUrl)}
            className="nav-link"
            style={{ color: "var(--text-2)" }}
          >
            Details
          </button>
        </div>
      </div>
    </div>
  );
}

function Sources({ sources }: { sources: SourceHealth[] }) {
  if (sources.length === 0) {
    return (
      <p className="py-16 text-sm" style={{ color: "var(--text-3)" }}>
        No sources configured.
      </p>
    );
  }
  return (
    <div className="sm:grid sm:grid-cols-[1.6fr_1fr_auto_auto] sm:gap-x-8">
      {sources.map((s, i) => {
        const healthy = s.enabled && !s.backoffUntil && s.failureStreak === 0;
        const backoff = s.enabled && !!s.backoffUntil;
        const status = !s.enabled
          ? "disabled"
          : backoff
            ? "backoff"
            : healthy
              ? "healthy"
              : "degraded";
        const statusColor = healthy
          ? "var(--text-2)"
          : backoff
            ? "var(--accent-soft)"
            : "var(--accent)";
        return (
          <div key={s.companyId} className="sm:contents">
            <div className="py-5 text-[15px]" style={{ color: "var(--text)" }}>
              {s.name}
            </div>
            <div
              className="py-5 text-[11px] uppercase tracking-[0.14em]"
              style={{ color: "var(--text-faint)" }}
            >
              {s.provider}
            </div>
            <div
              className="py-5 text-[11px] uppercase tracking-[0.18em]"
              style={{ color: statusColor }}
            >
              {status}
            </div>
            <div className="mono py-5 text-xs" style={{ color: "var(--text-3)" }}>
              {s.lastSuccessAt ? `last success ${ageLabel(s.lastSuccessAt)} ago` : "never polled"}
              {s.failureStreak > 0
                ? ` · ${s.failureStreak} failure${s.failureStreak === 1 ? "" : "s"}`
                : ""}
            </div>
            {i < sources.length - 1 && <hr className="rule sm:col-span-4" />}
          </div>
        );
      })}
    </div>
  );
}

function Hero({ sys, now }: { sys: SystemStatus | undefined; now: number }) {
  const stale = sys?.lastPollAt ? Date.now() - Date.parse(sys.lastPollAt) > 5 * 60 * 1000 : false;
  return (
    <div className="grid grid-cols-1 gap-x-12 gap-y-10 py-16 sm:py-20 lg:grid-cols-[1.7fr_1fr] lg:items-end">
      <div>
        <h1 className="hero-display">
          Anything
          <br />
          new<span className="hero-accent">?</span>
        </h1>
      </div>
      <div className="lg:justify-self-end lg:pb-3 lg:text-right">
        <p className="max-w-xs text-[15px] leading-7" style={{ color: "var(--text-2)" }}>
          Your career feeds, checked{" "}
          <span style={{ color: "var(--text)" }}>
            every {sys ? sys.cadenceSeconds : 120} seconds.
          </span>
        </p>
        <div className="mt-8 space-y-1.5">
          <p
            className="text-[11px] font-medium uppercase tracking-[0.24em]"
            style={{ color: "var(--accent)" }}
          >
            Live
          </p>
          <p className="text-sm" style={{ color: "var(--text-2)" }}>
            {sys ? `${sys.companyCount} companies` : "…"} ·{" "}
            <span className="mono">{sys ? `${sys.cadenceSeconds}s` : "120s"}</span> cadence
          </p>
          <p
            className="mono text-sm"
            style={{ color: stale ? "var(--accent-soft)" : "var(--text-3)" }}
          >
            {sys?.lastPollAt ? `last poll ${ageLabel(sys.lastPollAt, now)} ago` : "no polls yet"}
          </p>
        </div>
      </div>
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
    <div className="min-h-screen" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-7 py-10 lg:px-12">
        {/* IDENTITY */}
        <header className="flex items-baseline justify-between">
          <h1 className="wordmark">ApplyRN</h1>
          <nav className="flex items-baseline gap-7 sm:gap-9">
            <button
              onClick={() => {
                setView("live");
                setSelected(null);
              }}
              className={`nav-link ${view === "live" ? "active" : ""}`}
            >
              Live
            </button>
            <button
              onClick={() => {
                setView("applications");
                setSelected(null);
              }}
              className={`nav-link ${view === "applications" ? "active" : ""}`}
            >
              Applications
            </button>
            <button
              onClick={() => {
                setView("sources");
                setSelected(null);
              }}
              className={`nav-link ${view === "sources" ? "active" : ""}`}
            >
              Sources
            </button>
            <button
              onClick={() => {
                clearToken();
                setAuthed(false);
              }}
              className="nav-link quiet"
            >
              Sign out
            </button>
          </nav>
        </header>

        {/* LIVE: SYSTEM STATE + MARKET */}
        {view === "live" && !selected && (
          <>
            <Hero sys={sys} now={now} />

            <div className="flex items-baseline justify-between pb-3">
              <span className="section-label">Latest openings</span>
              {jobs.error && (
                <span className="text-xs" style={{ color: "var(--accent)" }}>
                  {jobs.error}
                </span>
              )}
            </div>
            <hr className="rule" />

            {jobs.data && jobs.data.jobs.length === 0 ? (
              <p className="py-16 text-sm" style={{ color: "var(--text-3)" }}>
                No jobs detected yet. The tape stays quiet until the first poll finds something.
              </p>
            ) : (
              <div>
                {(jobs.data?.jobs ?? []).map((job) => (
                  <div key={job.id}>
                    <TapeRow job={job} now={now} onSelect={setSelected} />
                    <hr className="rule" />
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {view === "live" && selected && (
          <main className="flex-1 py-12">
            <Detail
              job={selected}
              onBack={() => setSelected(null)}
              onOpen={open}
              onStatus={(s) => {
                setSelected({ ...selected, applicationStatus: s });
                void setStatus(selected.id, s);
              }}
            />
          </main>
        )}

        {view === "applications" && (
          <main className="flex-1 py-16">
            <h2 className="hero-display" style={{ fontSize: "clamp(2rem, 4vw, 3.5rem)" }}>
              Applications
            </h2>
            <p className="mt-4 max-w-md text-[15px] leading-7" style={{ color: "var(--text-2)" }}>
              What you have touched, from detected to offer.
            </p>
            <div className="mt-12">
              <Applications
                applications={applications.data?.applications ?? []}
                onStatus={setStatus}
              />
            </div>
          </main>
        )}

        {view === "sources" && (
          <main className="flex-1 py-16">
            <h2 className="hero-display" style={{ fontSize: "clamp(2rem, 4vw, 3.5rem)" }}>
              Sources
            </h2>
            <p className="mt-4 max-w-md text-[15px] leading-7" style={{ color: "var(--text-2)" }}>
              Which career feeds we watch, and how they are doing.
            </p>
            <div className="mt-12">
              <Sources sources={sources.data?.sources ?? []} />
            </div>
          </main>
        )}

        <footer className="mt-auto pt-16 pb-2">
          <hr className="rule mb-5" />
          <p className="text-xs" style={{ color: "var(--text-faint)" }}>
            Find it early. Apply right now.
          </p>
        </footer>
      </div>
    </div>
  );
}
