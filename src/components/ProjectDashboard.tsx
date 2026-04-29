"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import PanelHeader from "./PanelHeader";
import InfoTooltip from "./InfoTooltip";
import ChatPanel from "./ChatPanel";
import GitHubPanel from "./GitHubPanel";
import ControlBar from "./ControlBar";
import AgentTerminalsGrid from "./AgentTerminalsGrid";
import OperatorFeaturesPanel from "./OperatorFeaturesPanel";
import { useLocale } from "@/components/LocaleProvider";

const MIN_SIZE = 150; // px
const DIVIDER = 4; // px

type AgentState = "running" | "stopped" | "error";

interface ProjectDashboardProps {
  projectId: string;
}

const COPY = {
  en: {
    filterAgentsTitle: "Showing agent messages only — click to show all",
    filterAllTitle: "Showing all messages — click to hide system/status noise",
    filterOn: "Filter system log: on",
    filterOff: "Filter system log: off",
    chatLabel: "AgentChattr — primary chat",
    chatTooltip: (
      <>
        <b>Primary Chat</b> — live chat between you and the 4 AI agents. Messages you type here trigger agent actions. Use @mentions to address specific agents.
      </>
    ),
    githubLabel: "GitHub",
    githubTooltip: (
      <>
        <b>GitHub</b> — open issues and pull requests on this project&apos;s repo. Click any item to open it on GitHub. The batch progress panel tracks the active batch&apos;s lifecycle from queued to merged.
      </>
    ),
  },
  ko: {
    filterAgentsTitle: "에이전트 메시지만 표시 중 - 클릭하면 전체를 표시합니다",
    filterAllTitle: "전체 메시지 표시 중 - 클릭하면 시스템/상태 로그를 숨깁니다",
    filterOn: "시스템 로그 필터: 켜짐",
    filterOff: "시스템 로그 필터: 꺼짐",
    chatLabel: "AgentChattr — 메인 채팅",
    chatTooltip: (
      <>
        <b>메인 채팅</b> - 당신과 4개의 AI 에이전트가 실시간으로 대화하는 공간입니다. 여기 입력한 메시지가 에이전트 동작을 시작시킵니다. 특정 에이전트를 부를 때는 @멘션을 사용하세요.
      </>
    ),
    githubLabel: "GitHub",
    githubTooltip: (
      <>
        <b>GitHub</b> - 이 프로젝트 저장소의 열린 이슈와 PR을 보여줍니다. 항목을 클릭하면 GitHub에서 바로 열립니다. 아래 배치 진행 패널은 현재 배치가 대기에서 병합까지 어떻게 진행되는지 추적합니다.
      </>
    ),
  },
} as const;

