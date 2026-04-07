"use client";

import PanelHeader from "./PanelHeader";
import OvernightQueueWidget from "./OvernightQueueWidget";
import ScheduledTriggerWidget from "./ScheduledTriggerWidget";

/**
 * Bottom-right quadrant of the project dashboard (#208).
 *
 * Hosts the operator-only widgets:
 *   - #209 OVERNIGHT-QUEUE.md viewer/editor
 *   - #210 Scheduled Trigger (this ticket)
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
        <ScheduledTriggerWidget projectId={projectId} />
        <div className="shrink-0 px-3 py-2 border border-dashed border-border text-[10px] text-text-muted">
          Telegram Bridge (#211) — coming soon
        </div>
      </div>
    </div>
  );
}
