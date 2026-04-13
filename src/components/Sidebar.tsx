"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

interface Project {
  id: string;
  name: string;
}

function HomeIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 10L10 3l7 7" />
      <path d="M5 8.5V16h3.5v-4h3v4H15V8.5" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="9" cy="9" r="2.5" />
      <path d="M7.5 1.5h3l.4 2.1a5.5 5.5 0 011.3.7l2-.8 1.5 2.6-1.6 1.3a5.5 5.5 0 010 1.5l1.6 1.3-1.5 2.6-2-.8a5.5 5.5 0 01-1.3.7l-.4 2.1h-3l-.4-2.1a5.5 5.5 0 01-1.3-.7l-2 .8-1.5-2.6 1.6-1.3a5.5 5.5 0 010-1.5L2.3 6.1l1.5-2.6 2 .8a5.5 5.5 0 011.3-.7z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 3L5 8l5 5" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

function ProjectIcon({ project, isActive, expanded }: { project: Project; isActive: boolean; expanded: boolean }) {
  const [tooltip, setTooltip] = useState<{ top: number } | null>(null);
  const ref = useRef<HTMLAnchorElement>(null);

  return (
    <>
      <Link
        ref={ref}
        href={`/project/${project.id}`}
        className={`flex items-center gap-2 ${expanded ? "w-full px-2" : ""} rounded-sm transition-colors ${
          !expanded ? "" : isActive ? "bg-[#1a1a1a]" : "hover:bg-[#1a1a1a]"
        }`}
        onMouseEnter={() => {
          if (expanded) return;
          const rect = ref.current?.getBoundingClientRect();
          if (rect) setTooltip({ top: rect.top + rect.height / 2 });
        }}
        onMouseLeave={() => setTooltip(null)}
      >
        <div
          className={`w-10 h-10 shrink-0 flex items-center justify-center rounded-full text-[11px] font-semibold uppercase tracking-tight transition-colors ${
            isActive
              ? "border-2 border-accent text-accent"
              : "border border-border text-text-muted hover:text-text"
          }`}
        >
          {project.name.slice(0, 2) || "?"}
        </div>
        {expanded && (
          <span className={`text-xs truncate ${isActive ? "text-accent" : "text-text-muted"}`}>
            {project.name}
          </span>
        )}
      </Link>
      {!expanded && tooltip && (
        <div
          className="fixed px-2 py-1 bg-bg-surface border border-border text-text text-xs whitespace-nowrap pointer-events-none z-50"
          style={{ left: 72, top: tooltip.top, transform: "translateY(-50%)" }}
        >
          {project.name}
        </div>
      )}
    </>
  );
}

const SIDEBAR_KEY = "qw-sidebar-expanded";

