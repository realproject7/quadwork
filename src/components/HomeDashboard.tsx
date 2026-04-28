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
  },
} as const;

interface Project {
  id: string;
  name: string;
  repo: string;
  modifiedAt: string;
}

interface FeedItem {
  id: string;
  projectId: string;
  projectName: string;
  agent: string;
  text: string;
  timestamp: string;
}

function formatRelative(timestamp: string, t: typeof COPY["en"] | typeof COPY["ko"]): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (mins < 1) return t.justNow;
  if (mins < 60) return t.minsAgo(mins);
  if (hours < 24) return t.hoursAgo(hours);
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
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/config").then((r) => r.json()),
      fetch("/api/feed").then((r) => r.json()),
    ])
      .then(([cfg, feedData]) => {
        if (cfg?.projects) {
          const sorted = [...cfg.projects].sort(
            (a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
          );
          setProjects(sorted);
        }
        if (Array.isArray(feedData)) {
          setFeed(feedData.slice(0, 20));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-[11px] animate-pulse">
        {t.loading}
      </div>
    );
  }

  if (projects.length === 0) {
    return <HomeEmptyState hasProjects={false} />;
  }

  return (
    <div className="p-8 h-full overflow-y-auto space-y-10">
      {/* 1. Projects Grid */}
      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
            {t.recentProjects}
          </h2>
          <Link
            href="/setup"
            className="text-[11px] text-accent hover:underline underline-offset-2"
          >
            + {t.newProject}
          </Link>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/project/${p.id}`}
              className="group block p-4 border border-border bg-bg-surface hover:border-accent transition-colors"
            >
              <h3 className="text-sm font-semibold text-text group-hover:text-accent transition-colors">
                {p.name}
              </h3>
              <p className="text-[10px] text-text-muted mt-1 font-mono truncate">
                {p.repo}
              </p>
              <div className="mt-4 flex items-center justify-between text-[10px] text-text-muted uppercase tracking-tighter">
                <span>{t.lastModified}</span>
                <span className="tabular-nums">{formatRelative(p.modifiedAt, t)}</span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* 2. Global Feed (#208 Quadrant 3 influence) */}
      <div className="border-t border-border/40 pt-10 grid grid-cols-1 lg:grid-cols-3 gap-10">
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
            {t.globalFeed}
          </h2>
          <div className="space-y-1">
            {feed.length === 0 && (
              <p className="text-[11px] text-text-muted italic">{t.noActivity}</p>
            )}
            {feed.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-3 py-2 border-b border-border/20 text-[11px] font-mono group"
              >
                <span className="text-text-muted tabular-nums shrink-0">
                  {formatRelative(item.timestamp, t)}
                </span>
                <Link
                  href={`/project/${item.projectId}`}
                  className="text-accent shrink-0 hover:underline"
                >
                  [{item.projectName}]
                </Link>
                <span className="text-text-muted shrink-0 lowercase">
                  {item.agent}:
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
