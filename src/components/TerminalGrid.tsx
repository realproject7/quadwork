"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import TerminalPanel from "./TerminalPanel";

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
  onStatusChange?: (agentId: string, state: string) => void;
}

const DEFAULT_AGENTS: Agent[] = [
  { id: "re1", label: "RE1" },
  { id: "re2", label: "RE2" },
  { id: "dev", label: "Dev" },
];

// Border classes per tile. 3-agent legacy layout (re1/re2/dev)
// has a full-width bottom tile; the 4-agent layout used by the new
// #208 top-right quadrant has all four tiles in a 2x2 grid.
const GRID_CLASSES_3 = [
  "border-r border-b border-border", // top-left
  "border-b border-border",          // top-right
  "col-span-2",                      // bottom full-width
];
const GRID_CLASSES_4 = [
  "border-r border-b border-border", // top-left
  "border-b border-border",          // top-right
  "border-r border-border",          // bottom-left
  "",                                // bottom-right
];

export default function TerminalGrid({
  projectId,
  agents = DEFAULT_AGENTS,
  agentStates = {},
  onStatusChange,
}: TerminalGridProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const gridClasses = agents.length >= 4 ? GRID_CLASSES_4 : GRID_CLASSES_3;

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
                : `${gridClasses[i] || ""}`
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
                {/* #208: status dot with activity ring when the
                    agent is running — pulsing ring around the dot
                    signals "agent is working". Idle/stopped/error
                    states omit the ring. */}
                <span className="relative inline-flex items-center justify-center w-2 h-2">
                  {agentStates[agent.id] === "running" && isActive(agent.id) && (
                    <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 animate-ping" />
                  )}
                  <span className={`relative w-1.5 h-1.5 rounded-full ${
                    agentStates[agent.id] === "running" ? "bg-accent"
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
                    agentStates[agent.id] === "running" && isActive(agent.id)
                      ? "text-accent animate-name-shimmer"
                      : "text-text-muted"
                  }`}
                >
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
                onActivity={() => markActivity(agent.id)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
