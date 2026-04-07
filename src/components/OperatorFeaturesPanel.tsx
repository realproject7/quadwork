"use client";

import PanelHeader from "./PanelHeader";

/**
 * Bottom-right quadrant of the project dashboard (#208).
 *
 * Placeholder container for the Operator Features panel. Sub-tickets
 * #209 (OVERNIGHT-QUEUE.md viewer), #210 (Scheduled Trigger widget),
 * and #211 (Telegram Bridge widget) will fill the body.
 */
export default function OperatorFeaturesPanel(_props: { projectId: string }) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelHeader label="Operator Features" />
      <div className="flex-1 min-h-0 overflow-auto p-3 text-[11px] text-text-muted">
        <ul className="space-y-1">
          <li>• OVERNIGHT-QUEUE.md viewer <span className="text-text-muted/70">(#209)</span></li>
          <li>• Scheduled Trigger <span className="text-text-muted/70">(#210)</span></li>
          <li>• Telegram Bridge <span className="text-text-muted/70">(#211)</span></li>
        </ul>
      </div>
    </div>
  );
}
