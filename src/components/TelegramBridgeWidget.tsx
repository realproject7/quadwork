"use client";

import { useCallback, useEffect, useState } from "react";
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
  const [error, setError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/telegram?project=${encodeURIComponent(projectId)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      const data = (await r.json()) as TelegramStatus;
      setStatus(data);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, [load]);

  const start = async () => {
    setBusy(true); setError(null);
    try {
      // The first-time path clones + pip-installs the bridge before
      // spawning it. "install" is a no-op if it's already installed.
      if (status && !status.bridge_installed) {
        await callTelegram("install", {});
      }
      await callTelegram("start", { project_id: projectId });
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true); setError(null);
    try {
      await callTelegram("stop", { project_id: projectId });
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const onSaveCredentials = async (bot_token: string, chat_id: string) => {
    await callTelegram("save-config", { project_id: projectId, bot_token, chat_id });
    // After saving, try to start immediately — matches the
    // "Save and start bridge" affordance in the modal.
    try {
      if (status && !status.bridge_installed) await callTelegram("install", {});
      await callTelegram("start", { project_id: projectId });
    } catch (e) {
      // Leave the save persisted even if start fails; the operator
      // can retry from the widget.
      setError((e as Error).message);
    }
    await load();
  };

  const configured = !!status?.configured;
  const running = !!status?.running;

  return (
    <>
      <div className="flex flex-col border border-border">
        <div className="flex items-center justify-between h-7 px-3 shrink-0 border-b border-border">
          <span className="text-[11px] text-text-muted uppercase tracking-wider">Telegram Bridge</span>
          {(error || (!status?.running && status?.last_error)) && (
            <span
              className="text-[10px] text-error max-w-[60%] truncate"
              title={error || status?.last_error || ""}
            >
              err: {error || status?.last_error}
            </span>
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
