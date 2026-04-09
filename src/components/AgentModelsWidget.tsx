"use client";

// #343: per-agent Model + Reasoning Effort configuration widget.
// Lives in the Operator Features right column. Reads
// /api/project/:id/agent-models for the current per-agent rows
// and PUTs individual rows back to update the persisted config.
// Each row also has a "Restart" button that hits the existing
// POST /api/agents/:project/:agent/restart so a changed model/
// effort picks up without needing the operator to go touch
// ~/.codex/config.toml outside QuadWork.

import { useCallback, useEffect, useState } from "react";

interface AgentRow {
  agent_id: string;
  backend: string;
  model: string;
  reasoning_effort: string;
  reasoning_supported: boolean;
}

interface AgentModelsWidgetProps {
  projectId: string;
}

// No xhigh — explicitly excluded per #343 ("capacity-failure hot spot").
const REASONING_LEVELS = ["minimal", "low", "medium", "high"] as const;

// #343 follow-up: backend-specific model dropdown options.
// Empty string = use the CLI's own default (no -c / --model flag
// passed at all). The lists below are the known-good slugs we
// ship with this release; operators who need something bleeding
// edge can still override by editing ~/.quadwork/config.json
// directly — this widget is the guided happy path.
const MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  codex: [
    { value: "", label: "(CLI default)" },
    { value: "gpt-5.4", label: "gpt-5.4" },
    { value: "gpt-5", label: "gpt-5" },
    { value: "gpt-4o", label: "gpt-4o" },
  ],
  claude: [
    { value: "", label: "(CLI default)" },
    { value: "claude-opus-4-6", label: "claude-opus-4-6" },
    { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
    { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5" },
  ],
};
function optionsForBackend(backend: string) {
  return MODEL_OPTIONS[backend] || [{ value: "", label: "(CLI default)" }];
}

export default function AgentModelsWidget({ projectId }: AgentModelsWidgetProps) {
  const [rows, setRows] = useState<AgentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // #343 follow-up: track which agents have edits that haven't
  // yet been applied to the live session. A row is marked dirty
  // when the operator saves a new model or reasoning setting via
  // update(), and cleared only when the operator clicks Restart
  // on that row (restart() succeeds). Until then the UI shows a
  // "needs restart" badge next to the agent id so it is visually
  // obvious which sessions are running stale config — the ticket
  // explicitly calls this out as a required acceptance.
  const [needsRestart, setNeedsRestart] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/project/${encodeURIComponent(projectId)}/agent-models`);
      if (!r.ok) throw new Error(`${r.status}`);
      const data = await r.json();
      setRows(data.agents || []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const update = async (agentId: string, patch: Partial<Pick<AgentRow, "model" | "reasoning_effort">>) => {
    setBusy(agentId);
    setError(null);
    try {
      const r = await fetch(`/api/project/${encodeURIComponent(projectId)}/agent-models/${agentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || `${r.status}`);
      // #343: config has drifted from the running session until
      // the operator explicitly restarts this agent.
      setNeedsRestart((prev) => {
        const next = new Set(prev);
        next.add(agentId);
        return next;
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const restart = async (agentId: string) => {
    setBusy(agentId);
    setError(null);
    try {
      const r = await fetch(`/api/agents/${encodeURIComponent(projectId)}/${encodeURIComponent(agentId)}/restart`, { method: "POST" });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || `${r.status}`);
      // Running session is now on the new config — clear the
      // restart-required badge.
      setNeedsRestart((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col border border-border">
      <div className="flex items-center justify-between h-7 px-3 shrink-0 border-b border-border">
        <span className="text-[11px] text-text-muted uppercase tracking-wider">Agent Models</span>
        {error && <span className="text-[10px] text-error max-w-[60%] truncate" title={error}>err: {error}</span>}
      </div>
      <div className="p-2 flex flex-col gap-1.5">
        {!rows && <div className="text-[11px] text-text-muted">Loading…</div>}
        {rows && rows.length === 0 && (
          <div className="text-[11px] text-text-muted">No agents configured.</div>
        )}
        {rows && rows.map((row) => (
          <div key={row.agent_id} className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] text-text font-semibold w-16 shrink-0">{row.agent_id}</span>
            <span className="text-[10px] text-text-muted w-12 shrink-0">{row.backend}</span>
            {needsRestart.has(row.agent_id) && (
              <span
                className="text-[9px] text-[#ffcc00] border border-[#ffcc00]/40 px-1 py-[1px] shrink-0"
                title="Config changed — running session is still on the old model/effort. Click Restart to apply."
              >
                restart required
              </span>
            )}
            {/* #343: backend-specific model dropdown. Empty value
                = CLI default (no override). Options come from
                MODEL_OPTIONS[backend]; unknown backends fall
                back to just the "(CLI default)" entry. */}
            <select
              value={row.model}
              disabled={busy === row.agent_id}
              onChange={(e) => update(row.agent_id, { model: e.target.value })}
              className="flex-1 min-w-[140px] bg-transparent border border-border px-1 py-0.5 text-[11px] font-mono text-text outline-none focus:border-accent cursor-pointer disabled:opacity-50"
            >
              {optionsForBackend(row.backend).map((opt) => (
                <option key={opt.value} value={opt.value} className="bg-bg-surface">{opt.label}</option>
              ))}
              {/* If the persisted model isn't in the known list
                  (e.g. operator hand-edited config.json), keep
                  it selectable so their override doesn't vanish. */}
              {row.model && !optionsForBackend(row.backend).some((o) => o.value === row.model) && (
                <option value={row.model} className="bg-bg-surface">{row.model} (custom)</option>
              )}
            </select>
            {row.reasoning_supported ? (
              <select
                value={row.reasoning_effort || ""}
                disabled={busy === row.agent_id}
                onChange={(e) => update(row.agent_id, { reasoning_effort: e.target.value })}
                className="bg-transparent border border-border px-1 py-0.5 text-[11px] text-text outline-none focus:border-accent cursor-pointer disabled:opacity-50"
              >
                <option value="" className="bg-bg-surface">(default)</option>
                {REASONING_LEVELS.map((lvl) => (
                  <option key={lvl} value={lvl} className="bg-bg-surface">{lvl}</option>
                ))}
              </select>
            ) : (
              <span className="text-[10px] text-text-muted w-16 text-center">—</span>
            )}
            <button
              type="button"
              onClick={() => restart(row.agent_id)}
              disabled={busy === row.agent_id}
              title="Restart this agent to pick up the new model / reasoning setting"
              className="shrink-0 px-1.5 py-0.5 text-[10px] text-text-muted border border-border hover:text-accent hover:border-accent/40 disabled:opacity-50 transition-colors"
            >
              {busy === row.agent_id ? "…" : "Restart"}
            </button>
          </div>
        ))}
        <p className="mt-1 text-[10px] text-text-muted leading-snug">
          Codex reasoning effort defaults to <code className="text-text">medium</code> for new projects. Blank model falls back to the CLI default. Click Restart to apply changes to a live session.
        </p>
      </div>
    </div>
  );
}
