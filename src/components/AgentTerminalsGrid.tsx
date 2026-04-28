"use client";

import { useState } from "react";
import TerminalGrid from "./TerminalGrid";
import { useLocale } from "@/components/LocaleProvider";

const COPY = {
  en: {
    title: "Agent Terminals",
    aboutLabel: "About agent terminals",
    tooltip: (
      <>
        These show what each agent is doing in their CLI session. <b>Do not type here directly</b> — use the AgentChattr chat above instead. Agents won&apos;t see messages typed in their terminals.
      </>
    ),
  },
  ko: {
    title: "에이전트 터미널",
    aboutLabel: "에이전트 터미널 설명",
    tooltip: (
      <>
        각 에이전트가 CLI 세션에서 무엇을 하고 있는지 보여주는 읽기 전용 터미널입니다. <b>여기에 직접 입력하지 마세요.</b> 위의 AgentChattr 채팅을 사용해야 에이전트가 메시지를 볼 수 있습니다.
      </>
    ),
  },
} as const;

// #208: the top-right quadrant must show all four agents
// (Head, RE1, RE2, Dev) as a 2x2 grid. TerminalGrid's
// default agent list only has three entries (RE1, RE2,
// Dev) because it used to live alongside a dedicated Head panel —
// pass the full four-agent list explicitly so Head doesn't get
// dropped when the old Head panel was removed.
//
// #400 / quadwork#265: layout order is Head TL, Dev TR,
// RE1 BL, RE2 BR. TerminalGrid renders tiles in array
// order into a 2x2 row-flow grid (default `grid grid-rows-2
// grid-cols-2`, no `grid-flow-col`), so [head, dev, re1,
// re2] maps to TL, TR, BL, BR. Keep them in sync if you
// reorder this list.
const FOUR_AGENTS = [
  { id: "head", label: "Head" },
  { id: "dev", label: "Dev" },
  { id: "re1", label: "RE1" },
  { id: "re2", label: "RE2" },
];

type AgentState = "running" | "stopped" | "error";

interface AgentTerminalsGridProps {
  projectId: string;
  agentStates: Record<string, AgentState>;
  onStatusChange?: (agent: string, state: string) => void;
}

/**
 * Top-right quadrant of the project dashboard (#208).
 *
 * Wraps the existing TerminalGrid 2x2 with a header and a ? tooltip
 * that tells operators the terminals are read-only status mirrors —
 * real communication happens through the AgentChattr chat panel in
 * the top-left quadrant. Without this hint, users try to type into
 * the terminals and their messages are lost to the other agents.
 */
export default function AgentTerminalsGrid({ projectId, agentStates, onStatusChange }: AgentTerminalsGridProps) {
  const { locale } = useLocale();
  const t = COPY[locale];
  const [tipOpen, setTipOpen] = useState(false);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between h-7 px-3 shrink-0 border-b border-border">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-text-muted uppercase tracking-wider">{t.title}</span>
          <div
            // #399 / quadwork#264: inline-flex+items-center so the
            // (?) button vertically centers with the title text. The
            // previous block-level wrapper let the button drop to its
            // own baseline below the title cap-height.
            className="relative inline-flex items-center"
            onMouseEnter={() => setTipOpen(true)}
            onMouseLeave={() => setTipOpen(false)}
            onFocus={() => setTipOpen(true)}
            onBlur={() => setTipOpen(false)}
          >
            <button
              type="button"
              aria-label={t.aboutLabel}
              className="w-3.5 h-3.5 rounded-full border border-border text-[9px] leading-none text-text-muted hover:text-accent hover:border-accent inline-flex items-center justify-center"
            >?</button>
            {tipOpen && (
              <div
                role="tooltip"
                className="ko-help absolute top-5 left-0 z-20 w-72 max-w-[min(18rem,calc(100vw-2rem))] p-2 text-[11px] leading-snug text-text bg-bg-surface border border-border shadow-lg"
              >
                {t.tooltip}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <TerminalGrid
          projectId={projectId}
          agents={FOUR_AGENTS}
          agentStates={agentStates}
          onStatusChange={onStatusChange}
        />
      </div>
    </div>
  );
}
