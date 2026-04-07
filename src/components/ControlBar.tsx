"use client";

import { useState, useEffect, useCallback } from "react";

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
  // #210: Keep Alive moved to the Scheduled Trigger widget in the
  // bottom-right Operator Features quadrant. ControlBar now only
  // carries the server lifecycle + system controls.
  return (
    <div className="border-t border-border px-3 py-2">
      <div className="flex items-start gap-6">
        <ServerSection projectId={projectId} />
        <div className="w-px self-stretch bg-border" />
        <SystemSection />
      </div>
    </div>
  );
}
