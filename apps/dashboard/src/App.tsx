export function App() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="flex items-baseline justify-between">
          <h1 className="text-sm font-semibold uppercase tracking-widest text-zinc-100">ApplyRN</h1>
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            V0 foundation
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-100">
          The live recruiting tape ships in Stack C.
        </h2>
        <p className="mt-4 text-sm leading-6 text-zinc-400">
          The detection worker and Telegram alerts are being built first (Issues 0-4). This
          dashboard will become the quiet terminal: live tape, job detail, source health, direct
          apply. Until then this page stays intentionally empty.
        </p>
        <div className="mt-10 border border-zinc-800 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">System</p>
          <p className="mt-2 text-sm text-zinc-300">
            Worker: <span className="text-zinc-500">build in progress</span>
          </p>
          <p className="mt-1 text-sm text-zinc-300">
            D1: <span className="text-zinc-500">schema ready, seeding local</span>
          </p>
          <p className="mt-1 text-sm text-zinc-300">
            Telegram: <span className="text-zinc-500">path built, live delivery in Stack A</span>
          </p>
        </div>
      </main>
    </div>
  );
}
