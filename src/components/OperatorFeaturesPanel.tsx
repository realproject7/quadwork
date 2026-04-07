"use client";

import PanelHeader from "./PanelHeader";
import ScheduledTriggerWidget from "./ScheduledTriggerWidget";
import TelegramBridgeWidget from "./TelegramBridgeWidget";

/**
 * Bottom-right quadrant of the project dashboard (#208).
 *
 * Hosts the operator-only widgets:
 *   - #210 Scheduled Trigger
 *   - #211 Telegram Bridge
 *
 * #226: OVERNIGHT-QUEUE.md viewer/editor moved to a compact row at
 * the bottom of the GitHub panel (bottom-left quadrant) — click Edit
 * there to open the modal.
 */
export default function OperatorFeaturesPanel({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelHeader label="Operator Features" />
      <div className="flex-1 min-h-0 flex flex-col gap-2 p-2 overflow-auto">
        <ScheduledTriggerWidget projectId={projectId} />
        <TelegramBridgeWidget projectId={projectId} />
      </div>
    </div>
  );
}
