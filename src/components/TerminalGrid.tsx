"use client";

import { useState } from "react";
import TerminalPanel from "./TerminalPanel";

interface Agent {
  id: string;
  label: string;
}

interface TerminalGridProps {
  projectId: string;
  agents?: Agent[];
  agentStates?: Record<string, string>;
  onStatusChange?: (agentId: string, state: string) => void;
}

const DEFAULT_AGENTS: Agent[] = [
  { id: "reviewer1", label: "Reviewer1" },
  { id: "reviewer2", label: "Reviewer2" },
  { id: "dev", label: "Dev" },
];

const GRID_CLASSES = [
  "border-r border-b border-border", // top-left
  "border-b border-border",          // top-right
  "col-span-2",                      // bottom full-width
];

export default function TerminalGrid({
  projectId,
  agents = DEFAULT_AGENTS,
  agentStates = {},
  onStatusChange,
}: TerminalGridProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="w-full h-full relative grid grid-rows-2 grid-cols-2">
      {agents.map((agent, i) => {
        const isExpanded = expanded === agent.id;
        const isHidden = expanded !== null && !isExpanded;

        return (
          <div
            key={agent.id}
            className={`flex flex-col ${
              isExpanded
                ? "absolute inset-0 z-10 bg-bg"
                : `${GRID_CLASSES[i] || ""}`
            }`}
            style={isHidden ? { visibility: "hidden", overflow: "hidden" } : undefined}
          >
            <div
              className={`flex items-center justify-between px-3 shrink-0 border-b border-border ${
                isExpanded ? "h-7" : "h-6"
              }`}
            >
              <div
                className={`flex items-center gap-1.5 ${!isExpanded ? "cursor-pointer" : ""}`}
                onClick={isExpanded ? undefined : () => setExpanded(agent.id)}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${
                  agentStates[agent.id] === "running" ? "bg-accent"
                    : agentStates[agent.id] === "error" ? "bg-error"
                    : "bg-text-muted"
                }`} />
                <span className="text-[11px] text-text-muted uppercase tracking-wider">
                  {agent.label}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {agentStates[agent.id] !== "running" && (
                  <button
                    onClick={() => {
                      fetch(`/api/agents?project=${encodeURIComponent(projectId)}&agent=${encodeURIComponent(agent.id)}&action=start`, { method: "POST" })
                        .then((r) => r.json())
                        .then((d) => { if (d.state && onStatusChange) onStatusChange(agent.id, d.state); })
                        .catch(() => {});
                    }}
                    className="text-[10px] text-text-muted hover:text-accent transition-colors px-0.5"
                    title="Start"
                  >▶</button>
                )}
                {agentStates[agent.id] === "running" && (
                  <button
                    onClick={() => {
                      fetch(`/api/agents?project=${encodeURIComponent(projectId)}&agent=${encodeURIComponent(agent.id)}&action=stop`, { method: "POST" })
                        .then((r) => r.json())
                        .then((d) => { if (d.state && onStatusChange) onStatusChange(agent.id, d.state); })
                        .catch(() => {});
                    }}
                    className="text-[10px] text-text-muted hover:text-error transition-colors px-0.5"
                    title="Stop"
                  >■</button>
                )}
                <button
                  onClick={() => {
                    fetch(`/api/agents?project=${encodeURIComponent(projectId)}&agent=${encodeURIComponent(agent.id)}&action=restart`, { method: "POST" })
                      .then((r) => r.json())
                      .then((d) => { if (d.state && onStatusChange) onStatusChange(agent.id, d.state); })
                      .catch(() => {});
                  }}
                  className="text-[10px] text-text-muted hover:text-accent transition-colors px-0.5"
                  title="Restart"
                >↻</button>
                {agentStates[agent.id] === "running" && (
                  <button
                    onClick={() => {
                      fetch(`/api/agents/${encodeURIComponent(projectId)}/${encodeURIComponent(agent.id)}/write`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ text: "/compact\n" }),
                      }).catch(() => {});
                    }}
                    className="text-[10px] text-text-muted hover:text-accent transition-colors px-0.5"
                    title="Compact — frees context/memory when agent is stuck"
                  >&#x29C9;</button>
                )}
                {isExpanded && (
                  <button
                    onClick={() => setExpanded(null)}
                    className="text-[11px] text-text-muted hover:text-text transition-colors ml-1"
                  >
                    esc
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <TerminalPanel projectId={projectId} agentId={agent.id} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
