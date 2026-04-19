"use client";

import React from "react";

interface PanelHeaderProps {
  label: string;
  status?: "running" | "stopped" | "error";
  projectId?: string;
  agentId?: string;
  onStatusChange?: (newStatus: string) => void;
  /** #407: optional info tooltip element rendered after the label */
  tooltip?: React.ReactNode;
  /** #523: optional right-aligned content (e.g. toggle switches) */
  children?: React.ReactNode;
}

export default function PanelHeader({ label, status, projectId, agentId, onStatusChange, tooltip, children }: PanelHeaderProps) {
  const dotColor =
    status === "running"
      ? "bg-accent"
      : status === "error"
        ? "bg-error"
        : "bg-text-muted";

  const lifecycleAction = (action: string) => {
    if (!projectId || !agentId) return;
    fetch(`/api/agents?project=${encodeURIComponent(projectId)}&agent=${encodeURIComponent(agentId)}&action=${action}`, {
      method: "POST",
    })
      .then((r) => r.json())
      .then((d) => {
        if (onStatusChange && d.state) onStatusChange(d.state);
      })
      .catch(() => {});
  };

  const showControls = projectId && agentId;

  return (
    <div className="flex items-center justify-between gap-2 px-3 h-7 shrink-0 border-b border-border">
      <div className="flex items-center gap-2">
        {status && (
          <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        )}
        <span className="text-[11px] text-text-muted uppercase tracking-wider">
          {label}
        </span>
        {tooltip}
      </div>
      <div className="flex items-center gap-1.5">
        {children}
        {showControls && (
          <>
            {status !== "running" && (
              <button
                onClick={() => lifecycleAction("start")}
                className="text-[10px] text-text-muted hover:text-accent transition-colors px-1"
                title="Start"
              >
                ▶
              </button>
            )}
            {status === "running" && (
              <button
                onClick={() => lifecycleAction("stop")}
                className="text-[10px] text-text-muted hover:text-error transition-colors px-1"
                title="Stop"
              >
                ■
              </button>
            )}
            <button
              onClick={() => lifecycleAction("restart")}
              className="text-[10px] text-text-muted hover:text-accent transition-colors px-1"
              title="Restart"
            >
              ↻
            </button>
          </>
        )}
      </div>
    </div>
  );
}
