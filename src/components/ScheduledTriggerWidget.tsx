"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import { useLocale } from "@/components/LocaleProvider";

interface ScheduledTriggerWidgetProps {
  projectId: string;
}

// #408: batch progress shape from /api/batch-progress
interface BatchState {
  complete: boolean;
  items: { issue_number: number; status: string }[];
  batch_number: number | null;
}

// How often the auto-trigger polls batch progress (same as BatchProgressPanel).
const AUTO_TRIGGER_POLL_MS = 30_000;

interface TriggerInfo {
  enabled: boolean;
  interval: number;  // ms (active timer interval, 0 when idle-with-saved-state)
  lastSent: number | null;
  nextAt: number | null;
  expiresAt: number | null;
  message: string | null;
  intervalMin: number | null; // last-used, persisted for idle reloads
  durationMin: number | null; // last-used, persisted for idle reloads
}

// #406 / quadwork#269: trigger duration is now a free-typed numeric
// hours input. Defaults / bounds match the issue: default 3 hours,
// 0.1h min (≈6 minute test runs), 24h cap as a safety rail, decimals
// allowed at 0.1h granularity. The previous "Until stopped" preset
// is intentionally dropped — operators wanted finer control more
// than the unbounded option. The trigger backend still takes
// minutes; we convert hours → minutes on send.
const DURATION_HOURS_DEFAULT = 3;
const DURATION_HOURS_MIN = 0.1;
const DURATION_HOURS_MAX = 24;
function clampHours(h: number): number {
  if (!Number.isFinite(h)) return DURATION_HOURS_DEFAULT;
  return Math.min(Math.max(h, DURATION_HOURS_MIN), DURATION_HOURS_MAX);
}
function minutesToHoursStr(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return String(DURATION_HOURS_DEFAULT);
  const h = min / 60;
  // 1 decimal place is enough for the 0.1h step granularity, and
  // round-trips integer minutes that map to clean fractional hours
  // (e.g. 378 → "6.3").
  return (Math.round(h * 10) / 10).toString();
}

