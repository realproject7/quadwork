"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import HomeEmptyState from "./HomeEmptyState";
import { useLocale } from "@/components/LocaleProvider";

const COPY = {
  en: {
    loading: "Loading dashboard...",
    recentProjects: "Recent Projects",
    lastModified: "Last modified",
    justNow: "just now",
    minsAgo: (mins: number) => `${mins}m ago`,
    hoursAgo: (hours: number) => `${hours}h ago`,
    daysAgo: (days: number) => `${days}d ago`,
    newProject: "New Project",
    globalFeed: "Global Activity Feed",
    noActivity: "No recent activity.",
    projects: "Projects",
    configuredProjects: (n: number) => `${n} configured project${n !== 1 ? "s" : ""}`,
    agents: "agents",
    prs: "PRs",
    repo: "repo",
    lastActivity: "last activity",
    open: "open →",
    loadError: "Could not load projects from /api/projects. The dashboard may be out of date — check the server logs and reload.",
    joinCommunity: "Want to talk with the creator?",
    joinLink: "Join Hunt Town",
    joinSuffix: "and find @project7.",
    recentActivity: "Recent Activity",
  },
  ko: {
    loading: "대시보드 로딩 중...",
    recentProjects: "최근 프로젝트",
    lastModified: "마지막 수정",
    justNow: "방금 전",
    minsAgo: (mins: number) => `${mins}분 전`,
    hoursAgo: (hours: number) => `${hours}시간 전`,
    daysAgo: (days: number) => `${days}일 전`,
    newProject: "새 프로젝트",
    globalFeed: "전체 활동 피드",
    noActivity: "최근 활동이 없습니다.",
    projects: "프로젝트",
    configuredProjects: (n: number) => `${n}개의 프로젝트`,
    agents: "에이전트",
    prs: "PR",
    repo: "저장소",
    lastActivity: "마지막 활동",
    open: "열기 →",
    loadError: "/api/projects에서 프로젝트를 불러올 수 없습니다. 서버 로그를 확인하고 새로고침하세요.",
    joinCommunity: "제작자와 대화하고 싶으신가요?",
    joinLink: "Hunt Town 참여",
    joinSuffix: "에서 @project7을 찾아보세요.",
    recentActivity: "최근 활동",
  },
} as const;

interface Project {
  id: string;
  name: string;
  repo: string;
  agentCount: number;
  openPrs: number;
  state: "active" | "idle";
  lastActivity: string | null;
}

interface ActivityEvent {
  time: string;
  text: string;
  actor: string;
  projectName: string;
}

function timeAgo(iso: string, t: typeof COPY["en"] | typeof COPY["ko"]): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t.justNow;
  if (mins < 60) return t.minsAgo(mins);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t.hoursAgo(hours);
  const days = Math.floor(hours / 24);
  return t.daysAgo(days);
}

/**
 * Main landing page (#208).
 *
 * Shows the "Recent Projects" grid + a global feed of activity
 * from all projects. If no projects exist, renders the
 * HomeEmptyState hero instead.
 */
export default function HomeDashboard() {
  const { locale } = useLocale();
  const t = COPY[locale];
  const [projects, setProjects] = useState<Project[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [projectsState, setProjectsState] = useState<"loading" | "loaded" | "error">("loading");

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (data.projects && Array.isArray(data.projects))
          setProjects(data.projects.filter((p: Project & { archived?: boolean }) => !p.archived));
        if (data.recentEvents && Array.isArray(data.recentEvents))
          setActivity(data.recentEvents);
        setProjectsState("loaded");
      })
      .catch(() => {
        setProjectsState("error");
      });
  }, []);

  if (projectsState === "loading") {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-[11px] animate-pulse">
        {t.loading}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto lg:overflow-hidden lg:flex lg:flex-col p-6">
      <div className="lg:grid lg:grid-cols-[1fr_340px] lg:gap-6 lg:flex-1 lg:min-h-0">
        {/* Left column: hero + header + project cards */}
        <div className="lg:overflow-y-auto lg:min-h-0">
          {projectsState === "loaded" && (
            <div className="mb-6">
              <HomeEmptyState hasProjects={projects.length > 0} />
            </div>
          )}
          {projectsState === "error" && (
            <div className="mb-6 border border-error/30 bg-error/5 text-error text-[11px] px-3 py-2">
              {t.loadError}
            </div>
          )}

          {/* Header */}
          <div className="mb-6">
            <h1 className="text-lg font-semibold text-text tracking-tight">{t.projects}</h1>
            <p className="text-xs text-text-muted mt-1">
              {t.configuredProjects(projects.length)}
            </p>
          </div>

          {/* Project cards grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-8 lg:mb-0">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/project/${project.id}`}
                className="block border border-border bg-bg-surface p-4 hover:bg-[#1a1a1a] transition-colors group"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        project.state === "active" ? "bg-accent" : "bg-text-muted"
                      }`}
                    />
                    <span className="text-sm font-semibold text-text">{project.name}</span>
                    <span className="text-[10px] text-text-muted">
                      {project.state}
                    </span>
                  </div>
                  <span className="text-[10px] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
                    {t.open}
                  </span>
                </div>

                <div className="flex gap-4 text-[11px] mb-2">
                  <div>
                    <span className="text-text-muted">{t.agents}</span>
                    <span className="ml-1.5 text-text">{project.agentCount}</span>
                  </div>
                  <div>
                    <span className="text-text-muted">{t.prs}</span>
                    <span className="ml-1.5 text-text">{project.openPrs}</span>
                  </div>
                  <div>
                    <span className="text-text-muted">{t.repo}</span>
                    <span className="ml-1.5 text-text">{project.repo}</span>
                  </div>
                </div>

                {project.lastActivity && (
                  <div className="text-[10px] text-text-muted">
                    {t.lastActivity}: {timeAgo(project.lastActivity, t)}
                  </div>
                )}
              </Link>
            ))}

            {/* + New Project */}
            <Link
              href="/setup"
              className="border border-dashed border-border p-4 flex items-center justify-center text-text-muted hover:text-text hover:border-text-muted transition-colors min-h-[88px]"
            >
              <span className="text-sm">+ {t.newProject}</span>
            </Link>
          </div>

          {/* #507: subtle Discord community link */}
          <div className="mt-4 mb-8 lg:mb-4 text-[11px] text-text-muted">
            {t.joinCommunity}{" "}
            <a
              href="https://discord.gg/syhbYPk3Wq"
              target="_blank"
              rel="noopener noreferrer"
              className="text-text hover:text-accent transition-colors"
            >
              {t.joinLink}
            </a>{" "}
            {t.joinSuffix}
          </div>
        </div>

        {/* Right column: activity feed */}
        <div className="lg:overflow-y-auto lg:min-h-0 mb-6 lg:mb-0">
          <h2 className="text-xs text-text-muted uppercase tracking-wider mb-3">{t.recentActivity}</h2>
          <div className="border border-border bg-bg-surface">
            {activity.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-text-muted">{t.noActivity}</div>
            )}
            {activity.map((item, i) => (
              <div
                key={`${item.time}-${i}`}
                className="flex gap-3 px-3 py-1.5 border-b border-border/50 last:border-b-0 text-[11px]"
              >
                <span className="text-text-muted shrink-0 w-10 text-right tabular-nums">
                  {item.time?.slice(0, 5) || ""}
                </span>
                <span className="text-accent shrink-0 font-semibold w-12">
                  {item.projectName}
                </span>
                <span className="text-[#ffcc00] shrink-0 font-semibold w-12">
                  {item.actor}
                </span>
                <span className="text-text truncate min-w-0">
                  {item.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
