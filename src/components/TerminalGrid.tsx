"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import TerminalPanel from "./TerminalPanel";
import AgentLifecycleControls from "./AgentLifecycleControls";
import { sessionTokenHeaders } from "@/lib/sessionToken";
import {
  TERMINAL_DIVIDER_SIZE,
  TERMINAL_MIN_PANE_SIZE,
  clampTerminalSplitRatio,
  terminalGridLayout,
} from "@/lib/panelResize";

// #399 / quadwork#264: how long an agent stays "active" after its
// last PTY output before the activity ring stops pulsing.
// #421 / quadwork#305: bumped from 2000 → 5000ms. 2s felt like a
// flicker on bursty PTY output; 5s keeps the indicator steady for
// the duration of a typical agent working burst while still going
// idle shortly after the agent stops producing output.
const ACTIVITY_WINDOW_MS = 5000;

interface Agent {
  id: string;
  label: string;
}

interface TerminalGridProps {
  projectId: string;
  agents?: Agent[];
  agentStates?: Record<string, string>;
  agentGenerations?: Record<string, string | null>;
  onStatusChange?: (agentId: string, state: string) => void;
}

const DEFAULT_AGENTS: Agent[] = [
  { id: "re1", label: "RE1" },
  { id: "re2", label: "RE2" },
  { id: "dev", label: "Dev" },
];

type SplitAxis = "column" | "row";

