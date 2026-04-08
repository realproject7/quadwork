"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import HomeEmptyState from "./HomeEmptyState";

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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// #430 / quadwork#312: AI team work-hours hero — the marketing
// surface on the home page. Big lifetime-hours number in accent,
// rotating value-focused tagline, three-column time-window footer.
const HERO_TAGLINES = [
  "You've slept easier for",
  "You've gone for runs for",
  "You've enjoyed life for",
  "You've had time for the people you love for",
  "You've touched grass for",
  "You've watched movies for",
  "You've taken vacations for",
  "You've gone on dates for",
  "You've cooked dinner for",
  "You've read books for",
];

interface HeroStats {
  today: number;
  week: number;
  month: number;
  total: number;
}

function heroFmt(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return "0h";
  if (h < 1) return `${(h * 60).toFixed(0)}m`;
  return `${h.toFixed(1)}h`;
}

function ActivityHero() {
  const [stats, setStats] = useState<HeroStats | null>(null);
  const tagline = useMemo(
    () => HERO_TAGLINES[Math.floor(Math.random() * HERO_TAGLINES.length)],
    [],
  );
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/activity/stats")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled && d) setStats(d); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Empty state — fresh install, nothing logged yet.
  if (stats && (!stats.total || stats.total === 0)) {
    return (
      <div className="mb-6 border border-accent/30 bg-accent/5 rounded p-6 text-center">
        <div className="text-[13px] text-text-muted">
          Your AI team hasn&apos;t started shipping yet.
        </div>
        <div className="text-[11px] text-text-muted mt-1">
          Kick off a batch and come back in the morning.
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6 border border-accent/30 bg-accent/5 rounded p-6 text-center">
      <div className="text-[13px] text-text-muted">{tagline}</div>
      <div className="my-3">
        <span className="inline-block px-4 py-1 text-5xl font-mono font-semibold text-accent border border-accent/40 rounded tabular-nums">
          {stats ? heroFmt(stats.total) : "—"}
        </span>
      </div>
      <div className="text-[13px] text-text-muted">
        while your AI team shipped code overnight
      </div>
      <div className="mt-4 flex items-center justify-center gap-4 text-[11px] text-text-muted">
        <span>Today <span className="text-text tabular-nums">{stats ? heroFmt(stats.today) : "—"}</span></span>
        <span className="text-border">│</span>
        <span>This week <span className="text-text tabular-nums">{stats ? heroFmt(stats.week) : "—"}</span></span>
        <span className="text-border">│</span>
        <span>Month <span className="text-text tabular-nums">{stats ? heroFmt(stats.month) : "—"}</span></span>
      </div>
    </div>
  );
}

export default function HomeDashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  // #229: track whether /api/projects has resolved (success OR
  // failure) so the empty-state hero doesn't flash the "no
  // projects" CTA before we actually know. Possible values:
  //   "loading"  — first paint, no answer yet
  //   "loaded"   — fetch resolved successfully
  //   "error"    — fetch failed; preserve last-known projects
  const [projectsState, setProjectsState] = useState<"loading" | "loaded" | "error">("loading");

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (data.projects && Array.isArray(data.projects)) setProjects(data.projects.filter((p: Project & { archived?: boolean }) => !p.archived));
        if (data.recentEvents && Array.isArray(data.recentEvents)) setActivity(data.recentEvents);
        setProjectsState("loaded");
      })
      .catch(() => { setProjectsState("error"); });
  }, []);

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* #229: friendly empty-state hero. Only rendered after
          /api/projects resolves successfully — we don't want to
          flash the "no projects" onboarding CTA to existing users
          while the first fetch is in flight, or when the API
          errored and we have no idea which branch to show. */}
      {projectsState === "loaded" && (
        <div className="mb-6">
          <HomeEmptyState hasProjects={projects.length > 0} />
        </div>
      )}
      {projectsState === "error" && (
        <div className="mb-6 border border-error/30 bg-error/5 text-error text-[11px] px-3 py-2">
          Could not load projects from /api/projects. The dashboard may be out of date — check the server logs and reload.
        </div>
      )}

      {/* #430 / quadwork#312: AI team work hours hero. Rotates the
          value-focused tagline per page load, keeps the lifetime
          number as the headline figure, and mirrors the three time
          windows from the top header stat block. */}
      <ActivityHero />

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-text tracking-tight">Projects</h1>
        <p className="text-xs text-text-muted mt-1">
          {projects.length} configured project{projects.length !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Project cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-8">
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
                open →
              </span>
            </div>

            <div className="flex gap-4 text-[11px] mb-2">
              <div>
                <span className="text-text-muted">agents</span>
                <span className="ml-1.5 text-text">{project.agentCount}</span>
              </div>
              <div>
                <span className="text-text-muted">PRs</span>
                <span className="ml-1.5 text-text">{project.openPrs}</span>
              </div>
              <div>
                <span className="text-text-muted">repo</span>
                <span className="ml-1.5 text-text">{project.repo}</span>
              </div>
            </div>

            {project.lastActivity && (
              <div className="text-[10px] text-text-muted">
                last activity: {timeAgo(project.lastActivity)}
              </div>
            )}
          </Link>
        ))}

        {/* + New Project */}
        <Link
          href="/setup"
          className="border border-dashed border-border p-4 flex items-center justify-center text-text-muted hover:text-text hover:border-text-muted transition-colors min-h-[88px]"
        >
          <span className="text-sm">+ New Project</span>
        </Link>
      </div>

      {/* Activity feed */}
      <div className="mb-6">
        <h2 className="text-xs text-text-muted uppercase tracking-wider mb-3">Recent Activity</h2>
        <div className="border border-border bg-bg-surface">
          {activity.length === 0 && (
            <div className="px-3 py-3 text-[11px] text-text-muted">No recent activity</div>
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
                {/* #420 / quadwork#307: widen column + mirror the
                    RE1/RE2 short labels PR #272 (#263) already uses
                    in the chat sender column. w-6 was 24px and
                    overflowed reviewer1/reviewer2 into the adjacent
                    message text column. */}
                {item.actor === "reviewer1" ? "RE1" : item.actor === "reviewer2" ? "RE2" : item.actor}
              </span>
              <span className="text-text truncate min-w-0">
                {item.text}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
