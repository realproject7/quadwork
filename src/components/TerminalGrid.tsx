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
}

const DEFAULT_AGENTS: Agent[] = [
  { id: "t2a", label: "T2a" },
  { id: "t2b", label: "T2b" },
  { id: "t3", label: "T3" },
];

const GRID_CLASSES = [
  "border-r border-b border-border", // top-left
  "border-b border-border",          // top-right
  "col-span-2",                      // bottom full-width
];

export default function TerminalGrid({
  projectId,
  agents = DEFAULT_AGENTS,
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
              className={`flex items-center px-3 shrink-0 border-b border-border ${
                isExpanded ? "h-7 justify-between" : "h-6 cursor-pointer"
              }`}
              onClick={isExpanded ? undefined : () => setExpanded(agent.id)}
            >
              <span className="text-[11px] text-text-muted uppercase tracking-wider">
                {agent.label}
              </span>
              {isExpanded && (
                <button
                  onClick={() => setExpanded(null)}
                  className="text-[11px] text-text-muted hover:text-text transition-colors"
                >
                  esc
                </button>
              )}
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
