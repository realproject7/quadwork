"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import PanelHeader from "./PanelHeader";
import InfoTooltip from "./InfoTooltip";
import ChatPanel from "./ChatPanel";
import GitHubPanel from "./GitHubPanel";
import GitHubRateLimitBadge from "./GitHubRateLimitBadge";
import ControlBar from "./ControlBar";
import AgentTerminalsGrid from "./AgentTerminalsGrid";
import OperatorFeaturesPanel from "./OperatorFeaturesPanel";
import { useLocale } from "@/components/LocaleProvider";
import { onIdleChange } from "@/lib/idle";
import {
  DEFAULT_PANEL_VISIBILITY,
  LEGACY_TERMINALS_COLLAPSED_KEY,
  panelVisibilityKey,
  resolvePanelVisibility,
  serializePanelVisibility,
} from "@/lib/panelVisibility";

const MIN_SIZE = 150; // px
const DIVIDER = 4; // px

type AgentState = "running" | "stopped" | "error";
type PanelVisibility = ReturnType<typeof resolvePanelVisibility>;
type PanelId = keyof PanelVisibility;

interface ProjectDashboardProps {
  projectId: string;
}

const COPY = {
  en: {
    filterAgentsTitle: "Showing agent messages only — click to show all",
    filterAllTitle: "Showing all messages — click to hide system/status noise",
    filterOn: "Filter system log: on",
    filterOff: "Filter system log: off",
    chatLabel: "Agent Primary Chat",
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
    hide: "Hide",
    show: "Show",
  },
  ko: {
    filterAgentsTitle: "에이전트 메시지만 표시 중 - 클릭하면 전체를 표시합니다",
    filterAllTitle: "전체 메시지 표시 중 - 클릭하면 시스템/상태 로그를 숨깁니다",
    filterOn: "시스템 로그 필터: 켜짐",
    filterOff: "시스템 로그 필터: 꺼짐",
    chatLabel: "에이전트 메인 채팅",
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
    hide: "접기",
    show: "펼치기",
  },
} as const;

