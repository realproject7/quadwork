"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import TerminalPanel from "./TerminalPanel";
import TerminalGrid from "./TerminalGrid";
import PanelHeader from "./PanelHeader";
import ChatPanel from "./ChatPanel";
import GitHubPanel from "./GitHubPanel";
import TriggerWidget from "./TriggerWidget";

const MIN_SIZE = 150; // px
const DIVIDER = 4; // px

type AgentState = "running" | "stopped" | "error";

interface ProjectDashboardProps {
  projectId: string;
}

export default function ProjectDashboard({ projectId }: ProjectDashboardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [colRatio, setColRatio] = useState(0.5);
  const [rowRatio, setRowRatio] = useState(0.5);
  const dragging = useRef<"col" | "row" | null>(null);
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({});

  // Poll agent states
  useEffect(() => {
    const poll = () => {
      fetch("/api/agents")
        .then((r) => r.ok ? r.json() : {})
        .then((data) => {
          const states: Record<string, AgentState> = {};
          for (const [key, info] of Object.entries(data)) {
            if (key.startsWith(`${projectId}/`)) {
              const agent = key.split("/")[1];
              states[agent] = (info as { state: string }).state as AgentState;
            }
          }
          setAgentStates(states);
        })
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [projectId]);

  const updateAgentState = (agent: string, state: string) => {
    setAgentStates((prev) => ({ ...prev, [agent]: state as AgentState }));
  };

  const clamp = useCallback(
    (ratio: number, totalPx: number) => {
      // Available space excludes the divider track
      const available = totalPx - DIVIDER;
      const minRatio = MIN_SIZE / totalPx;
      const maxRatio = (available - MIN_SIZE) / totalPx;
      return Math.min(maxRatio, Math.max(minRatio, ratio));
    },
    []
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();

      if (dragging.current === "col") {
        const x = e.clientX - rect.left;
        setColRatio(clamp(x / rect.width, rect.width));
      } else {
        const y = e.clientY - rect.top;
        setRowRatio(clamp(y / rect.height, rect.height));
      }
    };

    const onMouseUp = () => {
      dragging.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [clamp]);

  const startDrag = (axis: "col" | "row") => {
    dragging.current = axis;
    document.body.style.cursor = axis === "col" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  const colTemplate = `${colRatio * 100}% ${DIVIDER}px 1fr`;
  const rowTemplate = `${rowRatio * 100}% ${DIVIDER}px 1fr`;

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{
        display: "grid",
        gridTemplateColumns: colTemplate,
        gridTemplateRows: rowTemplate,
      }}
    >
      {/* Panel 1: Head Terminal — top-left */}
      <div className="flex flex-col overflow-hidden">
        <PanelHeader
          label="Head"
          status={agentStates["head"] || "stopped"}
          projectId={projectId}
          agentId="head"
          onStatusChange={(s) => updateAgentState("head", s)}
        />
        <div className="flex-1 min-h-0">
          <TerminalPanel projectId={projectId} agentId="head" />
        </div>
      </div>

      {/* Vertical divider — top segment */}
      <div
        className="bg-border cursor-col-resize hover:bg-accent-dim transition-colors"
        onMouseDown={() => startDrag("col")}
      />

      {/* Panel 2: GitHub placeholder — top-right */}
      <div className="flex flex-col overflow-hidden">
        <PanelHeader label="GitHub" />
        <div className="flex-1 min-h-0">
          <GitHubPanel projectId={projectId} />
        </div>
      </div>

      {/* Horizontal divider — left segment */}
      <div
        className="bg-border cursor-row-resize hover:bg-accent-dim transition-colors"
        onMouseDown={() => startDrag("row")}
      />

      {/* Horizontal divider — center intersection */}
      <div
        className="bg-border cursor-move"
        onMouseDown={() => startDrag("col")}
      />

      {/* Horizontal divider — right segment */}
      <div
        className="bg-border cursor-row-resize hover:bg-accent-dim transition-colors"
        onMouseDown={() => startDrag("row")}
      />

      {/* Panel 3: Chat — bottom-left */}
      <div className="flex flex-col overflow-hidden">
        <PanelHeader label="Chat" />
        <div className="flex-1 min-h-0">
          <ChatPanel projectId={projectId} />
        </div>
        <TriggerWidget projectId={projectId} />
      </div>

      {/* Vertical divider — bottom segment */}
      <div
        className="bg-border cursor-col-resize hover:bg-accent-dim transition-colors"
        onMouseDown={() => startDrag("col")}
      />

      {/* Panel 4: Agent terminals — bottom-right */}
      <div className="flex flex-col overflow-hidden">
        <PanelHeader label="Panel 4" />
        <div className="flex-1 min-h-0">
          <TerminalGrid
            projectId={projectId}
            agentStates={agentStates}
            onStatusChange={updateAgentState}
          />
        </div>
      </div>
    </div>
  );
}
