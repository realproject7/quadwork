"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import PanelHeader from "./PanelHeader";
import InfoTooltip from "./InfoTooltip";
import ChatPanel from "./ChatPanel";
import GitHubPanel from "./GitHubPanel";
import ControlBar from "./ControlBar";
import AgentTerminalsGrid from "./AgentTerminalsGrid";
import OperatorFeaturesPanel from "./OperatorFeaturesPanel";

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

  // #523: system message filter — lifted here so the toggle renders
  // inline in PanelHeader while ChatPanel consumes the value.
  const [filterSystem, setFilterSystem] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("chatFilterSystem") === "1";
  });
  const toggleFilter = useCallback(() => {
    setFilterSystem((prev) => {
      const next = !prev;
      localStorage.setItem("chatFilterSystem", next ? "1" : "0");
      // #525: persist to project config so bridges respect the filter
      fetch("/api/config")
        .then((r) => r.ok ? r.json() : null)
        .then((cfg) => {
          if (!cfg) return;
          const entry = (cfg.projects || []).find((p: { id: string }) => p.id === projectId);
          if (entry) {
            entry.bridge_filter_agents_only = next;
            return fetch("/api/config", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(cfg),
            });
          }
        })
        .catch(() => {});
      return next;
    });
  }, [projectId]);
  const filterToggle = useMemo(() => (
    <button
      type="button"
      onClick={toggleFilter}
      title={filterSystem ? "Showing agent messages only — click to show all" : "Showing all messages — click to hide system/status noise"}
      className={`px-1.5 py-0.5 text-[10px] border transition-colors ${
        filterSystem
          ? "border-accent/50 text-accent bg-accent/10 hover:bg-accent/20"
          : "border-border text-text-muted hover:text-text hover:border-accent"
      }`}
    >
      {filterSystem ? "Agents ●" : "All ○"}
    </button>
  ), [filterSystem, toggleFilter]);

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
      {/* Quadrant 1 (top-left): AgentChattr chat — highlighted as
          the primary interface (#208). 2px accent border + explicit
          "primary chat" label in the panel header. */}
      <div className="flex flex-col overflow-hidden border-2 border-accent">
        <PanelHeader label="AgentChattr — primary chat" tooltip={
          <InfoTooltip>
            <b>Primary Chat</b> — live chat between you and the 4 AI agents. Messages you type here trigger agent actions. Use @mentions to address specific agents.
          </InfoTooltip>
        }>
          {filterToggle}
        </PanelHeader>
        <div className="flex-1 min-h-0">
          <ChatPanel projectId={projectId} filterSystem={filterSystem} />
        </div>
        <ControlBar projectId={projectId} />
      </div>

      {/* Vertical divider — top segment */}
      <div
        className="bg-border cursor-col-resize hover:bg-accent-dim transition-colors"
        onMouseDown={() => startDrag("col")}
      />

      {/* Quadrant 2 (top-right): Agent terminals — 2x2 grid with
          header + "do not type here" tooltip (#208). */}
      <div className="flex flex-col overflow-hidden">
        <AgentTerminalsGrid
          projectId={projectId}
          agentStates={agentStates}
          onStatusChange={updateAgentState}
        />
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

      {/* Quadrant 3 (bottom-left): GitHub (#208). */}
      <div className="flex flex-col overflow-hidden">
        <PanelHeader label="GitHub" tooltip={
          <InfoTooltip>
            <b>GitHub</b> — open issues and pull requests on this project&apos;s repo. Click any item to open it on GitHub. The batch progress panel tracks the active batch&apos;s lifecycle from queued to merged.
          </InfoTooltip>
        } />
        <div className="flex-1 min-h-0">
          <GitHubPanel projectId={projectId} />
        </div>
      </div>

      {/* Vertical divider — bottom segment */}
      <div
        className="bg-border cursor-col-resize hover:bg-accent-dim transition-colors"
        onMouseDown={() => startDrag("col")}
      />

      {/* Quadrant 4 (bottom-right): Operator Features (#208) —
          placeholder container. Sub-tickets #209/#210/#211 fill it. */}
      <OperatorFeaturesPanel projectId={projectId} />
    </div>
  );
}
