"use client";

import { useEffect, useRef, useState } from "react";
import PanelHeader from "./PanelHeader";
import InfoTooltip from "./InfoTooltip";
import ScheduledTriggerWidget from "./ScheduledTriggerWidget";
import TelegramBridgeWidget from "./TelegramBridgeWidget";
import DiscordBridgeWidget from "./DiscordBridgeWidget";
import LoopGuardWidget from "./LoopGuardWidget";
import ProjectHistoryWidget from "./ProjectHistoryWidget";
import AgentModelsWidget from "./AgentModelsWidget";
import { useLocale } from "@/components/LocaleProvider";

const COPY = {
  en: {
    label: "Operator Features",
    tooltip: (
      <>
        <b>Operator Features</b> — tools for running autonomous overnight batches. Includes the Scheduled Trigger, Telegram Bridge, Discord Bridge, Loop Guard, Project History, and Agent Models.
      </>
    ),
    hide: "Hide",
    show: "Show",
  },
  ko: {
    label: "운영자 기능",
    tooltip: (
      <>
        <b>운영자 기능</b> - 야간 자율 배치를 운영할 때 쓰는 도구 모음입니다. Scheduled Trigger, Telegram Bridge, Discord Bridge, Loop Guard, Project History, Agent Models가 포함됩니다.
      </>
    ),
    hide: "접기",
    show: "펼치기",
  },
} as const;

interface OperatorFeaturesPanelProps {
  projectId: string;
  idle?: boolean;
  /** #1052: vertical collapse state is owned by ProjectDashboard (persisted per project). */
  expanded: boolean;
  onToggle: () => void;
  bodyId: string;
}

/**
 * Bottom panel of the project dashboard's right rail (#208, #1052).
 *
 * Hosts the operator-only widgets:
 *   - #210 Scheduled Trigger
 *   - #211 Telegram Bridge
 *
 * #226: OVERNIGHT-QUEUE.md viewer/editor moved to a compact row at
 * the bottom of the GitHub panel (the middle right-rail panel) — click
 * Edit there to open the modal.
 *
 * #351: two-column layout once this panel itself is wide enough (#1198:
 * measured via ResizeObserver on its own rendered width, not a viewport
 * breakpoint — see TWO_COLUMN_MIN_WIDTH below) — Scheduled Trigger gets
 * the full-height left column (primary surface during an overnight run
 * so its textarea + Start/Stop button are always reachable without
 * scrolling), while Telegram Bridge → Loop Guard → Project History stack
 * in the right column and scroll independently if the stack exceeds
 * panel height. Below that width the layout stays a single-column stack
 * so nothing clips in a narrow rail or on mobile.
 *
 * #1052: collapsing hides the widget body (display:none) — widgets stay
 * mounted, so Project Monitor, bridges, and batch execution are untouched.
 */

// #1198: the two-column split used to key off the `lg` viewport breakpoint,
// so a rail dragged down to its own 340px minimum (viewport still ≥1024px)
// kept trying to fit a 280px-min left column plus this row's gap/divider/
// padding (33px) into ~324px — squeezing the right column to a sliver.
// This threshold instead gates on the panel's OWN rendered width (measured
// below), so the split only engages once there's room for both columns'
// minimums (280 + 240 + 33 ≈ 553, plus a small margin); at the rail floor,
// or wherever else this panel is this narrow, it stacks instead, full
// width, nothing clipped.
//
// Measured via ResizeObserver rather than a CSS container query
// (`@container`, the pattern PanelHeader.tsx uses). This panel wraps
// full-viewport `fixed inset-0` modals (AgentModelsWidget's Configure
// dialog, the Telegram/Discord setup modals) that expect the viewport as
// their containing block. `container-type` doesn't actually force layout
// containment in current browsers — MDN documented it as also creating a
// containing block for fixed/absolute descendants, which the CSSWG
// clarified was wrong; the correction has shipped in Chrome, Firefox and
// Safari (mdn/content#43405) — so that's not a live bug today. Using
// ResizeObserver instead just means this split never has to depend on
// that containing-block question at all, on this or any other browser
// version.
const TWO_COLUMN_MIN_WIDTH = 560;

export default function OperatorFeaturesPanel({ projectId, idle = false, expanded, onToggle, bodyId }: OperatorFeaturesPanelProps) {
  const { locale } = useLocale();
  const t = COPY[locale];
  const rootRef = useRef<HTMLDivElement>(null);
  const [twoColumn, setTwoColumn] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setTwoColumn(width >= TWO_COLUMN_MIN_WIDTH);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="flex flex-col h-full min-h-0">
      <PanelHeader
        label={t.label}
        collapse={{ expanded, onToggle, bodyId, hideLabel: t.hide, showLabel: t.show }}
        tooltip={
          <InfoTooltip>
            {t.tooltip}
          </InfoTooltip>
        }
      />
      <div
        id={bodyId}
        className={
          expanded
            ? `flex-1 min-h-0 flex gap-2 p-2 overflow-auto ${twoColumn ? "flex-row overflow-hidden" : "flex-col"}`
            : "hidden"
        }
      >
        {/* Left column: Scheduled Trigger spans full panel height.
            min-w-[280px] keeps the message textarea from collapsing
            below a usable width once two-column engages. Per #351, the
            Trigger must remain the always-reachable primary surface —
            no overflow-y on this column. The parent's matching
            overflow-hidden clamps any overshoot visually; the right
            column is the only independent scroll container. */}
        <div className={twoColumn ? "flex-1 min-w-[280px] min-h-0" : ""}>
          <ScheduledTriggerWidget projectId={projectId} idle={idle} />
        </div>
        {/* Vertical divider between the two columns, only once two-column engages. */}
        <div className={twoColumn ? "block w-px self-stretch bg-border" : "hidden"} />
        {/* Right column: Telegram Bridge → Loop Guard → Project
            History. Scrolls independently of the left column.
            min-w-[240px] mirrors the left column's floor so neither
            side can be squeezed once two-column engages. */}
        <div className={`flex flex-col gap-2 ${twoColumn ? "flex-1 min-h-0 min-w-[240px] overflow-y-auto" : ""}`}>
          <AgentModelsWidget projectId={projectId} />
          <TelegramBridgeWidget projectId={projectId} idle={idle} />
          <DiscordBridgeWidget projectId={projectId} idle={idle} />
          <LoopGuardWidget projectId={projectId} />
          <ProjectHistoryWidget projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