export default function ProjectDashboard({ projectId }: ProjectDashboardProps) {
  const { locale } = useLocale();
  const t = COPY[locale];
  const containerRef = useRef<HTMLDivElement>(null);
  const [colRatio, setColRatio] = useState(0.5);
  const [rowRatio, setRowRatio] = useState(0.5);
  const dragging = useRef<"col" | "row" | null>(null);
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({});

  // #523/#525: system message filter — source of truth is the per-project
  // config (bridge_filter_agents_only), so dashboard and bridges stay in sync.
  const [filterSystem, setFilterSystem] = useState(false);
  const filterLoadedRef = useRef(false);
  useEffect(() => {
    filterLoadedRef.current = false;
    setFilterSystem(false);
  }, [projectId]);
  useEffect(() => {
    if (filterLoadedRef.current) return;
    fetch("/api/config")
      .then((r) => r.ok ? r.json() : null)
      .then((cfg) => {
        if (!cfg) return;
        const entry = (cfg.projects || []).find((p: { id: string }) => p.id === projectId);
        if (entry?.bridge_filter_agents_only) setFilterSystem(true);
        filterLoadedRef.current = true;
      })
      .catch(() => {});
  }, [projectId]);
  const toggleFilter = useCallback(() => {
    setFilterSystem((prev) => {
      const next = !prev;
      // #525: persist to project config so bridges respect the filter
      fetch("/api/config")
        .then((r) => r.ok ? r.json() : null)
        .then((cfg) => {
          if (!cfg) return;
          const entry = (cfg.projects || []).find((p: { id: string }) => p.id === projectId);
          if (entry) {
            entry.bridge_filter_agents_only = next;
            return fetch("/api/config", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(cfg),
            });
          }
        })
        .catch(() => {});
      return next;
    });
  }, [projectId]);
  const filterToggle = useMemo(() => (
    <button
      type="button"
      onClick={toggleFilter}
      title={filterSystem ? t.filterAgentsTitle : t.filterAllTitle}
      className={`px-1.5 py-0.5 text-[10px] border transition-colors ${
        filterSystem
          ? "border-accent/50 text-accent bg-accent/10 hover:bg-accent/20"
          : "border-border text-text-muted hover:text-text hover:border-accent"
      }`}
    >
      {filterSystem ? t.filterOn : t.filterOff}
    </button>
  ), [filterSystem, t, toggleFilter]);

  // Poll agent states
  useEffect(() => {
    const poll = () => {
      fetch("/api/agents")
        .then((r) => r.ok ? r.json() : {})
        .then((data) => {
          const states: Record<string, AgentState> = {};
          for (const [key, info] of Object.entries(data)) {
            if (key.startsWith(`${projectId}/`)) {
              const agent = key.split("/")[1];
              states[agent] = (info as { state: string }).state as AgentState;
            }
          }
          setAgentStates(states);
        })
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [projectId]);

  const updateAgentState = (agent: string, state: string) => {
    setAgentStates((prev) => ({ ...prev, [agent]: state as AgentState }));
  };

  const clamp = useCallback(
    (ratio: number, totalPx: number) => {
      // Available space excludes the divider track
      const available = totalPx - DIVIDER;
      const minRatio = MIN_SIZE / totalPx;
      const maxRatio = (available - MIN_SIZE) / totalPx;
      return Math.min(maxRatio, Math.max(minRatio, ratio));
    },
    []
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();

      if (dragging.current === "col") {
        const x = e.clientX - rect.left;
        setColRatio(clamp(x / rect.width, rect.width));
      } else {
        const y = e.clientY - rect.top;
        setRowRatio(clamp(y / rect.height, rect.height));
      }
    };

    const onMouseUp = () => {
      dragging.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [clamp]);

  const startDrag = (axis: "col" | "row") => {
    dragging.current = axis;
    document.body.style.cursor = axis === "col" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  const colTemplate = `${colRatio * 100}% ${DIVIDER}px 1fr`;
  const rowTemplate = `${rowRatio * 100}% ${DIVIDER}px 1fr`;

  return (
    <>
      {/* ── Mobile layout: single scrollable column ── */}
      <div className="flex flex-col w-full h-full overflow-y-auto lg:hidden">
        {/* Chat — primary interface, takes most vertical space */}
        <div className="flex flex-col min-h-[60vh] border-2 border-accent">
          <PanelHeader label={t.chatLabel} tooltip={
            <InfoTooltip>
              {t.chatTooltip}
            </InfoTooltip>
          }>
            {filterToggle}
          </PanelHeader>
          <div className="flex-1 min-h-0">
            <ChatPanel projectId={projectId} filterSystem={filterSystem} />
          </div>
          <ControlBar projectId={projectId} />
        </div>

        {/* Terminals — hidden on mobile (xterm.js doesn't work well on touch) */}

        {/* GitHub panel */}
        <div className="flex flex-col border-t border-border">
          <PanelHeader label={t.githubLabel} tooltip={
            <InfoTooltip>
              {t.githubTooltip}
            </InfoTooltip>
          } />
          <GitHubPanel projectId={projectId} />
        </div>

        {/* Operator Features */}
        <div className="border-t border-border">
          <OperatorFeaturesPanel projectId={projectId} />
        </div>
      </div>

      {/* ── Desktop layout: 2x2 resizable grid (unchanged) ── */}
      <div
        ref={containerRef}
        className="hidden lg:grid w-full h-full"
        style={{
          gridTemplateColumns: colTemplate,
          gridTemplateRows: rowTemplate,
        }}
      >
        {/* Quadrant 1 (top-left): AgentChattr chat */}
        <div className="flex flex-col overflow-hidden border-2 border-accent">
          <PanelHeader label={t.chatLabel} tooltip={
            <InfoTooltip>
              {t.chatTooltip}
            </InfoTooltip>
          }>
            {filterToggle}
          </PanelHeader>
          <div className="flex-1 min-h-0">
            <ChatPanel projectId={projectId} filterSystem={filterSystem} />
          </div>
          <ControlBar projectId={projectId} />
        </div>

        {/* Vertical divider — top segment */}
        <div
          className="bg-border cursor-col-resize hover:bg-accent-dim transition-colors"
          onMouseDown={() => startDrag("col")}
        />

        {/* Quadrant 2 (top-right): Agent terminals */}
        <div className="flex flex-col overflow-hidden">
          <AgentTerminalsGrid
            projectId={projectId}
            agentStates={agentStates}
            onStatusChange={updateAgentState}
          />
        </div>

        {/* Horizontal divider — left segment */}
        <div
          className="bg-border cursor-row-resize hover:bg-accent-dim transition-colors"
          onMouseDown={() => startDrag("row")}
        />

        {/* Horizontal divider — center intersection */}
        <div
          className="bg-border cursor-move"
          onMouseDown={() => startDrag("col")}
        />

        {/* Horizontal divider — right segment */}
        <div
          className="bg-border cursor-row-resize hover:bg-accent-dim transition-colors"
          onMouseDown={() => startDrag("row")}
        />

        {/* Quadrant 3 (bottom-left): GitHub */}
        <div className="flex flex-col overflow-hidden">
          <PanelHeader label={t.githubLabel} tooltip={
            <InfoTooltip>
              {t.githubTooltip}
            </InfoTooltip>
          } />
          <div className="flex-1 min-h-0">
            <GitHubPanel projectId={projectId} />
          </div>
        </div>

        {/* Vertical divider — bottom segment */}
        <div
          className="bg-border cursor-col-resize hover:bg-accent-dim transition-colors"
          onMouseDown={() => startDrag("col")}
        />

        {/* Quadrant 4 (bottom-right): Operator Features */}
        <OperatorFeaturesPanel projectId={projectId} />
      </div>
    </>
  );
}
