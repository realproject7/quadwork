"use client";

import { useState, useEffect } from "react";
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
    <div className="h-full overflow-y-auto lg:overflow-hidden lg:flex lg:flex-col p-6">
      {/* #488: two-column layout at lg+ — hero+projects left, activity right.
          Collapses to current stacked layout below lg. Flex-1 + min-h-0
          lets the grid fill remaining height without a magic calc. */}
      <div className="lg:grid lg:grid-cols-[1fr_340px] lg:gap-6 lg:flex-1 lg:min-h-0">
        {/* Left column: hero + header + project cards */}
        <div className="lg:overflow-y-auto lg:min-h-0">
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

          {/* Header */}
          <div className="mb-6">
            <h1 className="text-lg font-semibold text-text tracking-tight">Projects</h1>
            <p className="text-xs text-text-muted mt-1">
              {projects.length} configured project{projects.length !== 1 ? "s" : ""}
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
        </div>

        {/* Right column: activity feed — scrolls independently on desktop */}
        <div className="lg:overflow-y-auto lg:min-h-0 mb-6 lg:mb-0">
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
                      overflowed re1/re2 into the adjacent
                      message text column. */}
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
