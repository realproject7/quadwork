"use client";

import TerminalPanel from "./TerminalPanel";
import TerminalGrid from "./TerminalGrid";
import PanelHeader from "./PanelHeader";

interface ProjectDashboardProps {
  projectId: string;
}

export default function ProjectDashboard({ projectId }: ProjectDashboardProps) {
  return (
    <div className="w-full h-full grid grid-cols-2 grid-rows-2">
      {/* Panel 1: T1 terminal — top-left, full left column height */}
      <div className="row-span-2 border-r border-border flex flex-col">
        <PanelHeader label="T1" status="running" />
        <div className="flex-1 min-h-0">
          <TerminalPanel projectId={projectId} agentId="t1" />
        </div>
      </div>

      {/* Panel 2: placeholder — top-right */}
      <div className="border-b border-border flex flex-col">
        <PanelHeader label="Panel 2" />
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <span className="text-xs text-text-muted">GitHub — coming in #9</span>
        </div>
      </div>

      {/* Panel 3: placeholder — bottom-left (occupied by Panel 1 row-span) */}
      {/* Panel 4: Agent terminals — bottom-right */}
      <div className="flex flex-col">
        <PanelHeader label="Panel 4" />
        <div className="flex-1 min-h-0">
          <TerminalGrid projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
