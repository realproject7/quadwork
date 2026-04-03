"use client";

import { useState, useEffect, useCallback } from "react";

// ─── Keep Alive (formerly Trigger) ───────────────────────────────────────────

interface TriggerInfo {
  enabled: boolean;
  interval: number;
  lastSent: number | null;
  nextAt: number | null;
}

function KeepAliveSection({ projectId }: { projectId: string }) {
  const [trigger, setTrigger] = useState<TriggerInfo | null>(null);
  const [interval, setInterval_] = useState(30);
  const [countdown, setCountdown] = useState("");

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
    if (!trigger?.nextAt) {
      setCountdown("");
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, (trigger.nextAt || 0) - Date.now());
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      setCountdown(`${mins}m ${secs}s`);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [trigger?.nextAt]);

  const start = () => {
    fetch(
      `/api/triggers?project=${encodeURIComponent(projectId)}&action=start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval }),
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
          });
      })
      .catch(() => {});
  };

  const stop = () => {
    fetch(
      `/api/triggers?project=${encodeURIComponent(projectId)}&action=stop`,
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
      `/api/triggers?project=${encodeURIComponent(projectId)}&action=send-now`,
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
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            <span className="text-[11px] text-accent">Running</span>
          </span>
          <span className="text-[11px] text-text tabular-nums">
            Next: {countdown}
          </span>
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
      ) : (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={interval}
            onChange={(e) => setInterval_(parseInt(e.target.value, 10) || 30)}
            min={1}
            max={1440}
            className="w-10 bg-transparent border border-border px-1 py-0.5 text-[11px] text-text outline-none focus:border-accent text-center"
          />
          <span className="text-[10px] text-text-muted">min</span>
          <button
            onClick={start}
            className="px-2 py-0.5 text-[10px] text-bg bg-accent hover:bg-accent-dim font-semibold transition-colors"
          >
            Start
          </button>
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
      setFeedback(d.ok ? `Restarted (PID: ${d.pid})` : "Failed");
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
          disabled={loading === "stop"}
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
          disabled={loading === "restart"}
          className="px-1.5 py-0.5 text-[10px] text-text-muted border border-border hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-50"
        >
          {loading === "restart" ? "..." : "Restart"}
        </button>
        <button
          onClick={handleReset}
          disabled={loading === "reset"}
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
