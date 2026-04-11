"use client";

import { useEffect, useState } from "react";
import InfoTooltip from "./InfoTooltip";

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
  // #422 / quadwork#310: per-project auto-continue opt-in. Default
  // OFF — operators opt in knowing the trade-off (runaway loops
  // will silently resume after the delay). Hydrated from /api/config
  // on mount; saving flips the field and PUTs the whole config back.
  const [autoContinue, setAutoContinue] = useState<boolean>(false);
  const [autoContinueDelaySec, setAutoContinueDelaySec] = useState<number>(30);
  const [autoContinueDelayDraft, setAutoContinueDelayDraft] = useState<string>("30");
  const [autoContinueSaving, setAutoContinueSaving] = useState(false);

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
    // #422 / quadwork#310: read auto-continue prefs from the whole
    // config (they live on the project entry, not the loop-guard
    // endpoint). Scoped to the current projectId.
    fetch(`/api/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg || !Array.isArray(cfg.projects)) return;
        const proj = cfg.projects.find((p: { id: string }) => p.id === projectId);
        if (!proj) return;
        setAutoContinue(!!proj.auto_continue_loop_guard);
        const d = Number.isFinite(proj.auto_continue_delay_sec) ? proj.auto_continue_delay_sec : 30;
        setAutoContinueDelaySec(d);
        setAutoContinueDelayDraft(String(d));
      })
      .catch(() => {});
  }, [projectId]);

  // Persist auto-continue prefs by fetching current config, mutating
  // the target project's two fields, and PUT'ing back. We keep the
  // whole-config PUT contract the SettingsPage uses so we don't
  // have to add a new endpoint for two flags. Failures leave the
  // in-memory checkbox out of sync with disk, which the next mount
  // will correct.
  const saveAutoContinue = async (nextEnabled: boolean, nextDelay: number) => {
    setAutoContinueSaving(true);
    try {
      const cfgRes = await fetch(`/api/config`);
      if (!cfgRes.ok) throw new Error(`GET /api/config ${cfgRes.status}`);
      const cfg = await cfgRes.json();
      if (!cfg || !Array.isArray(cfg.projects)) throw new Error("config shape");
      const idx = cfg.projects.findIndex((p: { id: string }) => p.id === projectId);
      if (idx < 0) throw new Error(`project ${projectId} not found`);
      cfg.projects[idx] = {
        ...cfg.projects[idx],
        auto_continue_loop_guard: nextEnabled,
        auto_continue_delay_sec: nextDelay,
      };
      const putRes = await fetch(`/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      if (!putRes.ok) throw new Error(`PUT /api/config ${putRes.status}`);
    } finally {
      setAutoContinueSaving(false);
    }
  };

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
        <InfoTooltip>
          <b>Loop Guard</b> pauses agent-to-agent message chains after this many hops with no human reply. Higher values let agents work longer overnight; lower values add safety against runaway loops. AgentChattr accepts <b>4–50</b>; QuadWork defaults to <b>30</b> (about 5–6 full PR cycles). Posting any chat message yourself resets the counter immediately.
        </InfoTooltip>
      </div>
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
      {/* #422 / quadwork#310: auto-continue opt-in. Default OFF so
          operators have to explicitly enable "resume the loop guard
          for me". Delay default 30s, min 5s (prevents pathological
          tight loops from resuming instantly). */}
      <label className="mt-2 flex items-center gap-1.5 text-[10px] text-text-muted cursor-pointer select-none">
        <input
          type="checkbox"
          checked={autoContinue}
          disabled={autoContinueSaving}
          onChange={(e) => {
            const next = e.target.checked;
            setAutoContinue(next);
            saveAutoContinue(next, autoContinueDelaySec).catch(() => {
              // revert on failure
              setAutoContinue(!next);
            });
          }}
        />
        Auto-continue after pause
        <span className="text-text-muted">— wait</span>
        <input
          type="number"
          min={5}
          max={300}
          value={autoContinueDelayDraft}
          disabled={autoContinueSaving || !autoContinue}
          onChange={(e) => setAutoContinueDelayDraft(e.target.value)}
          onBlur={() => {
            const n = parseInt(autoContinueDelayDraft, 10);
            const clamped = Number.isFinite(n) ? Math.max(5, Math.min(300, n)) : 30;
            setAutoContinueDelaySec(clamped);
            setAutoContinueDelayDraft(String(clamped));
            if (clamped !== autoContinueDelaySec) {
              saveAutoContinue(autoContinue, clamped).catch(() => {});
            }
          }}
          className="w-10 bg-transparent px-1 py-0.5 border border-border rounded text-text outline-none focus:ring-1 focus:ring-accent disabled:opacity-40 text-center"
        />
        <span className="text-text-muted">s before /continue</span>
      </label>
    </div>
  );
}