export default function TerminalGrid({
  projectId,
  agents = DEFAULT_AGENTS,
  agentStates = {},
  agentGenerations = {},
  onStatusChange,
}: TerminalGridProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [columnRatio, setColumnRatio] = useState(0.5);
  const [rowRatio, setRowRatio] = useState(0.5);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ axis: SplitAxis } | null>(null);

  // Each terminal keeps its own ResizeObserver, so changing either split
  // automatically refits xterm and sends the new PTY dimensions. The grid
  // only owns the visual boundary and its minimum-size contract.
  const clampRatio = useCallback(clampTerminalSplitRatio, []);

  useEffect(() => {
    const stopDragging = () => {
      if (!dragging.current) return;
      dragging.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const moveDivider = (event: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (dragging.current.axis === "column") {
        setColumnRatio(clampRatio((event.clientX - rect.left) / rect.width, rect.width));
      } else {
        setRowRatio(clampRatio((event.clientY - rect.top) / rect.height, rect.height));
      }
    };
    window.addEventListener("mousemove", moveDivider);
    window.addEventListener("mouseup", stopDragging);
    return () => {
      window.removeEventListener("mousemove", moveDivider);
      window.removeEventListener("mouseup", stopDragging);
    };
  }, [clampRatio]);

  const startDrag = (axis: SplitAxis) => {
    dragging.current = { axis };
    document.body.style.cursor = axis === "column" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  const nudgeSplit = (axis: SplitAxis, amount: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const total = axis === "column" ? rect?.width : rect?.height;
    if (!total) return;
    if (axis === "column") setColumnRatio((value) => clampRatio(value + amount, total));
    else setRowRatio((value) => clampRatio(value + amount, total));
  };

  const layout = terminalGridLayout(agents.length);
  const gridStyle = {
    gridTemplateColumns: `minmax(${TERMINAL_MIN_PANE_SIZE}px, ${columnRatio}fr) ${TERMINAL_DIVIDER_SIZE}px minmax(${TERMINAL_MIN_PANE_SIZE}px, ${1 - columnRatio}fr)`,
    gridTemplateRows: layout.hasHorizontalSplit
      ? `minmax(${TERMINAL_MIN_PANE_SIZE}px, ${rowRatio}fr) ${TERMINAL_DIVIDER_SIZE}px minmax(${TERMINAL_MIN_PANE_SIZE}px, ${1 - rowRatio}fr)`
      : "minmax(0, 1fr)",
  };

  // #399 / quadwork#264: derive a "currently active" signal from the
  // PTY ws stream so the ring only pulses while the agent is actually
  // working. The ring previously fired whenever the session was
  // running, which meant idle live agents had a constantly-spinning
  // ring indistinguishable from a busy one.
  //
  // We store the last-activity timestamp per agent in a ref (so the
  // hot ws.onmessage path doesn't trigger a render storm) and tick a
  // small piece of state every 500ms to re-evaluate freshness. This
  // keeps the render budget bounded regardless of PTY chatter.
  const lastActivityRef = useRef<Record<string, number>>({});
  const [activityTick, setActivityTick] = useState(0);
  const markActivity = useCallback((agentId: string) => {
    lastActivityRef.current[agentId] = Date.now();
  }, []);
  // #430 / quadwork#312: track per-agent session transitions (idle
  // → active → idle) and POST them to /api/activity/log so the
  // backend can persist work-hours rows. A session starts the
  // first tick isActive flips true and ends the first tick it
  // flips back to false (ACTIVITY_WINDOW_MS after the last PTY
  // write). fetch failures are best-effort — losing one session
  // just under-counts the stat, never blocks the UI.
  const sessionActiveRef = useRef<Record<string, boolean>>({});
  const logActivity = useCallback((agentId: string, type: "start" | "end") => {
    fetch("/api/activity/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: projectId,
        agent: agentId,
        type,
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  }, [projectId]);
  useEffect(() => {
    const interval = setInterval(() => {
      setActivityTick((t) => t + 1);
      // On every tick, walk the known agents and detect transitions.
      for (const agent of agents) {
        const ts = lastActivityRef.current[agent.id];
        const active = ts !== undefined && Date.now() - ts < ACTIVITY_WINDOW_MS;
        const wasActive = !!sessionActiveRef.current[agent.id];
        if (active && !wasActive) {
          sessionActiveRef.current[agent.id] = true;
          logActivity(agent.id, "start");
        } else if (!active && wasActive) {
          sessionActiveRef.current[agent.id] = false;
          logActivity(agent.id, "end");
        }
      }
    }, 500);
    return () => clearInterval(interval);
  }, [agents, logActivity]);
  const isActive = (agentId: string) => {
    const ts = lastActivityRef.current[agentId];
    return ts !== undefined && Date.now() - ts < ACTIVITY_WINDOW_MS;
  };
  // Reference activityTick so the linter doesn't strip the dep that
  // forces a re-render on each tick.
  void activityTick;

  return (
    <div ref={containerRef} className="w-full h-full relative grid overflow-hidden" style={gridStyle}>
      {agents.map((agent, i) => {
        const isExpanded = expanded === agent.id;
        const isHidden = expanded !== null && !isExpanded;
        const isVerified = agentStates[agent.id] === "running" || agentStates[agent.id] === "verified";
        const gridPosition = layout.positions[i] || {};

        return (
          <div
            key={agent.id}
            className={`flex flex-col min-w-0 min-h-0 ${
              isExpanded
                ? "absolute inset-0 z-10 bg-bg"
                : ""
            }`}
            style={isHidden
              ? { ...gridPosition, visibility: "hidden", overflow: "hidden" }
              : gridPosition}
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
                {/* #208: status dot with activity ring when the
                    agent is running — pulsing ring around the dot
                    signals "agent is working". Idle/stopped/error
                    states omit the ring. */}
                <span className="relative inline-flex items-center justify-center w-2 h-2">
                  {isVerified && isActive(agent.id) && (
                    <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 animate-ping" />
                  )}
                  <span className={`relative w-1.5 h-1.5 rounded-full ${
                    isVerified ? "bg-accent"
                      : agentStates[agent.id] === "error" ? "bg-error"
                      : "bg-text-muted"
                  }`} />
                </span>
                {/* #421 / quadwork#305: active agent's label goes
                    accent + shimmers so the operator has a bigger
                    visual cue than the tiny dot ring. Color-only
                    keyframe (no shadow / background / blur) per
                    the ticket's "minimal aesthetic" constraint. */}
                <span
                  className={`text-[11px] uppercase tracking-wider ${
                    isVerified && isActive(agent.id)
                      ? "text-accent animate-name-shimmer"
                      : "text-text-muted"
                  }`}
                >
                  {agent.label}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <AgentLifecycleControls key={`${projectId}/${agent.id}`} projectId={projectId} agentId={agent.id} status={agentStates[agent.id]} onStatusChange={(state) => onStatusChange?.(agent.id, state)} />
                {isVerified && (
                  <button
                    onClick={async () => {
                      // #968: auth the PTY write
                      const auth = await sessionTokenHeaders();
                      fetch(`/api/agents/${encodeURIComponent(projectId)}/${encodeURIComponent(agent.id)}/write`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", ...auth },
                        body: JSON.stringify({ text: "/compact\n" }),
                      }).catch(() => {});
                    }}
                    className="text-[10px] text-text-muted hover:text-accent transition-colors px-0.5"
                    title="Compact — frees context/memory when agent is stuck"
                  >/c</button>
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
              <TerminalPanel
                projectId={projectId}
                agentId={agent.id}
                generationId={agentGenerations[agent.id] ?? null}
                onActivity={() => markActivity(agent.id)}
              />
            </div>
          </div>
        );
      })}
      {expanded === null && layout.hasVerticalSplit && (
        <div
          role="separator"
          aria-label="Resize terminal columns"
          aria-orientation="vertical"
          tabIndex={0}
          className="z-20 bg-border cursor-col-resize hover:bg-accent-dim focus-visible:bg-accent-dim focus-visible:outline-none"
          style={{ gridColumn: "2", gridRow: layout.fourOrMore ? "1 / 4" : "1" }}
          onMouseDown={() => startDrag("column")}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") { event.preventDefault(); nudgeSplit("column", -0.05); }
            if (event.key === "ArrowRight") { event.preventDefault(); nudgeSplit("column", 0.05); }
          }}
        />
      )}
      {expanded === null && layout.hasHorizontalSplit && (
        <div
          role="separator"
          aria-label="Resize terminal rows"
          aria-orientation="horizontal"
          tabIndex={0}
          className="z-20 bg-border cursor-row-resize hover:bg-accent-dim focus-visible:bg-accent-dim focus-visible:outline-none"
          style={{ gridColumn: "1 / 4", gridRow: "2" }}
          onMouseDown={() => startDrag("row")}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") { event.preventDefault(); nudgeSplit("row", -0.05); }
            if (event.key === "ArrowDown") { event.preventDefault(); nudgeSplit("row", 0.05); }
          }}
        />
      )}
    </div>
  );
}
