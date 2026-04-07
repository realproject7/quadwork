"use client";

import PanelHeader from "./PanelHeader";
import OvernightQueueWidget from "./OvernightQueueWidget";

/**
 * Bottom-right quadrant of the project dashboard (#208).
 *
 * Hosts the operator-only widgets:
 *   - #209 OVERNIGHT-QUEUE.md viewer/editor (this ticket)
 *   - #210 Scheduled Trigger (pending)
 *   - #211 Telegram Bridge (pending)
 */
export default function OperatorFeaturesPanel({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelHeader label="Operator Features" />
      <div className="flex-1 min-h-0 flex flex-col gap-2 p-2 overflow-auto">
        <div className="flex-1 min-h-[200px]">
          <OvernightQueueWidget projectId={projectId} />
        </div>
        <div className="shrink-0 px-3 py-2 border border-dashed border-border text-[10px] text-text-muted">
          Scheduled Trigger (#210) · Telegram Bridge (#211) — coming soon
        </div>
      </div>
    </div>
  );
}
