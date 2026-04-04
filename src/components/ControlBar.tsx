"use client";

import { useState, useEffect, useCallback } from "react";

// ─── Keep Alive (formerly Trigger) ───────────────────────────────────────────

interface TriggerInfo {
  enabled: boolean;
  interval: number;
  lastSent: number | null;
  nextAt: number | null;
  expiresAt: number | null;
}

const DURATION_PRESETS = [
  { label: "1 hour", minutes: 60 },
  { label: "3 hours", minutes: 180 },
  { label: "8 hours", minutes: 480 },
  { label: "Until stopped", minutes: 0 },
];

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0m 0s";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function KeepAliveSection({ projectId }: { projectId: string }) {
  const [trigger, setTrigger] = useState<TriggerInfo | null>(null);
  const [interval, setInterval_] = useState(15);
  const [duration, setDuration] = useState(180); // minutes, 0 = indefinite
  const [countdown, setCountdown] = useState("");
  const [expiresCountdown, setExpiresCountdown] = useState("");

  useEffect(() => {
    const poll = () => {
      fetch("/api/triggers")
        .then((r) => (r.ok ? r.json() : {}))
        .then((data: Record<string, TriggerInfo>) => {
          const t = data[projectId];
          if (t) {
            setTrigger(t);
            setInterval_(Math.round(t.interval / 60000));
          } else {
            setTrigger(null);
          }
        })
        .catch(() => {});
    };
    poll();
    const id = window.setInterval(poll, 10000);
    return () => window.clearInterval(id);
  }, [projectId]);

  useEffect(() => {
    if (!trigger?.nextAt && !trigger?.expiresAt) {
      setCountdown("");
      setExpiresCountdown("");
      return;
    }
    const tick = () => {
      if (trigger.nextAt) {
        const remaining = Math.max(0, trigger.nextAt - Date.now());
        setCountdown(formatCountdown(remaining));
      }
      if (trigger.expiresAt) {
        const remaining = Math.max(0, trigger.expiresAt - Date.now());
        setExpiresCountdown(formatCountdown(remaining));
        // Auto-clear when expired
        if (remaining <= 0) setTrigger(null);
      } else {
        setExpiresCountdown("");
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [trigger?.nextAt, trigger?.expiresAt]);

  const start = () => {
    fetch(
      `/api/triggers/${encodeURIComponent(projectId)}/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval, duration }),
      }
    )
      .then((r) => r.json())
      .then((d) => {
        if (d.ok)
          setTrigger({
            enabled: true,
            interval: d.interval,
            lastSent: null,
            nextAt: d.nextAt,
            expiresAt: d.expiresAt || null,
          });
      })
      .catch(() => {});
  };

  const stop = () => {
    fetch(
      `/api/triggers/${encodeURIComponent(projectId)}/stop`,
      { method: "POST" }
    )
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setTrigger(null);
      })
      .catch(() => {});
  };

  const sendNow = () => {
    fetch(
      `/api/triggers/${encodeURIComponent(projectId)}/send-now`,
      { method: "POST" }
    ).catch(() => {});
  };

  const isEnabled = trigger?.enabled;

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">
        Keep Alive
      </div>
      <div className="text-[10px] text-text-muted leading-tight">
        Send a check-in to all agents every:
      </div>
      {isEnabled ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              <span className="text-[11px] text-accent">Running</span>
            </span>
            <span className="text-[11px] text-text tabular-nums">
              Next: {countdown}
            </span>
            {expiresCountdown && (
              <span className="text-[11px] text-text-muted tabular-nums">
                Stops in: {expiresCountdown}
              </span>
            )}
            {!trigger?.expiresAt && (
              <span className="text-[10px] text-text-muted">
                (until stopped)
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={sendNow}
              className="px-1.5 py-0.5 text-[10px] text-accent border border-accent/40 hover:bg-accent/10 transition-colors"
            >
              Send Now
            </button>
            <button
              onClick={stop}
              className="px-1.5 py-0.5 text-[10px] text-text-muted border border-border hover:text-error hover:border-error/40 transition-colors"
            >
              Stop
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              value={interval}
              onChange={(e) => setInterval_(parseInt(e.target.value, 10) || 15)}
              min={1}
              max={1440}
              className="w-10 bg-transparent border border-border px-1 py-0.5 text-[11px] text-text outline-none focus:border-accent text-center"
            />
            <span className="text-[10px] text-text-muted">min</span>
            <span className="text-[10px] text-text-muted mx-0.5">for</span>
            <select
              value={duration}
              onChange={(e) => setDuration(parseInt(e.target.value, 10))}
              className="bg-transparent border border-border px-1 py-0.5 text-[11px] text-text outline-none focus:border-accent cursor-pointer"
            >
              {DURATION_PRESETS.map((p) => (
                <option key={p.minutes} value={p.minutes} className="bg-bg-surface">
                  {p.label}
                </option>
              ))}
            </select>
            <button
              onClick={start}
              className="px-2 py-0.5 text-[10px] text-bg bg-accent hover:bg-accent-dim font-semibold transition-colors"
            >
              Start
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Server Controls ─────────────────────────────────────────────────────────

function ServerSection({ projectId }: { projectId: string }) {
  const [loading, setLoading] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);

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
        setFeedback(`Restarted (PID: ${d.pid})`);
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
        d.ok ? `Reset — ${d.cleared} of ${d.total} slot${d.total !== 1 ? "s" : ""} deregistered` : "Failed"
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
    </div>
  );
}

// ─── System (Caffeinate) ─────────────────────────────────────────────────────

const PRESETS = [
  { label: "2 hours", seconds: 7200 },
  { label: "4 hours", seconds: 14400 },
  { label: "8 hours", seconds: 28800 },
  { label: "Until stopped", seconds: 0 },
];

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

  if (platform && platform !== "darwin") return null;

  return (
    <div className="flex flex-col gap-1 relative">
      <div className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">
        System
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => (active ? stop() : setShowPresets(!showPresets))}
          className={`px-1.5 py-0.5 text-[10px] border transition-colors ${
            active
              ? "border-accent/50 text-accent bg-accent/10 hover:bg-accent/20"
              : "border-border text-text-muted hover:text-text hover:border-accent"
          }`}
        >
          {active ? "Awake" : "Keep Awake"}
          {active && remaining !== null && remaining > 0 && (
            <span className="ml-1 text-accent/70">{formatTime(remaining)}</span>
          )}
          {active && remaining === null && (
            <span className="ml-1 text-accent/70">on</span>
          )}
        </button>
      </div>

      {showPresets && !active && (
        <div className="absolute bottom-full left-0 mb-1 border border-border bg-bg-surface z-20 min-w-[140px]">
          <p className="px-2 py-1 text-[10px] text-[#ffcc00] border-b border-border">
            Make sure Mac is plugged in
          </p>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => start(p.seconds)}
              className="w-full text-left px-2 py-1 text-[10px] text-text hover:bg-[#1a1a1a] transition-colors"
            >
              {p.label}
            </button>
          ))}
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
  return (
    <div className="border-t border-border px-3 py-2">
      <div className="flex items-start gap-6">
        <KeepAliveSection projectId={projectId} />
        <div className="w-px self-stretch bg-border" />
        <ServerSection projectId={projectId} />
        <div className="w-px self-stretch bg-border" />
        <SystemSection />
      </div>
    </div>
  );
}
