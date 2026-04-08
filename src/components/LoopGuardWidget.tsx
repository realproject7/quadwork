"use client";

import { useEffect, useState } from "react";

interface LoopGuardWidgetProps {
  projectId: string;
}

/**
 * #403 / quadwork#274: operator widget for AgentChattr's loop guard
 * (max_agent_hops). AC's default is 4, which fires mid-cycle on a
 * normal autonomous PR review (head→dev→re1+re2→dev→head merge ≈ 5
 * hops). QuadWork ships with 30 by default but the operator may
 * want to tune it. The widget reads the persisted value from the
 * project's config.toml and writes back through /api/loop-guard,
 * which both rewrites config.toml and live-pushes to the running AC
 * via update_settings ws event so the change is immediate.
 */
export default function LoopGuardWidget({ projectId }: LoopGuardWidgetProps) {
  const [value, setValue] = useState<number>(30);
  const [draft, setDraft] = useState<string>("30");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<boolean | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  // Load on mount + when project changes.
  useEffect(() => {
    fetch(`/api/loop-guard?project=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.value === "number") {
          setValue(d.value);
          setDraft(String(d.value));
        }
      })
      .catch(() => {});
  }, [projectId]);

  const apply = () => {
    const n = parseInt(draft, 10);
    if (!Number.isInteger(n) || n < 4 || n > 50) {
      setError("Must be an integer between 4 and 50.");
      return;
    }
    setSaving(true);
    setError(null);
    fetch(`/api/loop-guard?project=${encodeURIComponent(projectId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: n }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          throw new Error(`${r.status}: ${body.slice(0, 120)}`);
        }
        return r.json();
      })
      .then((d) => {
        setValue(d.value);
        setLive(d.live);
      })
      .catch((err) => setError(err.message || String(err)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="border border-border rounded p-2 text-[11px] font-mono">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="uppercase tracking-wider text-text-muted">Loop Guard</span>
        <button
          type="button"
          aria-label="About loop guard"
          onClick={() => setShowHelp((s) => !s)}
          className="w-3.5 h-3.5 rounded-full border border-border text-[9px] leading-none text-text-muted hover:text-accent hover:border-accent inline-flex items-center justify-center"
        >?</button>
      </div>
      {showHelp && (
        <div className="mb-1.5 p-1.5 text-[10px] leading-snug text-text bg-bg-surface border border-border/60 rounded">
          <b>Loop Guard</b> pauses agent-to-agent message chains after this many hops with no human reply. Higher values let agents work longer overnight; lower values add safety against runaway loops. AgentChattr accepts <b>4–50</b>; QuadWork defaults to <b>30</b> (about 5–6 full PR cycles). Posting any chat message yourself resets the counter immediately.
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <span className="text-text-muted">Pause after</span>
        <input
          type="number"
          min={4}
          max={50}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={saving}
          className="w-12 bg-transparent px-1 py-0.5 border border-border rounded text-text outline-none focus:ring-1 focus:ring-accent"
        />
        <span className="text-text-muted">hops</span>
        <button
          type="button"
          onClick={apply}
          disabled={saving || draft === String(value)}
          className="ml-auto px-2 py-0.5 text-[10px] text-accent border border-accent/40 rounded hover:bg-accent/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Apply (writes config.toml + live-pushes to AgentChattr)"
        >
          {saving ? "…" : "Apply"}
        </button>
      </div>
      {error && (
        <div className="mt-1 text-[10px] text-red-400">{error}</div>
      )}
      {live === false && !error && (
        <div className="mt-1 text-[10px] text-text-muted">
          Saved to config.toml — live update failed; takes effect on next AC restart.
        </div>
      )}
    </div>
  );
}
