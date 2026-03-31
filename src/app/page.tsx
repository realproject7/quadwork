export default function Home() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight text-text">
          QuadWork
        </h1>
        <p className="text-sm text-text-muted">
          Multi-agent dashboard — panels coming soon
        </p>
        <div className="inline-block border border-border px-3 py-1 text-xs text-accent">
          v0.1.0
        </div>
      </div>
    </div>
  );
}
