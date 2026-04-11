"use client";

import { useState, useEffect, useCallback } from "react";
import {
  NOTIFICATION_SOUND_OPTIONS,
  type NotificationSoundChoice,
  getNotificationEnabled,
  setNotificationEnabled,
  getNotificationChoice,
  setNotificationChoice,
  getNotificationBackgroundOnly,
  setNotificationBackgroundOnly,
} from "../lib/notificationSound";

// ─── Server Controls ─────────────────────────────────────────────────────────

function ServerSection({ projectId }: { projectId: string }) {
  const [loading, setLoading] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  // #416: AC health monitor status — poll every 30s to surface
  // auto-restart events and persistent errors in the dashboard.
  const [healthNote, setHealthNote] = useState<string | null>(null);

  useEffect(() => {
    const pollHealth = () => {
      fetch(`/api/agentchattr/${encodeURIComponent(projectId)}/health`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) { setHealthNote(null); return; }
          if (d.autoRestart?.gaveUp) {
            setHealthNote("AC auto-restart failed 3x — manual restart required");
          } else if (d.autoRestart?.lastRestart) {
            const ago = Math.round((Date.now() - d.autoRestart.lastRestart) / 1000);
            if (ago < 300) {
              const time = new Date(d.autoRestart.lastRestart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
              setHealthNote(`AC auto-restarted at ${time}`);
            } else {
              setHealthNote(null);
            }
          } else {
            setHealthNote(null);
          }
        })
        .catch(() => setHealthNote(null));
    };
    pollHealth();
    const interval = setInterval(pollHealth, 30000);
    return () => clearInterval(interval);
  }, [projectId]);

  const clearFeedback = () => {
    setTimeout(() => setFeedback(null), 3000);
  };

  // Auto-reset confirmation after 4s if user doesn't follow through
  useEffect(() => {
    if (!confirmStop) return;
    const timer = setTimeout(() => setConfirmStop(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmStop]);

  const handleStop = async () => {
    if (!confirmStop) {
      setConfirmStop(true);
      return;
    }
    setConfirmStop(false);
    setLoading("stop");
    try {
      const r = await fetch(
        `/api/agentchattr/${encodeURIComponent(projectId)}/stop`,
        { method: "POST" }
      );
      const d = await r.json();
      setFeedback(d.ok ? "Stopped" : "Failed");
    } catch {
      setFeedback("Error");
    }
    setLoading(null);
    clearFeedback();
  };

  const handleRestart = async () => {
    setLoading("restart");
    try {
      const r = await fetch(
        `/api/agentchattr/${encodeURIComponent(projectId)}/restart`,
        { method: "POST" }
      );
      const d = await r.json();
      if (d.ok && d.pid) {
        setFeedback(`AC restarted (PID: ${d.pid}) — resetting agents...`);
        // #417: After AC restart, also reset all agents so they get
        // fresh MCP tokens. Without this, agents stay stuck with stale
        // connections from the pre-restart session.
        try {
          const resetRes = await fetch(
            `/api/agents/${encodeURIComponent(projectId)}/reset`,
            { method: "POST" }
          );
          const resetData = await resetRes.json();
          if (resetData.ok) {
            setFeedback(`AC + ${resetData.restarted} agent${resetData.restarted !== 1 ? "s" : ""} restarted`);
          } else {
            setFeedback(`AC restarted — agent reset failed`);
          }
        } catch {
          setFeedback(`AC restarted — agent reset failed`);
        }
      } else {
        setFeedback(d.error || "Failed to restart");
      }
    } catch {
      setFeedback("Error");
    }
    setLoading(null);
    clearFeedback();
  };

  const handleReset = async () => {
    setLoading("reset");
    try {
      const r = await fetch(
        `/api/agents/${encodeURIComponent(projectId)}/reset`,
        { method: "POST" }
      );
      const d = await r.json();
      setFeedback(
        d.ok ? `Reset — ${d.restarted} of ${d.total} agent${d.total !== 1 ? "s" : ""} restarted` : (d.error || "Failed")
      );
    } catch {
      setFeedback("Error");
    }
    setLoading(null);
    clearFeedback();
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">
        Server
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={handleStop}
          disabled={!!loading}
          className={`px-1.5 py-0.5 text-[10px] border transition-colors disabled:opacity-50 ${
            confirmStop
              ? "text-error border-error/60 bg-error/10 hover:bg-error/20"
              : "text-text-muted border-border hover:text-error hover:border-error/40"
          }`}
        >
          {loading === "stop" ? "..." : confirmStop ? "Confirm Stop?" : "Stop"}
        </button>
        <button
          onClick={handleRestart}
          disabled={!!loading}
          className="px-1.5 py-0.5 text-[10px] text-text-muted border border-border hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-50"
        >
          {loading === "restart" ? "..." : "Restart"}
        </button>
        <button
          onClick={handleReset}
          disabled={!!loading}
          className="px-1.5 py-0.5 text-[10px] text-text-muted border border-border hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-50"
        >
          {loading === "reset" ? "..." : "Reset Agents"}
        </button>
      </div>
      {feedback && (
        <div className="text-[10px] text-accent">{feedback}</div>
      )}
      {healthNote && !feedback && (
        <div className={`text-[10px] ${healthNote.includes("failed") ? "text-error" : "text-[#ffcc00]"}`}>
          {healthNote}
        </div>
      )}
    </div>
  );
}

// ─── System (Caffeinate) ─────────────────────────────────────────────────────

// #407 / quadwork#270: free-typed hours input replaces the fixed
// preset list. Same default/min/max/step pattern as the Scheduled
// Trigger custom-hours fix in #406. The "Until stopped" option is
// preserved here (issue requires it) as a separate checkbox.
const KEEP_AWAKE_HOURS_DEFAULT = 3;
const KEEP_AWAKE_HOURS_MIN = 0.1;
const KEEP_AWAKE_HOURS_MAX = 24;
function clampKeepAwakeHours(h: number): number {
  if (!Number.isFinite(h)) return KEEP_AWAKE_HOURS_DEFAULT;
  return Math.min(Math.max(h, KEEP_AWAKE_HOURS_MIN), KEEP_AWAKE_HOURS_MAX);
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function SystemSection() {
  const [active, setActive] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [platform, setPlatform] = useState<string>("");
  const [showPresets, setShowPresets] = useState(false);
  // #407 / quadwork#270: free-typed hours draft + "Until stopped"
  // override. Same draft-string pattern as #406 so decimals stay
  // typeable.
  const [hoursDraft, setHoursDraft] = useState<string>(String(KEEP_AWAKE_HOURS_DEFAULT));
  const [untilStopped, setUntilStopped] = useState<boolean>(false);
  const [showHelp, setShowHelp] = useState(false);
  // #425 / quadwork#311: per-subsection header-level help popovers.
  // These replace the old `?` that lived inside the Keep Awake
  // presets popup (which disappeared while Awake was active) and
  // satisfy the ticket's "each subsection has its own (?) tooltip
  // with deeper detail" requirement for Notification Sound too.
  const [showKeepAwakeHelp, setShowKeepAwakeHelp] = useState(false);
  const [showSoundHelp, setShowSoundHelp] = useState(false);
  // #409 / quadwork#273: notification sound prefs. Hydrated from
  // localStorage on first render so the toggle/dropdown reflect the
  // value the chat panel is reading.
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(true);
  const [soundChoice, setSoundChoiceState] = useState<NotificationSoundChoice>("soft-chime");
  const [soundBgOnly, setSoundBgOnlyState] = useState<boolean>(true);
  useEffect(() => {
    setSoundEnabledState(getNotificationEnabled());
    setSoundChoiceState(getNotificationChoice());
    setSoundBgOnlyState(getNotificationBackgroundOnly());
  }, []);
  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabledState(next);
    setNotificationEnabled(next);
  };
  const updateChoice = (v: NotificationSoundChoice) => {
    setSoundChoiceState(v);
    setNotificationChoice(v);
    // Quick preview so the operator hears what they picked.
    if (soundEnabled) {
      try {
        const audio = new Audio(`/sounds/${v}.mp3`);
        audio.volume = 0.6;
        void audio.play().catch(() => {});
      } catch {}
    }
  };
  const toggleBgOnly = (v: boolean) => {
    setSoundBgOnlyState(v);
    setNotificationBackgroundOnly(v);
  };

  const poll = useCallback(() => {
    fetch("/api/caffeinate/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setActive(data.active);
        setRemaining(data.remaining);
        setPlatform(data.platform);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [poll]);

  const start = (seconds: number) => {
    fetch("/api/caffeinate/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration: seconds }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setActive(true);
          setRemaining(seconds || null);
        }
      })
      .catch(() => {});
    setShowPresets(false);
  };

  const stop = () => {
    fetch("/api/caffeinate/stop", { method: "POST" })
      .then(() => {
        setActive(false);
        setRemaining(null);
      })
      .catch(() => {});
  };

  // #425 / quadwork#311: Keep Awake is now a standalone subsection
  // and renders even on non-darwin (the button just hides). The
  // Notification Sound subsection sits below a small divider so the
  // two controls no longer look like they share a feature.

  const showKeepAwakeSubsection = !platform || platform === "darwin";

  return (
    // #369: Keep Awake + Notification Sound now sit side-by-side at
    // md+ widths so ControlBar can present three real columns
    // (Server | Keep Mac Awake | Notification Sound) separated by
    // vertical dividers, instead of the stacked-row layout PR #345
    // landed. Below md the layout collapses back to stacked rows so
    // narrow split-views still fit. Keep Awake hides entirely on
    // non-darwin and Notification Sound takes the full subsection
    // width on its own.
    <div className="flex flex-col md:flex-row md:items-start gap-2 md:gap-6 relative">
      {showKeepAwakeSubsection && (
        <div className="flex flex-col gap-0.5 relative">
          <div className="flex items-center gap-1 text-[10px] text-text-muted uppercase tracking-wider font-semibold">
            <span>Keep Mac Awake</span>
            <button
              type="button"
              aria-label="About Keep Mac Awake"
              onClick={() => setShowKeepAwakeHelp((s) => !s)}
              className="w-3.5 h-3.5 rounded-full border border-border text-[9px] leading-none text-text-muted hover:text-accent hover:border-accent inline-flex items-center justify-center"
            >?</button>
          </div>
          {showKeepAwakeHelp && (
            <div className="absolute left-0 top-4 z-30 w-64 p-2 text-[10px] leading-snug text-text bg-bg-surface border border-border rounded shadow-lg">
              <b>Keep Mac Awake</b> runs macOS <code>caffeinate</code> to stop the screen, disk, and system idle timers from sleeping your Mac during an overnight run. Make sure the laptop is plugged in — caffeinate blocks sleep but not battery drain.
            </div>
          )}
          <div className="text-[10px] text-text-muted leading-tight">
            {active && remaining !== null && remaining > 0
              ? `Awake for ${formatTime(remaining)} more — keep Mac plugged in`
              : active && remaining === null
                ? "Awake indefinitely — keep Mac plugged in"
                : "Prevents your Mac from sleeping during overnight runs."}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
            <button
              onClick={() => (active ? stop() : setShowPresets(!showPresets))}
              title="Keep Mac awake (caffeinate)"
              className={`px-1.5 py-0.5 text-[10px] border transition-colors ${
                active
                  ? "border-accent/50 text-accent bg-accent/10 hover:bg-accent/20"
                  : "border-border text-text-muted hover:text-text hover:border-accent"
              }`}
            >
              {active ? "Awake" : "Start"}
              {active && remaining !== null && remaining > 0 && (
                <span className="ml-1 text-accent/70">{formatTime(remaining)}</span>
              )}
              {active && remaining === null && (
                <span className="ml-1 text-accent/70">on</span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* #369: vertical divider between Keep Awake and Notification
          Sound at md+; horizontal divider in the stacked fallback so
          the two subsections still read as distinct on narrow widths. */}
      {showKeepAwakeSubsection && (
        <div className="border-t border-border/40 md:border-t-0 md:w-px md:h-auto md:self-stretch md:bg-border" />
      )}

      {/* #409 / quadwork#273 + #425 / quadwork#311: notification sound
          is now its own subsection with an always-visible descriptor. */}
      <div className="flex flex-col gap-0.5 relative">
        <div className="flex items-center gap-1 text-[10px] text-text-muted uppercase tracking-wider font-semibold">
          <span>Notification Sound</span>
          <button
            type="button"
            aria-label="About Notification Sound"
            onClick={() => setShowSoundHelp((s) => !s)}
            className="w-3.5 h-3.5 rounded-full border border-border text-[9px] leading-none text-text-muted hover:text-accent hover:border-accent inline-flex items-center justify-center"
          >?</button>
        </div>
        {showSoundHelp && (
          <div className="absolute left-0 top-4 z-30 w-64 p-2 text-[10px] leading-snug text-text bg-bg-surface border border-border rounded shadow-lg">
            <b>Notification Sound</b> plays a brief chime when an agent posts a new message (not your own sends, not system events). Sound choice picks one of the bundled chimes. Background-only mode suppresses the chime while the tab is focused — ding only when you&apos;re looking elsewhere. All prefs persist in localStorage.
          </div>
        )}
        <div className="text-[10px] text-text-muted leading-tight">
          Plays a chime when an agent posts a new message.
        </div>
        <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
          <button
            type="button"
            onClick={toggleSound}
            title={soundEnabled ? "Notification sound on (click to mute)" : "Notification sound off (click to unmute)"}
            className={`px-1.5 py-0.5 text-[10px] border transition-colors ${
              soundEnabled
                ? "border-accent/50 text-accent bg-accent/10 hover:bg-accent/20"
                : "border-border text-text-muted hover:text-text hover:border-accent"
            }`}
          >
            {soundEnabled ? "🔔" : "🔕"} Sound
          </button>
          {soundEnabled && (
            <select
              value={soundChoice}
              onChange={(e) => updateChoice(e.target.value as NotificationSoundChoice)}
              title="Notification sound"
              className="bg-transparent border border-border px-1 py-0.5 text-[10px] text-text outline-none focus:border-accent cursor-pointer"
            >
              {NOTIFICATION_SOUND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} className="bg-bg-surface">{o.label}</option>
              ))}
            </select>
          )}
        </div>
        {soundEnabled && (
          <label className="flex items-center gap-1 text-[10px] text-text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={soundBgOnly}
              onChange={(e) => toggleBgOnly(e.target.checked)}
            />
            Only when tab is in background
          </label>
        )}
      </div>

      {showPresets && !active && (
        <div className="absolute bottom-full left-0 mb-1 p-2 border border-border bg-bg-surface z-20 min-w-[220px] flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-text-muted uppercase tracking-wider">Keep Awake</span>
            <button
              type="button"
              aria-label="About Keep Awake"
              onClick={() => setShowHelp((s) => !s)}
              className="w-3.5 h-3.5 rounded-full border border-border text-[9px] leading-none text-text-muted hover:text-accent hover:border-accent inline-flex items-center justify-center"
            >?</button>
          </div>
          {showHelp && (
            <div className="p-1.5 text-[10px] leading-snug text-text bg-bg border border-border/60 rounded">
              <b>Keep Awake</b> prevents your Mac from sleeping for the duration you set. Use this when you want agents to keep working overnight.
              <br /><br />
              Under the hood, this runs macOS&apos;s <code>caffeinate</code> command. While it&apos;s active your screen, disk, and system idle timers are all paused — make sure your Mac is <b>plugged in</b> to avoid draining the battery.
            </div>
          )}
          <p className="text-[10px] text-[#ffcc00]">
            Make sure Mac is plugged in
          </p>
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-text-muted">for</span>
            <input
              type="number"
              value={hoursDraft}
              onChange={(e) => setHoursDraft(e.target.value)}
              onBlur={() => {
                const raw = parseFloat(hoursDraft);
                const hours = Number.isFinite(raw) ? clampKeepAwakeHours(raw) : KEEP_AWAKE_HOURS_DEFAULT;
                setHoursDraft(String(Math.round(hours * 10) / 10));
              }}
              disabled={untilStopped}
              min={KEEP_AWAKE_HOURS_MIN}
              max={KEEP_AWAKE_HOURS_MAX}
              step={0.1}
              className="w-14 bg-transparent border border-border px-1 py-0.5 text-text outline-none focus:border-accent text-center disabled:opacity-40"
            />
            <span className="text-text-muted">hours</span>
          </div>
          <label className="flex items-center gap-1.5 text-[10px] text-text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={untilStopped}
              onChange={(e) => setUntilStopped(e.target.checked)}
            />
            Until stopped (no expiry)
          </label>
          <button
            type="button"
            onClick={() => {
              if (untilStopped) {
                start(0);
                return;
              }
              const raw = parseFloat(hoursDraft);
              const hours = Number.isFinite(raw) ? clampKeepAwakeHours(raw) : KEEP_AWAKE_HOURS_DEFAULT;
              start(Math.round(hours * 3600));
            }}
            className="self-start px-2 py-0.5 text-[10px] text-accent border border-accent/40 rounded hover:bg-accent/10 transition-colors"
          >
            Start
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main ControlBar ─────────────────────────────────────────────────────────

interface ControlBarProps {
  projectId: string;
}

export default function ControlBar({ projectId }: ControlBarProps) {
  // #210: Keep Alive moved to the Scheduled Trigger widget in the
  // bottom-right Operator Features quadrant. ControlBar now only
  // carries the server lifecycle + system controls.
  return (
    <div className="border-t border-border px-3 py-2">
      {/* #369 / quadwork#369: revert the #337 stacked-row interpretation.
          Lay out SERVER | KEEP MAC AWAKE | NOTIFICATION SOUND as three
          horizontally arranged columns separated by vertical w-px
          dividers. SystemSection internally renders the right two
          columns (Keep Awake hides on non-darwin so the row collapses
          to two columns naturally). At narrow widths (< md) the
          whole layout collapses back to stacked rows with horizontal
          dividers so cramped split-views still fit. */}
      <div className="flex flex-col md:flex-row md:items-start gap-2 md:gap-6">
        <ServerSection projectId={projectId} />
        <div className="border-t border-border/40 md:border-t-0 md:w-px md:h-auto md:self-stretch md:bg-border" />
        <SystemSection />
      </div>
    </div>
  );
}