function defaultMessage(projectId: string) {
  const queuePath = `~/.quadwork/${projectId}/OVERNIGHT-QUEUE.md`;
  return (
`@head @dev @re1 @re2 — Queue check.
@head: Merge any PR with both approvals, assign next from ${queuePath}.
@dev: Work on assigned ticket or address review feedback.
@re1 & @re2: Review open PRs. If @dev pushed fixes, re-review. Post verdict on PR AND notify @dev here.
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
 * "Start Trigger" hands the typed message to
 * /api/triggers/:id/start which persists it on the project entry
 * and schedules a setInterval at the configured cadence. The first
 * message fires at T + interval (not on click — see #418/#306) and
 * the interval keeps firing until duration expires or Stop is
 * pressed.
 *
 * State is sourced from GET /api/triggers every 5s so reopening the
 * project picks up the last-used message + running status.
 */
export default function ScheduledTriggerWidget({ projectId }: ScheduledTriggerWidgetProps) {
  const { locale } = useLocale();
  const [trigger, setTrigger] = useState<TriggerInfo | null>(null);
  const [message, setMessage] = useState<string>("");
  const [intervalMin, setIntervalMin] = useState<number>(15);
  // #419 / quadwork#308: draft-string mirror of intervalMin so the
  // operator can clear the field and retype without the onChange
  // parseInt()-|| default clobbering the buffer mid-keystroke.
  // Same pattern as durationHoursDraft below.
  const [intervalDraft, setIntervalDraft] = useState<string>("15");
  const [durationMin, setDurationMin] = useState<number>(180);
  // #406 / quadwork#269: keep a separate raw string draft for the
  // hours input so the operator can type intermediate states like
  // "6." or "0" without the controlled input collapsing them back
  // (clamping on every keystroke makes "6.3" / "0.5" effectively
  // unenterable). The draft is committed to durationMin on blur and
  // again right before start(). Polls update the draft in lockstep
  // with durationMin so persisted values still load correctly.
  const [durationHoursDraft, setDurationHoursDraft] = useState<string>(() => minutesToHoursStr(180));
  // Track which controls the operator has touched so incoming polls
  // don't clobber mid-edit changes. The values are mirrored into
  // refs so the memoized `load()` closure always reads the latest
  // dirty flags + message without being re-created on every keystroke
  // (recreating `load` would re-run the polling effect and reset the
  // 5s interval).
  const [intervalDirty, setIntervalDirty] = useState(false);
  const [durationDirty, setDurationDirty] = useState(false);
  const messageRef = useRef<string>("");
  const intervalDirtyRef = useRef(false);
  const durationDirtyRef = useRef(false);
  useEffect(() => { messageRef.current = message; }, [message]);
  useEffect(() => { intervalDirtyRef.current = intervalDirty; }, [intervalDirty]);
  useEffect(() => { durationDirtyRef.current = durationDirty; }, [durationDirty]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState("");
  const [expiresCountdown, setExpiresCountdown] = useState("");
  const initialMessage = useMemo(() => defaultMessage(projectId), [projectId]);
  // #408: auto-trigger state
  const [autoTrigger, setAutoTrigger] = useState(false);
  const [autoTriggered, setAutoTriggered] = useState(false); // true when current run was auto-started
  const [autoStatus, setAutoStatus] = useState<string | null>(null); // flash message
  const prevBatchRef = useRef<{ complete: boolean; hasItems: boolean } | null>(null);

  // #408: load auto-trigger setting from project config on mount.
  // Reset refs on projectId change to avoid stale state across projects.
  const autoTriggerLoadedRef = useRef(false);
  useEffect(() => {
    autoTriggerLoadedRef.current = false;
    prevBatchRef.current = null;
    setAutoTrigger(false);
    setAutoTriggered(false);
    setAutoStatus(null);
  }, [projectId]);
  useEffect(() => {
    if (autoTriggerLoadedRef.current) return;
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg) return;
        const entry = (cfg.projects || []).find((p: { id: string }) => p.id === projectId);
        if (entry?.trigger_auto) {
          setAutoTrigger(true);
        }
        autoTriggerLoadedRef.current = true;
      })
      .catch(() => {});
  }, [projectId]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/triggers");
      if (!r.ok) throw new Error(`${r.status}`);
      const data: Record<string, TriggerInfo> = await r.json();
      const t = data[projectId] || null;
      setTrigger(t);
      if (t) {
        // Read dirty flags + current message from refs, NOT from the
        // closure — `load` is memoized on `projectId` alone so the
        // polling effect can keep a stable 5s cadence. Without the
        // refs, a later poll would still see the initial empty
        // message / clean flags and overwrite mid-edit changes.
        if (t.message && !messageRef.current) {
          setMessage(t.message);
          messageRef.current = t.message;
        }
        if (!intervalDirtyRef.current) {
          if (t.enabled && t.interval) {
            const mins = Math.max(1, Math.round(t.interval / 60000));
            setIntervalMin(mins);
            setIntervalDraft(String(mins));
          } else if (typeof t.intervalMin === "number" && t.intervalMin > 0) {
            setIntervalMin(t.intervalMin);
            setIntervalDraft(String(t.intervalMin));
          }
        }
        if (!durationDirtyRef.current && typeof t.durationMin === "number" && t.durationMin >= 0) {
          setDurationMin(t.durationMin);
          setDurationHoursDraft(minutesToHoursStr(t.durationMin));
        }
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
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
    // #406 / quadwork#269: commit the draft hours value before
    // POSTing in case the user clicks Send without ever blurring
    // the input. We compute the resolved minutes locally and pass
    // them in the body — relying on a setDurationMin() before fetch
    // would race the React render cycle.
    const draftRaw = parseFloat(durationHoursDraft);
    const resolvedHours = Number.isFinite(draftRaw) ? clampHours(draftRaw) : DURATION_HOURS_DEFAULT;
    const resolvedDurationMin = Math.round(resolvedHours * 60);
    if (resolvedDurationMin !== durationMin) {
      setDurationMin(resolvedDurationMin);
      setDurationHoursDraft(minutesToHoursStr(resolvedDurationMin));
    }
    // #419 / quadwork#308: same draft-commit treatment for the
    // interval input. If the operator clears the field and hits
    // Start without blurring, we must still POST a valid number.
    const intervalRaw = parseInt(intervalDraft, 10);
    const resolvedIntervalMin = Number.isFinite(intervalRaw)
      ? Math.max(1, Math.min(1440, intervalRaw))
      : 15;
    if (resolvedIntervalMin !== intervalMin) {
      setIntervalMin(resolvedIntervalMin);
      setIntervalDraft(String(resolvedIntervalMin));
    }
    try {
      const r = await fetch(`/api/triggers/${encodeURIComponent(projectId)}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval: resolvedIntervalMin, duration: resolvedDurationMin, message }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      // After the backend persists the new values, treat them as the
      // baseline — subsequent polls should be free to re-hydrate from
      // server state again.
      setIntervalDirty(false);
      setDurationDirty(false);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/triggers/${encodeURIComponent(projectId)}/stop`, { method: "POST" });
      if (!r.ok) throw new Error(`${r.status}`);
      setAutoTriggered(false);
      setTrigger({
        ...(trigger || {
          interval: 0,
          lastSent: null,
          nextAt: null,
          expiresAt: null,
          message,
          intervalMin,
          durationMin,
        }),
        enabled: false,
      });
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  // #408: persist auto-trigger toggle to project config
  const toggleAutoTrigger = useCallback(async () => {
    const next = !autoTrigger;
    setAutoTrigger(next);
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
        entry.trigger_auto = next;
        await fetch("/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cfg),
        });
      }
    } catch { /* non-fatal */ }
  }, [autoTrigger, projectId]);

  // #408: auto-trigger batch lifecycle polling.
  // When autoTrigger is ON, polls /api/batch-progress every 30s to
  // detect batch start/complete transitions.
  const autoTriggerRef = useRef(autoTrigger);
  const triggerRef = useRef(trigger);
  useEffect(() => { autoTriggerRef.current = autoTrigger; }, [autoTrigger]);
  useEffect(() => { triggerRef.current = trigger; }, [trigger]);

  const checkBatchLifecycle = useCallback(async () => {
    if (!autoTriggerRef.current) return;
    try {
      const r = await fetch(`/api/batch-progress?project=${encodeURIComponent(projectId)}`);
      if (!r.ok) return;
      const data: BatchState = await r.json();
      const hasItems = data.items.length > 0;
      const prev = prevBatchRef.current;
      prevBatchRef.current = { complete: data.complete, hasItems };

      if (!prev) {
        // First poll — if there's an active non-complete batch, auto-start
        if (hasItems && !data.complete && !triggerRef.current?.enabled) {
          setAutoTriggered(true);
          setAutoStatus(null);
          // Use the start endpoint directly with current field values
          const draftRaw = parseFloat(durationHoursDraft);
          const resolvedHours = Number.isFinite(draftRaw) ? clampHours(draftRaw) : DURATION_HOURS_DEFAULT;
          const resolvedDurationMin = Math.round(resolvedHours * 60);
          const intervalRaw = parseInt(intervalDraft, 10);
          const resolvedIntervalMin = Number.isFinite(intervalRaw) ? Math.max(1, Math.min(1440, intervalRaw)) : 15;
          await fetch(`/api/triggers/${encodeURIComponent(projectId)}/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ interval: resolvedIntervalMin, duration: resolvedDurationMin, message: messageRef.current || initialMessage }),
          });
          await load();
        }
        // #462: First poll — batch already complete but trigger still running → auto-stop
        if (hasItems && data.complete && triggerRef.current?.enabled) {
          await fetch(`/api/triggers/${encodeURIComponent(projectId)}/stop`, { method: "POST" });
          setAutoTriggered(false);
          setAutoStatus("Batch complete — trigger paused. Waiting for next batch.");
          await load();
        }
        return;
      }

      // Batch just completed → auto-stop
      if (hasItems && data.complete && !prev.complete && triggerRef.current?.enabled) {
        await fetch(`/api/triggers/${encodeURIComponent(projectId)}/stop`, { method: "POST" });
        setAutoTriggered(false);
        setAutoStatus("Batch complete — trigger paused. Waiting for next batch.");
        await load();
        return;
      }

      // New batch started (complete→active, or empty→active) → auto-start
      if (hasItems && !data.complete && (prev.complete || !prev.hasItems) && !triggerRef.current?.enabled) {
        setAutoTriggered(true);
        setAutoStatus(null);
        const draftRaw = parseFloat(durationHoursDraft);
        const resolvedHours = Number.isFinite(draftRaw) ? clampHours(draftRaw) : DURATION_HOURS_DEFAULT;
        const resolvedDurationMin = Math.round(resolvedHours * 60);
        const intervalRaw = parseInt(intervalDraft, 10);
        const resolvedIntervalMin = Number.isFinite(intervalRaw) ? Math.max(1, Math.min(1440, intervalRaw)) : 15;
        await fetch(`/api/triggers/${encodeURIComponent(projectId)}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interval: resolvedIntervalMin, duration: resolvedDurationMin, message: messageRef.current || initialMessage }),
        });
        await load();
      }
    } catch { /* non-fatal */ }
  }, [projectId, durationHoursDraft, intervalDraft, initialMessage, load]);

  useEffect(() => {
    if (!autoTrigger) return;
    checkBatchLifecycle();
    const id = window.setInterval(checkBatchLifecycle, AUTO_TRIGGER_POLL_MS);
    return () => window.clearInterval(id);
  }, [autoTrigger, checkBatchLifecycle]);

  const running = !!trigger?.enabled;

  return (
    <div className="flex flex-col border border-border">
      <div className="flex items-center justify-between h-7 px-3 shrink-0 border-b border-border">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-text-muted uppercase tracking-wider">
            {locale === "ko"
              ? `예약 트리거${running ? (autoTriggered ? " (자동)" : " (실행 중)") : ""}`
              : `Scheduled Trigger${running ? (autoTriggered ? " (auto)" : " (running)") : ""}`}
          </span>
          <InfoTooltip>
            {locale === "ko"
              ? <><b>예약 트리거</b> - 타이머에 따라 모든 에이전트에게 주기적으로 메시지를 보냅니다. 야간 자율 워크플로우를 계속 돌릴 때 사용하세요. 첫 메시지는 즉시가 아니라 설정한 간격 후에 전송됩니다.</>
              : <><b>Scheduled Trigger</b> sends a periodic message to all agents on a timer. Use this to keep the autonomous workflow running overnight. First message fires after the configured interval, not immediately.</>}
          </InfoTooltip>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-[10px] text-error">err: {error}</span>}
          {/* #408: Auto-Trigger toggle */}
          <button
            type="button"
            onClick={toggleAutoTrigger}
            title={autoTrigger
              ? (locale === "ko" ? "자동 트리거 ON - 배치 생명주기에 따라 트리거가 동작합니다" : "Auto-trigger ON — trigger follows batch lifecycle")
              : (locale === "ko" ? "자동 트리거 OFF - 수동 시작/중지만 가능합니다" : "Auto-trigger OFF — manual start/stop only")}
            className={`px-1.5 py-0.5 text-[10px] border transition-colors ${
              autoTrigger
                ? "border-accent/50 text-accent bg-accent/10 hover:bg-accent/20"
                : "border-border text-text-muted hover:text-text hover:border-accent"
            }`}
          >
            {locale === "ko" ? "자동 " : "Auto "}{autoTrigger ? "●" : "○"}
          </button>
        </div>
      </div>
      {/* #408: auto-trigger status flash */}
      {autoStatus && (
        <div className="px-3 py-1 text-[10px] text-accent bg-accent/5 border-b border-border/50">
          {autoStatus}
        </div>
      )}

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
              value={intervalDraft}
              onChange={(e) => { setIntervalDraft(e.target.value); setIntervalDirty(true); }}
              onBlur={() => {
                const raw = parseInt(intervalDraft, 10);
                const clamped = Number.isFinite(raw) ? Math.max(1, Math.min(1440, raw)) : 15;
                setIntervalMin(clamped);
                setIntervalDraft(String(clamped));
              }}
              min={1}
              max={1440}
              className="w-12 bg-transparent border border-border px-1 py-0.5 text-[11px] text-text outline-none focus:border-accent text-center"
            />
            <span className="text-text-muted">min for</span>
            {/* #406 / quadwork#269: free-typed hours input. The
                draft string is committed to durationMin on blur so
                intermediate states like "6." or "0" remain typeable
                without instant clamp. start() also commits before
                POSTing in case the user clicks Send without blurring. */}
            <input
              type="number"
              value={durationHoursDraft}
              onChange={(e) => {
                setDurationHoursDraft(e.target.value);
                setDurationDirty(true);
              }}
              onBlur={() => {
                const raw = parseFloat(durationHoursDraft);
                const hours = Number.isFinite(raw) ? clampHours(raw) : DURATION_HOURS_DEFAULT;
                const mins = Math.round(hours * 60);
                setDurationMin(mins);
                setDurationHoursDraft(minutesToHoursStr(mins));
              }}
              min={DURATION_HOURS_MIN}
              max={DURATION_HOURS_MAX}
              step={0.1}
              className="w-14 bg-transparent border border-border px-1 py-0.5 text-[11px] text-text outline-none focus:border-accent text-center"
            />
            <span className="text-text-muted">hours</span>
          </div>
          <button
            onClick={start}
            disabled={busy || !message.trim()}
            className="self-start px-3 py-1 text-[11px] font-semibold text-bg bg-accent hover:bg-accent-dim disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? "Starting…" : "Start Trigger"}
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
