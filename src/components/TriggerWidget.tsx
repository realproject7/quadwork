"use client";

import { useState, useEffect } from "react";

interface TriggerInfo {
  enabled: boolean;
  interval: number;
  lastSent: number | null;
  nextAt: number | null;
}

interface TriggerWidgetProps {
  projectId: string;
}

export default function TriggerWidget({ projectId }: TriggerWidgetProps) {
  const [trigger, setTrigger] = useState<TriggerInfo | null>(null);
  const [interval, setInterval_] = useState(30); // minutes
  const [countdown, setCountdown] = useState("");

  // Poll trigger status
  useEffect(() => {
    const poll = () => {
      fetch("/api/triggers")
        .then((r) => r.ok ? r.json() : {})
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

  // Countdown timer
  useEffect(() => {
    if (!trigger?.nextAt) { setCountdown(""); return; }
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
    fetch(`/api/triggers?project=${encodeURIComponent(projectId)}&action=start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interval }),
    })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setTrigger({ enabled: true, interval: d.interval, lastSent: null, nextAt: d.nextAt }); })
      .catch(() => {});
  };

  const stop = () => {
    fetch(`/api/triggers?project=${encodeURIComponent(projectId)}&action=stop`, { method: "POST" })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setTrigger(null); })
      .catch(() => {});
  };

  const sendNow = () => {
    fetch(`/api/triggers?project=${encodeURIComponent(projectId)}&action=send-now`, { method: "POST" })
      .catch(() => {});
  };

  const isEnabled = trigger?.enabled;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border text-[11px]">
      <span className={`w-1.5 h-1.5 rounded-full ${isEnabled ? "bg-accent" : "bg-text-muted"}`} />
      <span className="text-text-muted">Trigger:</span>

      {isEnabled ? (
        <>
          <span className="text-text tabular-nums">{countdown}</span>
          <button
            onClick={sendNow}
            className="text-accent hover:underline"
          >
            Send Now
          </button>
          <button
            onClick={stop}
            className="text-text-muted hover:text-error"
          >
            Stop
          </button>
        </>
      ) : (
        <>
          <input
            type="number"
            value={interval}
            onChange={(e) => setInterval_(parseInt(e.target.value, 10) || 30)}
            min={1}
            max={1440}
            className="w-12 bg-transparent border border-border px-1 py-0.5 text-[11px] text-text outline-none focus:border-accent text-center"
          />
          <span className="text-text-muted">min</span>
          <button
            onClick={start}
            className="text-accent hover:underline"
          >
            Start
          </button>
        </>
      )}
    </div>
  );
}
