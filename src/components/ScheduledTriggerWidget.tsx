"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface ScheduledTriggerWidgetProps {
  projectId: string;
}

interface TriggerInfo {
  enabled: boolean;
  interval: number;  // ms
  lastSent: number | null;
  nextAt: number | null;
  expiresAt: number | null;
  message: string | null;
}

const DURATION_PRESETS = [
  { label: "1 hour", minutes: 60 },
  { label: "3 hours", minutes: 180 },
  { label: "8 hours", minutes: 480 },
  { label: "Until stopped", minutes: 0 },
];

function defaultMessage(projectId: string) {
  const queuePath = `~/.quadwork/${projectId}/OVERNIGHT-QUEUE.md`;
  return (
`@head @dev @reviewer1 @reviewer2 — Queue check.
@head: Merge any PR with both approvals, assign next from ${queuePath}.
@dev: Work on assigned ticket or address review feedback.
@reviewer1 & 2: Review open PRs. If @dev pushed fixes, re-review. Post verdict on PR AND notify @dev here.
ALL: Communicate via this chat by tagging agents. Your terminal is NOT visible.`
  );
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0m 0s";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

/**
 * Bottom-right operator widget for the Scheduled Trigger (#210).
 *
 * Combines the old Keep Alive timer with a custom message textarea.
 * "Send Message and Start Trigger" sends the typed message via the
 * existing /api/triggers/:id/start endpoint (which persists the
 * message on the project entry and immediately fires once), then
 * the backend's setInterval keeps firing at the configured cadence
 * until the duration expires or Stop is pressed.
 *
 * State is sourced from GET /api/triggers every 5s so reopening the
 * project picks up the last-used message + running status.
 */
export default function ScheduledTriggerWidget({ projectId }: ScheduledTriggerWidgetProps) {
  const [trigger, setTrigger] = useState<TriggerInfo | null>(null);
  const [message, setMessage] = useState<string>("");
  const [intervalMin, setIntervalMin] = useState<number>(15);
  const [durationMin, setDurationMin] = useState<number>(180);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState("");
  const [expiresCountdown, setExpiresCountdown] = useState("");
  const initialMessage = useMemo(() => defaultMessage(projectId), [projectId]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/triggers");
      if (!r.ok) throw new Error(`${r.status}`);
      const data: Record<string, TriggerInfo> = await r.json();
      const t = data[projectId] || null;
      setTrigger(t);
      if (t?.message && !message) setMessage(t.message);
      if (t?.interval) setIntervalMin(Math.max(1, Math.round(t.interval / 60000)));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  // Intentionally exclude `message` so user edits aren't clobbered mid-typing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Seed the textarea with the ticket's default once, until the first
  // poll returns a persisted message.
  useEffect(() => {
    if (!message) setMessage(initialMessage);
  }, [initialMessage, message]);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, [load]);

  // 1-Hz tick for the live countdown while running.
  useEffect(() => {
    if (!trigger?.enabled) { setCountdown(""); setExpiresCountdown(""); return; }
    const tick = () => {
      if (trigger.nextAt) setCountdown(formatCountdown(Math.max(0, trigger.nextAt - Date.now())));
      if (trigger.expiresAt) {
        const remaining = Math.max(0, trigger.expiresAt - Date.now());
        setExpiresCountdown(formatCountdown(remaining));
        if (remaining <= 0) load();
      } else {
        setExpiresCountdown("");
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [trigger?.enabled, trigger?.nextAt, trigger?.expiresAt, load]);

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/triggers/${encodeURIComponent(projectId)}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval: intervalMin, duration: durationMin, message, sendImmediately: true }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/triggers/${encodeURIComponent(projectId)}/stop`, { method: "POST" });
      if (!r.ok) throw new Error(`${r.status}`);
      setTrigger({ ...(trigger || { interval: 0, lastSent: null, nextAt: null, expiresAt: null, message }), enabled: false });
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const running = !!trigger?.enabled;

  return (
    <div className="flex flex-col border border-border">
      <div className="flex items-center justify-between h-7 px-3 shrink-0 border-b border-border">
        <span className="text-[11px] text-text-muted uppercase tracking-wider">
          Scheduled Trigger{running ? " (running)" : ""}
        </span>
        {error && <span className="text-[10px] text-error">err: {error}</span>}
      </div>

      {!running ? (
        <div className="p-3 flex flex-col gap-2">
          <label className="text-[10px] text-text-muted uppercase tracking-wider">Message</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={6}
            spellCheck={false}
            className="w-full bg-bg text-text text-[11px] font-mono p-2 border border-border outline-none focus:border-accent resize-y"
          />
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <span className="text-text-muted">Send every</span>
            <input
              type="number"
              value={intervalMin}
              onChange={(e) => setIntervalMin(parseInt(e.target.value, 10) || 15)}
              min={1}
              max={1440}
              className="w-12 bg-transparent border border-border px-1 py-0.5 text-[11px] text-text outline-none focus:border-accent text-center"
            />
            <span className="text-text-muted">min for</span>
            <select
              value={durationMin}
              onChange={(e) => setDurationMin(parseInt(e.target.value, 10))}
              className="bg-transparent border border-border px-1 py-0.5 text-[11px] text-text outline-none focus:border-accent cursor-pointer"
            >
              {DURATION_PRESETS.map((p) => (
                <option key={p.minutes} value={p.minutes} className="bg-bg-surface">{p.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={start}
            disabled={busy || !message.trim()}
            className="self-start px-3 py-1 text-[11px] font-semibold text-bg bg-accent hover:bg-accent-dim disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? "Starting…" : "Send Message and Start Trigger"}
          </button>
        </div>
      ) : (
        <div className="p-3 flex flex-col gap-2">
          <div className="text-[11px] text-text-muted">Sending:</div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap text-text bg-bg-surface border border-border p-2 max-h-28 overflow-auto">{(trigger?.message || message).slice(0, 400)}</pre>
          <div className="flex items-center gap-3 flex-wrap text-[11px]">
            <span className="flex items-center gap-1">
              <span className="relative inline-flex items-center justify-center w-2 h-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 animate-ping" />
                <span className="relative w-1.5 h-1.5 rounded-full bg-accent" />
              </span>
              <span className="text-accent">Running</span>
            </span>
            <span className="tabular-nums text-text">Next: {countdown}</span>
            {expiresCountdown && <span className="tabular-nums text-text-muted">Stops in: {expiresCountdown}</span>}
            {!trigger?.expiresAt && <span className="text-text-muted">(until stopped)</span>}
          </div>
          <button
            onClick={stop}
            disabled={busy}
            className="self-start px-3 py-1 text-[11px] text-text-muted border border-border hover:text-error hover:border-error/40 disabled:opacity-50 transition-colors"
          >
            {busy ? "Stopping…" : "Stop Trigger"}
          </button>
        </div>
      )}
    </div>
  );
}
