"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import TerminalPanel from "./TerminalPanel";
import TerminalGrid from "./TerminalGrid";
import PanelHeader from "./PanelHeader";

const MIN_SIZE = 150; // px
const DIVIDER = 4; // px

interface ProjectDashboardProps {
  projectId: string;
}

export default function ProjectDashboard({ projectId }: ProjectDashboardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Ratios: 0–1, where colRatio is left column width fraction, rowRatio is top row height fraction
  const [colRatio, setColRatio] = useState(0.5);
  const [rowRatio, setRowRatio] = useState(0.5);
  const dragging = useRef<"col" | "row" | null>(null);

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
      {/* Panel 1: T1 Terminal — top-left */}
      <div className="flex flex-col overflow-hidden">
        <PanelHeader label="T1" status="running" />
        <div className="flex-1 min-h-0">
          <TerminalPanel projectId={projectId} agentId="t1" />
        </div>
      </div>

      {/* Vertical divider — top segment */}
      <div
        className="bg-border cursor-col-resize hover:bg-accent-dim transition-colors"
        onMouseDown={() => startDrag("col")}
      />

      {/* Panel 2: GitHub placeholder — top-right */}
      <div className="flex flex-col overflow-hidden">
        <PanelHeader label="Panel 2" />
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <span className="text-xs text-text-muted">GitHub — #9</span>
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

      {/* Panel 3: Chat placeholder — bottom-left */}
      <div className="flex flex-col overflow-hidden">
        <PanelHeader label="Panel 3" />
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <span className="text-xs text-text-muted">Chat — #8</span>
        </div>
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
          <TerminalGrid projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