export default function Sidebar() {
  const pathname = usePathname();
  const [projects, setProjects] = useState<Project[]>([]);
  const [backendStatus, setBackendStatus] = useState<"online" | "offline" | "recovering">("online");
  const [expanded, setExpanded] = useState(false);

  // Restore persisted state on mount — only on desktop-width screens
  useEffect(() => {
    try {
      if (window.innerWidth >= 768) {
        const stored = localStorage.getItem(SIDEBAR_KEY);
        if (stored === "true") setExpanded(true);
      }
    } catch {}
  }, []);

  // Force-collapse on small screens when viewport resizes
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => { if (e.matches) setExpanded(false); };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_KEY, String(next)); } catch {}
      return next;
    });
  };

  useEffect(() => {
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw new Error(`Config fetch failed: ${r.status}`);
        return r.json();
      })
      .then((cfg) => setProjects((cfg.projects || []).filter((p: Project & { archived?: boolean }) => !p.archived)))
      .catch(() => {});
  }, []);

  // Health check poll every 5 seconds
  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const res = await fetch("/api/health", { signal: AbortSignal.timeout(3000) });
        if (cancelled) return;
        if (res.ok) {
          setBackendStatus((prev) => prev === "offline" ? "recovering" : "online");
        } else {
          setBackendStatus("offline");
        }
      } catch {
        if (cancelled) return;
        setBackendStatus("offline");
      }
      if (!cancelled) timeout = setTimeout(check, 5000);
    };
    check();
    return () => { cancelled = true; clearTimeout(timeout); };
  }, []);

  // Clear "recovering" state after brief flash
  useEffect(() => {
    if (backendStatus === "recovering") {
      const t = setTimeout(() => setBackendStatus("online"), 1500);
      return () => clearTimeout(t);
    }
  }, [backendStatus]);

  const isHome = pathname === "/";
  const isSettings = pathname === "/settings";
  const activeProjectId = pathname.startsWith("/project/")
    ? pathname.split("/")[2]
    : null;

  return (
    <aside
      className={`shrink-0 h-full border-r border-border bg-bg-surface flex flex-col py-3 transition-[width] duration-200 ease-in-out overflow-hidden ${
        expanded ? "w-52 items-stretch px-2" : "w-16 items-center"
      }`}
    >
      {/* Toggle — hidden on mobile */}
      <button
        onClick={toggleExpanded}
        className={`hidden md:flex shrink-0 items-center justify-center w-8 h-8 rounded-sm text-text-muted hover:text-text hover:bg-[#1a1a1a] transition-colors ${
          expanded ? "self-end mr-0" : "self-center"
        }`}
        title={expanded ? "Collapse sidebar" : "Expand sidebar"}
      >
        {expanded ? <CollapseIcon /> : <ExpandIcon />}
      </button>

      <div className="h-1" />

      {/* Home */}
      <Link
        href="/"
        className={`flex items-center gap-2 rounded-sm transition-colors ${
          expanded ? "px-2 py-2" : "w-10 h-10 justify-center self-center"
        } ${
          isHome
            ? "text-accent"
            : "text-text-muted hover:text-text hover:bg-[#1a1a1a]"
        }`}
        title="Home"
      >
        <HomeIcon />
        {expanded && <span className="text-xs">Home</span>}
      </Link>

      {/* Divider */}
      <div className={`h-px bg-border my-2 ${expanded ? "" : "w-6 self-center"}`} />

      {/* Projects */}
      <div className={`flex-1 flex flex-col gap-2 overflow-y-auto min-h-0 ${expanded ? "" : "items-center"}`}>
        {projects.map((project) => {
          const isActive = activeProjectId === project.id;
          return (
            <ProjectIcon
              key={project.id}
              project={project}
              isActive={isActive}
              expanded={expanded}
            />
          );
        })}

        {/* Add project */}
        <Link
          href="/setup"
          className={`flex items-center gap-2 rounded-full transition-colors ${
            expanded
              ? "px-2 py-2 border border-dashed border-border text-text-muted hover:text-text hover:bg-[#1a1a1a] rounded-sm"
              : "w-10 h-10 justify-center border border-dashed border-border text-text-muted hover:text-text hover:bg-[#1a1a1a]"
          }`}
          title="Add project"
        >
          <PlusIcon />
          {expanded && <span className="text-xs text-text-muted">New Project</span>}
        </Link>
      </div>

      {/* Divider */}
      <div className={`h-px bg-border my-2 ${expanded ? "" : "w-6 self-center"}`} />

      {/* Backend status indicator */}
      {backendStatus !== "online" && (
        <div className={`mb-2 relative group ${expanded ? "px-2" : "self-center"}`}>
          <div className="flex items-center gap-2">
            <div
              className={`w-3 h-3 shrink-0 rounded-full ${
                backendStatus === "offline"
                  ? "bg-red-500 animate-pulse"
                  : "bg-green-500"
              }`}
            />
            {expanded && (
              <span className="text-xs text-text-muted">
                {backendStatus === "offline" ? "Backend offline" : "Reconnected"}
              </span>
            )}
          </div>
          {!expanded && (
            <div className="fixed left-16 ml-2 px-2 py-1 bg-bg-surface border border-border text-xs whitespace-nowrap z-50 hidden group-hover:block"
              style={{ transform: "translateY(-50%)", top: "auto" }}
            >
              {backendStatus === "offline"
                ? "Backend offline — run quadwork start"
                : "Backend reconnected"}
            </div>
          )}
        </div>
      )}

      {/* Settings */}
      <Link
        href="/settings"
        className={`flex items-center gap-2 rounded-sm transition-colors ${
          expanded ? "px-2 py-2" : "w-10 h-10 justify-center self-center"
        } ${
          isSettings
            ? "text-accent"
            : "text-text-muted hover:text-text hover:bg-[#1a1a1a]"
        }`}
        title="Settings"
      >
        <GearIcon />
        {expanded && <span className="text-xs">Settings</span>}
      </Link>
    </aside>
  );
}
