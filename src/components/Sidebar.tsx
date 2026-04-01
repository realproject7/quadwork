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

function ProjectIcon({ project, isActive }: { project: Project; isActive: boolean }) {
  const [tooltip, setTooltip] = useState<{ top: number } | null>(null);
  const ref = useRef<HTMLAnchorElement>(null);

  return (
    <>
      <Link
        ref={ref}
        href={`/project/${project.id}`}
        onMouseEnter={() => {
          const rect = ref.current?.getBoundingClientRect();
          if (rect) setTooltip({ top: rect.top + rect.height / 2 });
        }}
        onMouseLeave={() => setTooltip(null)}
      >
        <div
          className={`w-10 h-10 flex items-center justify-center rounded-full text-xs font-semibold uppercase transition-colors ${
            isActive
              ? "border-2 border-accent text-accent"
              : "border border-border text-text-muted hover:text-text hover:bg-[#1a1a1a]"
          }`}
        >
          {project.name.charAt(0)}
        </div>
      </Link>
      {tooltip && (
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

export default function Sidebar() {
  const pathname = usePathname();
  const [projects, setProjects] = useState<Project[]>([]);
  const [backendStatus, setBackendStatus] = useState<"online" | "offline" | "recovering">("online");

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
    let timeout: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const res = await fetch("/api/health", { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          setBackendStatus((prev) => prev === "offline" ? "recovering" : "online");
        } else {
          setBackendStatus("offline");
        }
      } catch {
        setBackendStatus("offline");
      }
      timeout = setTimeout(check, 5000);
    };
    check();
    return () => clearTimeout(timeout);
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
    <aside className="w-16 shrink-0 h-full border-r border-border bg-bg-surface flex flex-col items-center py-3">
      {/* Home */}
      <Link
        href="/"
        className={`w-10 h-10 flex items-center justify-center rounded-sm transition-colors ${
          isHome
            ? "text-accent"
            : "text-text-muted hover:text-text hover:bg-[#1a1a1a]"
        }`}
        title="Home"
      >
        <HomeIcon />
      </Link>

      {/* Divider */}
      <div className="w-6 h-px bg-border my-2" />

      {/* Projects */}
      <div className="flex-1 flex flex-col items-center gap-2 overflow-y-auto min-h-0">
        {projects.map((project) => {
          const isActive = activeProjectId === project.id;
          return (
            <ProjectIcon
              key={project.id}
              project={project}
              isActive={isActive}
            />
          );
        })}

        {/* Add project */}
        <Link
          href="/setup"
          className="w-10 h-10 flex items-center justify-center rounded-full border border-dashed border-border text-text-muted hover:text-text hover:bg-[#1a1a1a] transition-colors"
          title="Add project"
        >
          <PlusIcon />
        </Link>
      </div>

      {/* Divider */}
      <div className="w-6 h-px bg-border my-2" />

      {/* Backend status indicator */}
      {backendStatus !== "online" && (
        <div className="mb-2 relative group">
          <div
            className={`w-3 h-3 rounded-full ${
              backendStatus === "offline"
                ? "bg-red-500 animate-pulse"
                : "bg-green-500"
            }`}
          />
          <div className="fixed left-16 ml-2 px-2 py-1 bg-bg-surface border border-border text-xs whitespace-nowrap z-50 hidden group-hover:block"
            style={{ transform: "translateY(-50%)", top: "auto" }}
          >
            {backendStatus === "offline"
              ? "Backend offline — run quadwork start"
              : "Backend reconnected"}
          </div>
        </div>
      )}

      {/* Settings */}
      <Link
        href="/settings"
        className={`w-10 h-10 flex items-center justify-center rounded-sm transition-colors ${
          isSettings
            ? "text-accent"
            : "text-text-muted hover:text-text hover:bg-[#1a1a1a]"
        }`}
        title="Settings"
      >
        <GearIcon />
      </Link>
    </aside>
  );
}
