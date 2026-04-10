"use client";

import { useCallback, useEffect, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import TelegramSetupModal from "./TelegramSetupModal";

interface TelegramBridgeWidgetProps {
  projectId: string;
}

interface TelegramStatus {
  running: boolean;
  configured: boolean;
  chat_id: string;
  bot_username: string;
  bridge_installed: boolean;
  // #353: tail of ~/.quadwork/telegram-bridge-<projectId>.log
  // populated by the server when running === false and the log
  // file has content, so runtime crashes after a successful
  // Start are still visible in the widget.
  last_error?: string;
}

async function callTelegram(action: string, body: Record<string, unknown>) {
  const r = await fetch(`/api/telegram?action=${encodeURIComponent(action)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok || data.ok === false) throw new Error(data.error || `${r.status}`);
  return data;
}

/**
 * Per-project Telegram Bridge widget (#211).
 *
 * Lives in the bottom-right Operator Features quadrant. Shows
 * whether the bridge is running + chat id, and gives the operator
 * start/stop + a setup modal to configure bot_token + chat_id from
 * scratch.
 */
export default function TelegramBridgeWidget({ projectId }: TelegramBridgeWidgetProps) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // #372: split error state — actionError is set by the operator's
  // Start/Stop click and must persist across polling cycles so a
  // failed start doesn't silently disappear after the next 5s
  // poll. pollError is set only by the background status fetch and
  // gets cleared on a successful poll.
  const [actionError, setActionError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  // #383: the Install Bridge handler now migrates every existing
  // per-project AC `config.toml` to declare `[agents.telegram-bridge]`
  // (required so AC's registry accepts the bridge's register call).
  // When that migration actually touches any configs, the operator
  // must click SERVER → Restart for AC to load the new agent slug;
  // otherwise Start immediately afterwards will still fail with a
  // 400 registration loop. Surface that prompt here instead of
  // silently returning "Installed".
  const [restartNotice, setRestartNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/telegram?project=${encodeURIComponent(projectId)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      const data = (await r.json()) as TelegramStatus;
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
        `(${patched.join(", ")}) to declare [agents.telegram-bridge]. ` +
        `Click SERVER → Restart so AgentChattr picks up the new agent slug, ` +
        `then click Start again. Without the restart, Start will fail with a 400 registration loop.`,
      );
    } else {
      setRestartNotice(null);
    }
  };

  const start = async () => {
    setBusy(true); setActionError(null);
    try {
      // The first-time path clones + pip-installs the bridge before
      // spawning it. "install" is a no-op if it's already installed.
      if (status && !status.bridge_installed) {
        const data = await callTelegram("install", {});
        noteInstallResponse(data);
      }
      await callTelegram("start", { project_id: projectId });
      await load();
    } catch (e) { setActionError((e as Error).message); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true); setActionError(null);
    try {
      await callTelegram("stop", { project_id: projectId });
      await load();
    } catch (e) { setActionError((e as Error).message); }
    finally { setBusy(false); }
  };

  const onSaveCredentials = async (bot_token: string, chat_id: string) => {
    await callTelegram("save-config", { project_id: projectId, bot_token, chat_id });
    // After saving, try to start immediately — matches the
    // "Save and start bridge" affordance in the modal.
    try {
      if (status && !status.bridge_installed) {
        const data = await callTelegram("install", {});
        noteInstallResponse(data);
      }
      await callTelegram("start", { project_id: projectId });
    } catch (e) {
      // Leave the save persisted even if start fails; the operator
      // can retry from the widget.
      setActionError((e as Error).message);
    }
    await load();
  };

  const configured = !!status?.configured;
  const running = !!status?.running;
  // #372: show, in preference order, the most recent actionable
  // error: the operator's last Start/Stop failure, then a poll
  // failure, then the server-side log tail from a crashed bridge.
  // Rendered as a dedicated multi-line block below the controls
  // (not a truncated span in the header) so long Python tracebacks
  // from dep-check / spawn failures are actually readable.
  const displayError = actionError || pollError || (!running && status?.last_error) || "";

  return (
    <>
      <div className="flex flex-col border border-border">
        <div className="flex items-center justify-between h-7 px-3 shrink-0 border-b border-border">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-text-muted uppercase tracking-wider">Telegram Bridge</span>
            <InfoTooltip>
              <b>Telegram Bridge</b> forwards AgentChattr messages to a Telegram bot so you can monitor from your phone. Bidirectional — replies from Telegram appear in chat.
            </InfoTooltip>
          </div>
          {displayError && (
            <span className="text-[10px] text-error">error</span>
          )}
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
                Set up Telegram Bridge
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
                  <span className="text-text-muted">· Bot: @{status.bot_username}</span>
                )}
                {status?.chat_id && (
                  <span className="text-text-muted tabular-nums">· Chat: {status.chat_id}</span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {running ? (
                  <button
                    onClick={stop}
                    disabled={busy}
                    className="px-3 py-1 text-[11px] text-text-muted border border-border hover:text-error hover:border-error/40 disabled:opacity-50 transition-colors"
                  >
                    {busy ? "Stopping…" : "Stop"}
                  </button>
                ) : (
                  <button
                    onClick={start}
                    disabled={busy}
                    className="px-3 py-1 text-[11px] font-semibold text-bg bg-accent hover:bg-accent-dim disabled:opacity-50 transition-colors"
                  >
                    {busy ? "Starting…" : "Start"}
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
      <TelegramSetupModal
        open={setupOpen}
        initialChatId={status?.chat_id || ""}
        onClose={() => setSetupOpen(false)}
        onSave={onSaveCredentials}
      />
    </>
  );
}
