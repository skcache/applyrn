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
 * ApplyRN - editorial recruiting terminal (PR #12, pass 2).
 *
 * Composition per the "Perfected simplicity" reference: small nav, large
 * breathing region, massive left headline, small right system block,
 * deliberately placed content below. One coral accent, locked. Neutral
 * charcoal, not brown. Instrument Sans display, system mono numerics.
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
        <p className="mt-8 text-base leading-7" style={{ color: "var(--text-2)" }}>
          Your recruiting terminal. Enter the dashboard token to open the tape.
        </p>
        <input
          type="password"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="dashboard token"
          className="gate-input mt-8"
        />
        {error && (
          <p className="mt-3 text-sm" style={{ color: "var(--accent)" }}>
            {error}
          </p>
        )}
        <button
          onClick={submit}
          className="mt-8 text-[15px] font-medium"
          style={{ color: "var(--accent)" }}
        >
          Open →
        </button>
      </div>
    </div>
  );
}

/** Styled status control (intentional select, not a floating native box). */
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
      className="status-select"
      aria-label="Application status"
    >
      {APPLICATION_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

/** Status as quiet tracked text. Neutral, never accent (accent is reserved). */
function StatusText({ status }: { status: string | undefined }) {
  if (!status || status === "DETECTED") return null;
  const later = ["APPLIED", "OA", "INTERVIEW", "FINAL", "OFFER"].includes(status);
  return <span className={`status-text ${later ? "later" : ""}`}>{status}</span>;
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
      <p className="py-16 text-base" style={{ color: "var(--text-3)" }}>
        Nothing tracked yet. Set a status on any job in the tape.
      </p>
    );
  }

  const applied = applications.filter((a) => a.appliedAt).length;
  const inFlight = applications.filter((a) =>
    ["SAVED", "OA", "INTERVIEW", "FINAL"].includes(a.status),
  ).length;

  return (
    <div style={{ maxWidth: 880 }}>
      <div className="mb-8 flex items-baseline gap-6" style={{ color: "var(--text-3)" }}>
        <span className="mono text-[13px]">{applications.length} tracked</span>
        <span className="mono text-[13px]">{applied} applied</span>
        <span className="mono text-[13px]">{inFlight} in flight</span>
      </div>

      {applications.map((app, i) => {
        const latency =
          app.appliedAt && app.jobDetectedAt
            ? ageLabel(app.jobDetectedAt, Date.parse(app.appliedAt))
            : null;
        return (
          <div key={app.jobId}>
            <div className="ledger-row">
              <div>
                <div className="ledger-secondary">{app.companyName}</div>
                <div className="ledger-primary mt-1">{app.jobTitle}</div>
              </div>
              <div className="ledger-meta" style={{ textAlign: "right" }}>
                {app.appliedAt
                  ? `applied ${ageLabel(app.appliedAt)}`
                  : `detected ${ageLabel(app.jobDetectedAt)}`}
                {latency ? ` · ${latency} to apply` : ""}
              </div>
              <div>
                <StatusSelect value={app.status} onChange={(s) => onStatus(app.jobId, s)} />
              </div>
            </div>
            {i < applications.length - 1 && <hr className="rule" />}
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
  return (
    <button className="opening" onClick={() => onSelect(job)}>
      <div className="opening-inner">
        <span className="opening-age">{ageLabel(job.detectedAt, now)}</span>
        <span className="opening-company">{job.companyName}</span>
        <span className="opening-match">
          {job.matchScore !== undefined && job.matchScore !== null ? job.matchScore : "—"}
        </span>
        <span className="opening-source">{job.provider}</span>
      </div>
      <div className="opening-role">
        {job.title}
        <StatusText status={job.applicationStatus} />
        <span className="opening-arrow">↗</span>
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
  const appliedLatency =
    job.applicationAppliedAt && job.detectedAt
      ? ageLabel(job.detectedAt, Date.parse(job.applicationAppliedAt))
      : null;
  const detectionLatency =
    job.publicationTimeKind === "authoritative" && job.sourcePublishedAt
      ? ageLabel(job.sourcePublishedAt, Date.parse(job.detectedAt))
      : null;

  return (
    <div className="detail">
      <div className="flex items-baseline justify-between">
        <button onClick={onBack} className="nav-link">
          ← Live
        </button>
        <span className="opening-source">{job.provider}</span>
      </div>

      <div className="mt-16">
        <div className="ledger-secondary">{job.companyName}</div>
        <h2 className="detail-title mt-3">{job.title}</h2>
        {job.matchScore !== undefined && job.matchScore !== null && (
          <p className="mt-5 text-[15px]" style={{ color: "var(--text-2)" }}>
            <span className="mono" style={{ color: "var(--text)" }}>
              {job.matchScore}
            </span>{" "}
            match
            {reasons.length > 0 && (
              <span className="ml-3" style={{ color: "var(--text-3)" }}>
                {reasons.join(" · ")}
              </span>
            )}
          </p>
        )}
      </div>

      {job.descriptionPlain && (
        <section className="detail-section">
          <h3 className="detail-section-label">About</h3>
          <p className="detail-body">{job.descriptionPlain}</p>
        </section>
      )}

      <section className="detail-section">
        <h3 className="detail-section-label">Details</h3>
        <dl className="detail-grid">
          {job.location && (
            <div className="detail-item">
              <dt>Location</dt>
              <dd>{job.location}</dd>
            </div>
          )}
          {job.employmentType && (
            <div className="detail-item">
              <dt>Employment</dt>
              <dd>{job.employmentType}</dd>
            </div>
          )}
          {job.compensationText && (
            <div className="detail-item">
              <dt>Compensation</dt>
              <dd>{job.compensationText}</dd>
            </div>
          )}
          {job.department && (
            <div className="detail-item">
              <dt>Department</dt>
              <dd>{job.department}</dd>
            </div>
          )}
          {job.team && (
            <div className="detail-item">
              <dt>Team</dt>
              <dd>{job.team}</dd>
            </div>
          )}
          <div className="detail-item">
            <dt>Provider</dt>
            <dd style={{ textTransform: "capitalize" }}>{job.provider}</dd>
          </div>
        </dl>
      </section>

      <section className="detail-section">
        <h3 className="detail-section-label">Timing</h3>
        <dl className="detail-grid">
          {job.publicationTimeKind === "authoritative" && job.sourcePublishedAt && (
            <div className="detail-item">
              <dt>Published</dt>
              <dd className="mono">{new Date(job.sourcePublishedAt).toLocaleString()}</dd>
            </div>
          )}
          <div className="detail-item">
            <dt>First seen</dt>
            <dd className="mono">{new Date(job.firstSeenAt).toLocaleString()}</dd>
          </div>
          <div className="detail-item">
            <dt>Detected</dt>
            <dd className="mono">{new Date(job.detectedAt).toLocaleString()}</dd>
          </div>
          {detectionLatency && (
            <div className="detail-item">
              <dt>Detection latency</dt>
              <dd className="mono">{detectionLatency}</dd>
            </div>
          )}
          {job.applicationAppliedAt && (
            <div className="detail-item">
              <dt>Applied</dt>
              <dd className="mono">{new Date(job.applicationAppliedAt).toLocaleString()}</dd>
            </div>
          )}
          {appliedLatency && (
            <div className="detail-item">
              <dt>Apply latency</dt>
              <dd className="mono">{appliedLatency}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="detail-section">
        <h3 className="detail-section-label">Status</h3>
        <StatusSelect value={job.applicationStatus} onChange={onStatus} />
      </section>

      <div className="detail-actions">
        <button onClick={() => onOpen(job.applyUrl)} className="apply-link">
          Apply now ↗
        </button>
        <button onClick={() => onOpen(job.jobUrl)} className="source-link">
          Source ↗
        </button>
      </div>
    </div>
  );
}

function Sources({ sources }: { sources: SourceHealth[] }) {
  if (sources.length === 0) {
    return (
      <p className="py-16 text-base" style={{ color: "var(--text-3)" }}>
        No sources configured.
      </p>
    );
  }
  return (
    <div style={{ maxWidth: 880 }}>
      {sources.map((s, i) => {
        const healthy = s.enabled && !s.backoffUntil && s.failureStreak === 0;
        const backoff = s.enabled && !!s.backoffUntil;
        const down = !s.enabled || s.failureStreak >= 3;
        const status = down ? "down" : backoff ? "backoff" : healthy ? "healthy" : "degraded";
        return (
          <div key={s.companyId}>
            <div
              className="ledger-row"
              style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) auto" }}
            >
              <div>
                <div className="ledger-primary">{s.name}</div>
                <div className="opening-source mt-1" style={{ textAlign: "left" }}>
                  {s.provider}
                </div>
              </div>
              <div className="ledger-meta" style={{ alignSelf: "center" }}>
                {s.lastSuccessAt ? `last success ${ageLabel(s.lastSuccessAt)} ago` : "never polled"}
                {s.failureStreak > 0
                  ? ` · ${s.failureStreak} failure${s.failureStreak === 1 ? "" : "s"}`
                  : ""}
              </div>
              <div style={{ alignSelf: "center" }}>
                <span className={`health ${status}`}>
                  <span className="health-dot" />
                  {status}
                </span>
              </div>
            </div>
            {i < sources.length - 1 && <hr className="rule" />}
          </div>
        );
      })}
    </div>
  );
}

function Hero({ sys, now }: { sys: SystemStatus | undefined; now: number }) {
  const stale = sys?.lastPollAt ? Date.now() - Date.parse(sys.lastPollAt) > 5 * 60 * 1000 : false;
  return (
    <div className="hero">
      <div className="grid grid-cols-1 gap-x-16 gap-y-12 lg:grid-cols-[1.6fr_1fr] lg:items-end">
        <h1 className="hero-display">
          Find jobs
          <br />
          before they
          <br />
          <span className="hero-accent">disappear.</span>
        </h1>
        <div className="lg:justify-self-end lg:pb-2 lg:text-right">
          <p className="hero-meta">We watch your chosen career feeds every two minutes.</p>
          <div className="mt-8 space-y-2">
            <p className="live-line">Live</p>
            <p className="text-[15px]" style={{ color: "var(--text-2)" }}>
              {sys ? `${sys.companyCount} sources` : "…"} ·{" "}
              <span className="mono">{sys ? `${sys.cadenceSeconds}s` : "120s"}</span>
            </p>
            <p
              className="mono text-[14px]"
              style={{ color: stale ? "var(--accent-soft)" : "var(--text-3)" }}
            >
              last poll {sys?.lastPollAt ? `${ageLabel(sys.lastPollAt, now)} ago` : "never"}
            </p>
          </div>
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

  const go = (v: View) => {
    setView(v);
    setSelected(null);
  };

  return (
    <div style={{ background: "var(--bg)", color: "var(--text)", minHeight: "100dvh" }}>
      <div className="canvas flex min-h-[100dvh] flex-col">
        {/* IDENTITY */}
        <header className="nav">
          <h1 className="wordmark">ApplyRN</h1>
          <nav className="nav-links">
            <button
              onClick={() => go("live")}
              className={`nav-link ${view === "live" ? "active" : ""}`}
            >
              Live
            </button>
            <button
              onClick={() => go("applications")}
              className={`nav-link ${view === "applications" ? "active" : ""}`}
            >
              Applications
            </button>
            <button
              onClick={() => go("sources")}
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

        {/* LIVE */}
        {view === "live" && !selected && (
          <div className="flex flex-1 flex-col">
            <Hero sys={sys} now={now} />

            <div style={{ marginTop: "var(--hero-gap)" }}>
              <div className="flex items-baseline justify-between pb-4">
                <span className="section-label">Latest openings</span>
                {jobs.error && (
                  <span className="text-[13px]" style={{ color: "var(--accent)" }}>
                    {jobs.error}
                  </span>
                )}
              </div>
              <hr className="rule" />

              {jobs.data && jobs.data.jobs.length === 0 ? (
                <p className="py-20 text-base" style={{ color: "var(--text-3)" }}>
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
            </div>
          </div>
        )}

        {view === "live" && selected && (
          <main className="flex-1 py-16">
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

        {/* APPLICATIONS */}
        {view === "applications" && (
          <main className="flex-1 py-20">
            <h2 className="page-title">Applications</h2>
            <p className="page-intro">What you have touched, from detected to offer.</p>
            <div className="mt-12">
              <Applications
                applications={applications.data?.applications ?? []}
                onStatus={setStatus}
              />
            </div>
          </main>
        )}

        {/* SOURCES */}
        {view === "sources" && (
          <main className="flex-1 py-20">
            <h2 className="page-title">Sources</h2>
            <p className="page-intro">Which career feeds we watch, and how they are doing.</p>
            <div className="mt-12">
              <Sources sources={sources.data?.sources ?? []} />
            </div>
          </main>
        )}

        <footer className="mt-auto pb-6 pt-16">
          <hr className="rule mb-5" />
          <p className="text-[13px]" style={{ color: "var(--text-faint)" }}>
            Find it early. Apply right now.
          </p>
        </footer>
      </div>
    </div>
  );
}
