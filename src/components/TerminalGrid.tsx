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

export default function TerminalGrid({
  projectId,
  agents = DEFAULT_AGENTS,
}: TerminalGridProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  // Expect 3 agents: [0] top-left, [1] top-right, [2] bottom full-width
  const [topLeft, topRight, bottom] = agents;

  if (expanded) {
    const agent = agents.find((a) => a.id === expanded);
    if (!agent) return null;

    return (
      <div className="w-full h-full flex flex-col">
        <div className="flex items-center justify-between px-3 h-7 shrink-0 border-b border-border">
          <span className="text-[11px] text-text-muted uppercase tracking-wider">
            {agent.label}
          </span>
          <button
            onClick={() => setExpanded(null)}
            className="text-[11px] text-text-muted hover:text-text transition-colors"
          >
            esc
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <TerminalPanel projectId={projectId} agentId={agent.id} />
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full grid grid-rows-2 grid-cols-2">
      {/* Top-left: T2a */}
      {topLeft && (
        <div
          className="border-r border-b border-border flex flex-col cursor-pointer"
          onClick={() => setExpanded(topLeft.id)}
        >
          <div className="flex items-center px-3 h-6 shrink-0 border-b border-border">
            <span className="text-[11px] text-text-muted uppercase tracking-wider">
              {topLeft.label}
            </span>
          </div>
          <div className="flex-1 min-h-0">
            <TerminalPanel projectId={projectId} agentId={topLeft.id} />
          </div>
        </div>
      )}

      {/* Top-right: T2b */}
      {topRight && (
        <div
          className="border-b border-border flex flex-col cursor-pointer"
          onClick={() => setExpanded(topRight.id)}
        >
          <div className="flex items-center px-3 h-6 shrink-0 border-b border-border">
            <span className="text-[11px] text-text-muted uppercase tracking-wider">
              {topRight.label}
            </span>
          </div>
          <div className="flex-1 min-h-0">
            <TerminalPanel projectId={projectId} agentId={topRight.id} />
          </div>
        </div>
      )}

      {/* Bottom full-width: T3 */}
      {bottom && (
        <div
          className="col-span-2 flex flex-col cursor-pointer"
          onClick={() => setExpanded(bottom.id)}
        >
          <div className="flex items-center px-3 h-6 shrink-0 border-b border-border">
            <span className="text-[11px] text-text-muted uppercase tracking-wider">
              {bottom.label}
            </span>
          </div>
          <div className="flex-1 min-h-0">
            <TerminalPanel projectId={projectId} agentId={bottom.id} />
          </div>
        </div>
      )}
    </div>
  );
}