export default function ProjectDashboard({ projectId }: ProjectDashboardProps) {
  const { locale } = useLocale();
  const t = COPY[locale];
  const containerRef = useRef<HTMLDivElement>(null);
  const [colRatio, setColRatio] = useState(0.5);
  const dragging = useRef(false);
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({});

  // #1052: right-rail panel visibility (expanded booleans), persisted
  // browser-locally per project. Presentation-only: toggling never touches
  // the server, the column ratio, or any batch/monitor/agent lifecycle.
  // Defaults render first; the saved preference (and the #668 legacy
  // terminals key) is applied after mount, and storage is written only on
  // an explicit toggle — never on first render.
  const [panels, setPanels] = useState<PanelVisibility>(DEFAULT_PANEL_VISIBILITY);
  useEffect(() => {
    let saved: string | null = null;
    let legacy: string | null = null;
    try {
      saved = localStorage.getItem(panelVisibilityKey(projectId));
      legacy = localStorage.getItem(LEGACY_TERMINALS_COLLAPSED_KEY);
    } catch { /* localStorage unavailable — keep defaults */ }
    setPanels(resolvePanelVisibility(saved, legacy));
  }, [projectId]);
  const togglePanel = useCallback((id: PanelId) => {
    const next = { ...panels, [id]: !panels[id] };
    setPanels(next);
    try { localStorage.setItem(panelVisibilityKey(projectId), serializePanelVisibility(next)); } catch {}
  }, [panels, projectId]);
  const bodyId = (id: PanelId) => `qw-panel-${id}-${encodeURIComponent(projectId)}`;

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
      // #525/#971: persist to project config (field-scoped, no whole-config clobber)
      // so bridges respect the filter.
      fetch(`/api/projects/${encodeURIComponent(projectId)}/flags`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bridge_filter_agents_only: next }),
      }).catch(() => {});
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

  // #812: per-project Idle toggle. Source of truth is the project config
  // (project.idle). When idle, the server suspends all GitHub polling /
  // triggers / bridge auto-lifecycle for this project, and the dashboard
  // stops its own batch-progress pollers. Agent terminals stay viewable.
  // #814: the Active/Inactive control moved to the sidebar / settings. The
  // dashboard no longer owns the toggle — it loads idle from config on mount
  // and reacts to the shared idle signal so its pollers start/stop live when
  // the operator flips the switch elsewhere (no manual reload).
  const [idle, setIdle] = useState(false);
  // #1031: a project with two registered repositories renders GitHub rows
  // with their repository key so the same number in both never looks alike.
  const [multiRepository, setMultiRepository] = useState(false);
  const idleLoadedRef = useRef(false);
  // #826: a live idle signal that arrives while the initial /api/config read is
  // in flight is AUTHORITATIVE — the operator just toggled the switch, so the
  // (possibly stale) config result must not overwrite it back. Tracked per
  // mount/project and reset alongside idleLoadedRef.
  const idleSignalRef = useRef(false);
  useEffect(() => {
    idleLoadedRef.current = false;
    idleSignalRef.current = false;
    setIdle(false);
    setMultiRepository(false);
  }, [projectId]);
  useEffect(() => {
    if (idleLoadedRef.current) return;
    // #826: guard against this read resolving after the project changed (a
    // stale read from the prior project would otherwise set idle here).
    let cancelled = false;
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cancelled || !cfg) return;
        idleLoadedRef.current = true;
        const entry = (cfg.projects || []).find((p: { id: string }) => p.id === projectId) as
          { idle?: boolean; repositories?: unknown[] } | undefined;
        setMultiRepository(Array.isArray(entry?.repositories) && entry.repositories.length > 1);
        // A live signal already set the authoritative value — don't clobber it.
        if (idleSignalRef.current) return;
        setIdle(!!entry?.idle);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);
  useEffect(() => onIdleChange(({ projectId: pid, idle: next }) => {
    if (pid === projectId) {
      idleSignalRef.current = true;
      setIdle(next);
    }
  }), [projectId]);

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

  // #1052: one resizable vertical divider between the two columns. The old
  // horizontal (row) divider and rowRatio are gone with the 2x2 grid.
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      setColRatio(clamp(x / rect.width, rect.width));
    };

    const onMouseUp = () => {
      dragging.current = false;
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

  const startDrag = () => {
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const colTemplate = `${colRatio * 100}% ${DIVIDER}px 1fr`;

  // On mobile (<lg): flex column layout, scrollable. Terminals + divider hidden;
  // GitHub and Operator Features stack below Primary Chat and stay collapsible.
  // On desktop (lg+): two-column CSS grid — Primary Chat fills the left column,
  // the right column is a vertical flex rail (Agent Terminals → GitHub →
  // Operator Features) with one resizable vertical divider (#1052).
  // Components are rendered ONCE — layout switching is pure CSS via a scoped
  // media query that overrides the flex-col to a grid at lg+ breakpoint.
  return (
    <div ref={containerRef} className="w-full h-full">
      <style>{`
        @media (min-width: 1024px) {
          .qw-dashboard {
            display: grid !important;
            grid-template-columns: ${colTemplate};
            grid-template-rows: minmax(0, 1fr);
            overflow: hidden !important;
          }
        }
      `}</style>
      <div className="qw-dashboard flex flex-col w-full h-full overflow-y-auto">
        {/* Left column: Agent primary chat */}
        <div className="flex flex-col overflow-hidden border-2 border-accent h-[60vh] shrink-0 lg:h-auto lg:shrink lg:min-h-0">
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
          <ControlBar projectId={projectId} idle={idle} />
        </div>

        {/* Vertical divider (desktop only) */}
        <div
          className="hidden lg:block bg-border cursor-col-resize hover:bg-accent-dim transition-colors"
          onMouseDown={startDrag}
        />

        {/* Right rail: every expanded panel shares the remaining height
            equally (flex-1 min-h-0, own internal scrolling); a collapsed
            panel keeps only its 28px header. Collapse never changes the
            rail width or the column ratio. */}
        <div className="flex flex-col lg:min-h-0 lg:overflow-hidden">
          {/* Agent terminals — hidden on mobile (xterm.js + touch) */}
          <div className={`hidden lg:flex flex-col overflow-hidden ${panels.terminals ? "lg:flex-1 lg:min-h-0" : "shrink-0"}`}>
            <AgentTerminalsGrid
              projectId={projectId}
              agentStates={agentStates}
              onStatusChange={updateAgentState}
              expanded={panels.terminals}
              onToggle={() => togglePanel("terminals")}
              bodyId={bodyId("terminals")}
            />
          </div>

          {/* GitHub panel — Issues, Pull Requests, Current Batch, OVERNIGHT-QUEUE.md */}
          <div className={`flex flex-col overflow-hidden border-t border-border ${panels.github ? "min-h-[40vh] shrink-0 lg:min-h-0 lg:shrink lg:flex-1" : "shrink-0"}`}>
            <PanelHeader
              label={t.githubLabel}
              collapse={{ expanded: panels.github, onToggle: () => togglePanel("github"), bodyId: bodyId("github"), hideLabel: t.hide, showLabel: t.show }}
              tooltip={
                <InfoTooltip>
                  {t.githubTooltip}
                </InfoTooltip>
              }
            >
              {/* #866: always-on rate-limit status badge, top-right of the GITHUB header */}
              {/* #893: pass projectId so the reviewer budget resolves per project */}
              <GitHubRateLimitBadge projectId={projectId} />
            </PanelHeader>
            {/* Body stays mounted while hidden so Current Batch state and list
                scroll positions survive collapse/show; no lifecycle changes. */}
            <div id={bodyId("github")} className={panels.github ? "flex-1 min-h-0" : "hidden"}>
              <GitHubPanel projectId={projectId} idle={idle} multiRepository={multiRepository} />
            </div>
          </div>

          {/* Operator Features */}
          <div className={`flex flex-col overflow-hidden border-t border-border ${panels.operator ? "lg:flex-1 lg:min-h-0" : "shrink-0"}`}>
            <OperatorFeaturesPanel
              projectId={projectId}
              idle={idle}
              expanded={panels.operator}
              onToggle={() => togglePanel("operator")}
              bodyId={bodyId("operator")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
