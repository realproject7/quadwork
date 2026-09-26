"use client";

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
 * a container query on its own rendered width, not a viewport breakpoint —
 * see the body div below) — Scheduled Trigger gets the full-height left
 * column (primary surface during an overnight run so its textarea +
 * Start/Stop button are always reachable without scrolling), while
 * Telegram Bridge → Loop Guard → Project History stack in the right
 * column and scroll independently if the stack exceeds panel height.
 * Below that width the layout stays a single-column stack so nothing
 * clips in a narrow rail or on mobile.
 *
 * #1052: collapsing hides the widget body (display:none) — widgets stay
 * mounted, so Project Monitor, bridges, and batch execution are untouched.
 */
export default function OperatorFeaturesPanel({ projectId, idle = false, expanded, onToggle, bodyId }: OperatorFeaturesPanelProps) {
  const { locale } = useLocale();
  const t = COPY[locale];
  return (
    <div className="flex flex-col h-full min-h-0 @container/operator-features">
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
        className={expanded ? "flex-1 min-h-0 flex flex-col @[560px]/operator-features:flex-row gap-2 p-2 overflow-auto @[560px]/operator-features:overflow-hidden" : "hidden"}
      >
        {/* #1198: the two-column split used to key off the `lg` viewport
            breakpoint, so a rail dragged down to its own 340px minimum
            (viewport still ≥1024px) kept trying to fit a 280px-min left
            column plus this row's gap/divider/padding (33px) into ~324px
            — squeezing the right column to a sliver. A container query
            keyed to this panel's own rendered width (not the viewport)
            means the split only engages once there's room for both
            columns' minimums below, regardless of viewport size; at the
            rail floor it stacks instead, full width, nothing clipped. */}
        {/* Left column: Scheduled Trigger spans full panel height.
            min-w-[280px] keeps the message textarea from collapsing
            below a usable width once two-column engages. Per #351, the
            Trigger must remain the always-reachable primary surface —
            no overflow-y on this column. The parent's matching
            overflow-hidden clamps any overshoot visually; the right
            column is the only independent scroll container. */}
        <div className="@[560px]/operator-features:flex-1 @[560px]/operator-features:min-w-[280px] @[560px]/operator-features:min-h-0">
          <ScheduledTriggerWidget projectId={projectId} idle={idle} />
        </div>
        {/* Vertical divider between the two columns, only once two-column engages. */}
        <div className="hidden @[560px]/operator-features:block w-px self-stretch bg-border" />
        {/* Right column: Telegram Bridge → Loop Guard → Project
            History. Scrolls independently of the left column.
            min-w-[240px] mirrors the left column's floor so neither
            side can be squeezed once two-column engages. */}
        <div className="@[560px]/operator-features:flex-1 @[560px]/operator-features:min-h-0 @[560px]/operator-features:min-w-[240px] @[560px]/operator-features:overflow-y-auto flex flex-col gap-2">
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
