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
  },
  ko: {
    label: "운영자 기능",
    tooltip: (
      <>
        <b>운영자 기능</b> - 야간 자율 배치를 운영할 때 쓰는 도구 모음입니다. Scheduled Trigger, Telegram Bridge, Discord Bridge, Loop Guard, Project History, Agent Models가 포함됩니다.
      </>
    ),
  },
} as const;

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
 *
 * #351: two-column layout at lg+ widths — Scheduled Trigger gets
 * the full-height left column (primary surface during an
 * overnight run so its textarea + Start/Stop button are always
 * reachable without scrolling), while Telegram Bridge → Loop
 * Guard → Project History stack in the right column and scroll
 * independently if the stack exceeds panel height. Below lg the
 * layout collapses back to the single-column stack so nothing
 * clips in cramped split-view / mobile.
 */
export default function OperatorFeaturesPanel({ projectId }: { projectId: string }) {
  const { locale } = useLocale();
  const t = COPY[locale];
  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelHeader label={t.label} tooltip={
        <InfoTooltip>
          {t.tooltip}
        </InfoTooltip>
      } />
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-2 p-2 overflow-auto lg:overflow-hidden">
        {/* Left column: Scheduled Trigger spans full panel height.
            min-w-[280px] at lg+ keeps the message textarea from
            collapsing below a usable width when the panel is
            narrow-but-still-lg. Per #351, the Trigger must remain
            the always-reachable primary surface — no overflow-y
            on this column. The parent lg:overflow-hidden clamps
            any overshoot visually; the right column is the only
            independent scroll container. */}
        <div className="lg:flex-1 lg:min-w-[280px] lg:min-h-0">
          <ScheduledTriggerWidget projectId={projectId} />
        </div>
        {/* Vertical divider between the two columns, only at lg+. */}
        <div className="hidden lg:block w-px self-stretch bg-border" />
        {/* Right column: Telegram Bridge → Loop Guard → Project
            History. Scrolls independently of the left column. */}
        <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto flex flex-col gap-2">
          <AgentModelsWidget projectId={projectId} />
          <TelegramBridgeWidget projectId={projectId} />
          <DiscordBridgeWidget projectId={projectId} />
          <LoopGuardWidget projectId={projectId} />
          <ProjectHistoryWidget projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
