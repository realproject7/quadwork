"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import DiscordSetupModal from "./DiscordSetupModal";

interface BatchState {
  complete: boolean;
  items: { issue_number: number }[];
}

interface DiscordBridgeWidgetProps {
  projectId: string;
}

interface DiscordStatus {
  running: boolean;
  configured: boolean;
  channel_id: string;
  bot_username: string;
  bridge_installed: boolean;
  last_error?: string;
}

async function callDiscord(action: string, body: Record<string, unknown>) {
  const r = await fetch(`/api/discord?action=${encodeURIComponent(action)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok || data.ok === false) throw new Error(data.error || `${r.status}`);
  return data;
}

/**
 * Per-project Discord Bridge widget.
 *
 * Lives in the bottom-right Operator Features quadrant. Shows
 * whether the bridge is running + channel id, and gives the operator
 * start/stop + a setup modal to configure bot_token + channel_id from
 * scratch.
 */
export default function DiscordBridgeWidget({ projectId }: DiscordBridgeWidgetProps) {
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [restartNotice, setRestartNotice] = useState<string | null>(null);

  // #518: Auto toggle — start/stop bridge with batch lifecycle
  const [autoDiscord, setAutoDiscord] = useState(false);
  const [autoStatus, setAutoStatus] = useState<string | null>(null);
  const prevBatchRef = useRef<{ complete: boolean; hasItems: boolean } | null>(null);
  const autoDiscordRef = useRef(autoDiscord);
  const runningRef = useRef(false);
  useEffect(() => { autoDiscordRef.current = autoDiscord; }, [autoDiscord]);

  // Load persisted auto setting from config
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    autoLoadedRef.current = false;
    prevBatchRef.current = null;
    setAutoDiscord(false);
    setAutoStatus(null);
  }, [projectId]);

  useEffect(() => {
    if (autoLoadedRef.current) return;
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg) return;
        const entry = (cfg.projects || []).find((p: { id: string }) => p.id === projectId);
        if (entry?.discord_auto) setAutoDiscord(true);
        autoLoadedRef.current = true;
      })
      .catch(() => {});
  }, [projectId]);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/discord?project=${encodeURIComponent(projectId)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      const data = (await r.json()) as DiscordStatus;
      setStatus(data);
      setPollError(null);
    } catch (e) {
      setPollError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, [load]);

  const noteInstallResponse = (data: { patched_projects?: string[] }) => {
    const patched = Array.isArray(data?.patched_projects) ? data.patched_projects : [];
    if (patched.length > 0) {
      setRestartNotice(
        `Install Bridge patched ${patched.length} AgentChattr config(s) ` +
        `(${patched.join(", ")}) to declare [agents.dc]. ` +
        `Click SERVER \u2192 Restart so AgentChattr picks up the new agent slug, ` +
        `then click Start again. Without the restart, Start will fail with a 400 registration loop.`,
      );
    } else {
      setRestartNotice(null);
    }
  };

  const start = async () => {
    setBusy(true); setActionError(null);
    try {
      if (status && !status.bridge_installed) {
        const data = await callDiscord("install", {});
        noteInstallResponse(data);
      }
      await callDiscord("start", { project_id: projectId });
      await load();
    } catch (e) { setActionError((e as Error).message); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true); setActionError(null);
    try {
      await callDiscord("stop", { project_id: projectId });
      await load();
    } catch (e) { setActionError((e as Error).message); }
    finally { setBusy(false); }
  };

  const onSaveCredentials = async (bot_token: string, channel_id: string) => {
    await callDiscord("save-config", { project_id: projectId, bot_token, channel_id });
    try {
      if (status && !status.bridge_installed) {
        const data = await callDiscord("install", {});
        noteInstallResponse(data);
      }
      await callDiscord("start", { project_id: projectId });
    } catch (e) {
      setActionError((e as Error).message);
    }
    await load();
  };

  // #518: toggle handler — persist discord_auto in project config
  const toggleAutoDiscord = useCallback(async () => {
    const next = !autoDiscord;
    setAutoDiscord(next);
    if (!next) {
      setAutoStatus(null);
      prevBatchRef.current = null;
    }
    try {
      const r = await fetch("/api/config");
      if (!r.ok) return;
      const cfg = await r.json();
      const entry = (cfg.projects || []).find((p: { id: string }) => p.id === projectId);
      if (entry) {
        entry.discord_auto = next;
        await fetch("/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cfg),
        });
      }
    } catch { /* non-fatal */ }
  }, [autoDiscord, projectId]);

  // #518: batch lifecycle polling — auto-start/stop bridge with batch
  const AUTO_POLL_MS = 30_000;

  const checkBatchLifecycle = useCallback(async () => {
    if (!autoDiscordRef.current) return;
    try {
      const r = await fetch(`/api/batch-progress?project=${encodeURIComponent(projectId)}`);
      if (!r.ok) return;
      const data: BatchState = await r.json();
      const hasItems = data.items.length > 0;
      const prev = prevBatchRef.current;
      prevBatchRef.current = { complete: data.complete, hasItems };

      if (!prev) {
        if (hasItems && !data.complete && !runningRef.current) {
          setAutoStatus("Batch active — auto-starting bridge.");
          await callDiscord("start", { project_id: projectId }).catch(() => {});
          await load();
        }
        if (hasItems && data.complete && runningRef.current) {
          setAutoStatus("Batch complete — bridge paused. Waiting for next batch.");
          setActionError(null); // #522: clear stale action errors on auto-stop
          await callDiscord("stop", { project_id: projectId }).catch(() => {});
          await load();
        }
        return;
      }

      // Batch just completed → auto-stop
      if (hasItems && data.complete && !prev.complete && runningRef.current) {
        setAutoStatus("Batch complete — bridge paused. Waiting for next batch.");
        setActionError(null); // #522: clear stale action errors on auto-stop
        await callDiscord("stop", { project_id: projectId }).catch(() => {});
        await load();
        return;
      }

      // New batch started → auto-start
      if (hasItems && !data.complete && (prev.complete || !prev.hasItems) && !runningRef.current) {
        setAutoStatus("New batch detected — auto-starting bridge.");
        await callDiscord("start", { project_id: projectId }).catch(() => {});
        await load();
      }
    } catch { /* non-fatal */ }
  }, [projectId, load]);

  useEffect(() => {
    if (!autoDiscord) return;
    checkBatchLifecycle();
    const id = window.setInterval(checkBatchLifecycle, AUTO_POLL_MS);
    return () => window.clearInterval(id);
  }, [autoDiscord, checkBatchLifecycle]);

  const configured = !!status?.configured;
  const running = !!status?.running;
  useEffect(() => { runningRef.current = running; }, [running]);
  // #522: suppress last_error when bridge was auto-stopped
  const suppressLastError = !running && !!autoStatus;
  const displayError = actionError || pollError || (!running && !suppressLastError && status?.last_error) || "";

  return (
    <>
      <div className="flex flex-col border border-border">
        <div className="flex items-center justify-between h-7 px-3 shrink-0 border-b border-border">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-text-muted uppercase tracking-wider">Discord Bridge</span>
            <InfoTooltip>
              <b>Discord Bridge</b> forwards AgentChattr messages to a Discord channel so you can monitor from Discord. Bidirectional — replies from Discord appear in chat.
            </InfoTooltip>
          </div>
          <div className="flex items-center gap-1.5">
            {configured && (
              <button
                type="button"
                onClick={toggleAutoDiscord}
                title={autoDiscord ? "Auto ON — bridge follows batch lifecycle" : "Auto OFF — manual start/stop only"}
                className={`px-1.5 py-0.5 text-[10px] border transition-colors ${
                  autoDiscord
                    ? "border-accent/50 text-accent bg-accent/10 hover:bg-accent/20"
                    : "border-border text-text-muted hover:text-text hover:border-accent"
                }`}
              >
                Auto {autoDiscord ? "●" : "○"}
              </button>
            )}
            {displayError && (
              <span className="text-[10px] text-error">error</span>
            )}
          </div>
        </div>
        <div className="p-3 flex flex-col gap-2">
          {!configured ? (
            <>
              <div className="flex items-center gap-2 text-[11px] text-text-muted">
                <span className="w-1.5 h-1.5 rounded-full bg-text-muted" />
                <span>Not configured</span>
              </div>
              <button
                onClick={() => setSetupOpen(true)}
                disabled={busy}
                className="self-start px-3 py-1 text-[11px] font-semibold text-bg bg-accent hover:bg-accent-dim disabled:opacity-50 transition-colors"
              >
                Set up Discord Bridge
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-[11px] flex-wrap">
                {running ? (
                  <>
                    <span className="relative inline-flex items-center justify-center w-2 h-2">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 animate-ping" />
                      <span className="relative w-1.5 h-1.5 rounded-full bg-accent" />
                    </span>
                    <span className="text-accent">Running</span>
                  </>
                ) : (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-text-muted" />
                    <span className="text-text-muted">Stopped</span>
                  </>
                )}
                {status?.bot_username && (
                  <span className="text-text-muted">· Bot: {status.bot_username}</span>
                )}
                {status?.channel_id && (
                  <span className="text-text-muted tabular-nums">· Channel: {status.channel_id}</span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {running ? (
                  <button
                    onClick={stop}
                    disabled={busy}
                    className="px-3 py-1 text-[11px] text-text-muted border border-border hover:text-error hover:border-error/40 disabled:opacity-50 transition-colors"
                  >
                    {busy ? "Stopping\u2026" : "Stop"}
                  </button>
                ) : (
                  <button
                    onClick={start}
                    disabled={busy}
                    className="px-3 py-1 text-[11px] font-semibold text-bg bg-accent hover:bg-accent-dim disabled:opacity-50 transition-colors"
                  >
                    {busy ? "Starting\u2026" : "Start"}
                  </button>
                )}
                <button
                  onClick={() => setSetupOpen(true)}
                  disabled={busy}
                  className="px-3 py-1 text-[11px] text-text-muted border border-border hover:text-text disabled:opacity-50 transition-colors"
                >
                  How to set up
                </button>
                <button
                  onClick={() => setSetupOpen(true)}
                  disabled={busy}
                  className="px-3 py-1 text-[11px] text-text-muted border border-border hover:text-text disabled:opacity-50 transition-colors"
                >
                  Edit credentials
                </button>
              </div>
            </>
          )}
          {restartNotice && (
            <div className="mt-1 p-2 text-[10px] text-accent border border-accent/40 bg-accent/5 whitespace-pre-wrap break-words">
              {restartNotice}
              <button
                type="button"
                onClick={() => setRestartNotice(null)}
                className="block mt-1 text-text-muted hover:text-text underline"
              >
                dismiss
              </button>
            </div>
          )}
          {autoStatus && (
            <div className="mt-1 text-[10px] text-accent">
              {autoStatus}
            </div>
          )}
          {displayError && (
            <div className="mt-1 p-2 text-[10px] text-error border border-error/40 bg-error/5 font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
              {displayError}
              {actionError && (
                <button
                  type="button"
                  onClick={() => setActionError(null)}
                  className="block mt-1 text-text-muted hover:text-text underline"
                >
                  dismiss
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <DiscordSetupModal
        open={setupOpen}
        initialChannelId={status?.channel_id || ""}
        onClose={() => setSetupOpen(false)}
        onSave={onSaveCredentials}
      />
    </>
  );
}
