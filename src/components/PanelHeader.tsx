"use client";

import React from "react";
import AgentLifecycleControls from "./AgentLifecycleControls";

/**
 * #1052: vertical collapse contract for a top-level right-rail panel.
 * Presentation-only — toggling never reaches the server.
 */
export interface PanelCollapse {
  expanded: boolean;
  onToggle: () => void;
  /** id of the panel body element, exposed via aria-controls */
  bodyId: string;
  /** localized control text, e.g. "Hide" / "Show" */
  hideLabel: string;
  showLabel: string;
}

interface PanelHeaderProps {
  label: string;
  status?: string;
  projectId?: string;
  agentId?: string;
  onStatusChange?: (newStatus: string) => void;
  /** #407: optional info tooltip element rendered after the label */
  tooltip?: React.ReactNode;
  /** #523: optional right-aligned content (e.g. toggle switches) */
  children?: React.ReactNode;
  /** #1052: when set, renders the Hide/Show control; tooltip + children are
   *  only rendered while expanded so a collapsed header is title + Show only. */
  collapse?: PanelCollapse;
}

export default function PanelHeader({ label, status, projectId, agentId, onStatusChange, tooltip, children, collapse }: PanelHeaderProps) {
  const dotColor =
    status === "running" || status === "verified"
      ? "bg-accent"
      : status === "error"
        ? "bg-error"
        : "bg-text-muted";

  const expanded = collapse ? collapse.expanded : true;

  return (
    <div className="flex items-center justify-between gap-2 px-3 h-7 shrink-0 border-b border-border">
      <div className="flex items-center gap-2">
        {status && (
          <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        )}
        <span className="text-[11px] text-text-muted uppercase tracking-wider">
          {label}
        </span>
        {expanded && tooltip}
      </div>
      <div className="flex items-center gap-1.5">
        {expanded && children}
        {projectId && agentId && (
          <AgentLifecycleControls key={`${projectId}/${agentId}`} projectId={projectId} agentId={agentId} status={status} onStatusChange={onStatusChange} />
        )}
        {collapse && (
          // #1052: ≥24x24 hit target inside the 28px header, 12px text/chevron.
          // Show uses the accent token; Hide stays muted with the usual hover.
          <button
            type="button"
            onClick={collapse.onToggle}
            aria-expanded={expanded}
            aria-controls={collapse.bodyId}
            aria-label={`${expanded ? collapse.hideLabel : collapse.showLabel} ${label}`}
            className={`inline-flex items-center gap-1 min-w-6 min-h-6 px-1 text-xs leading-none transition-colors ${
              expanded ? "text-text-muted hover:text-text" : "text-accent hover:text-accent-dim"
            }`}
          >
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
            {expanded ? collapse.hideLabel : collapse.showLabel}
          </button>
        )}
      </div>
    </div>
  );
}
