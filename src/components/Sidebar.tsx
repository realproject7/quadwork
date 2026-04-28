"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

interface Project {
  id: string;
  name: string;
}

interface SidebarGroup {
  name: string;
  projects: string[];
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

function ChevronDownIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform duration-150 ${collapsed ? "-rotate-90" : ""}`}
    >
      <path d="M3 4.5l3 3 3-3" />
    </svg>
  );
}

function PinIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" stroke="none">
      <path d="M10.5 1.5L14.5 5.5L10 7.5L8.5 12.5L3.5 7.5L8.5 6L10.5 1.5Z" />
      <path d="M3.5 7.5L1 15L8.5 12.5" />
    </svg>
  );
}

interface ProjectIconProps {
  project: Project;
  isActive: boolean;
  expanded: boolean;
  pinned: boolean;
  onContextMenu: (e: React.MouseEvent, projectId: string) => void;
}

function ProjectIcon({ project, isActive, expanded, pinned, onContextMenu }: ProjectIconProps) {
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
        onContextMenu={(e) => onContextMenu(e, project.id)}
      >
        <div className="relative shrink-0">
          <div
            className={`w-10 h-10 flex items-center justify-center rounded-full text-[11px] font-semibold uppercase tracking-tight transition-colors ${
              isActive
                ? "border-2 border-accent text-accent"
                : "border border-border text-text-muted hover:text-text"
            }`}
          >
            {project.name.slice(0, 2) || "?"}
          </div>
          {pinned && !expanded && (
            <div className="absolute -top-1 -right-1 text-accent">
              <PinIcon size={8} />
            </div>
          )}
        </div>
        {expanded && (
          <span className={`text-xs truncate flex items-center gap-1 ${isActive ? "text-accent" : "text-text-muted"}`}>
            {project.name}
            {pinned && <PinIcon size={10} />}
          </span>
        )}
      </Link>
      {!expanded && tooltip && (
        <div
          className="fixed px-2 py-1 bg-bg-surface border border-border text-text text-xs whitespace-nowrap pointer-events-none z-50"
          style={{ left: 72, top: tooltip.top, transform: "translateY(-50%)" }}
        >
          {pinned && "📌 "}{project.name}
        </div>
      )}
    </>
  );
}

const SIDEBAR_KEY = "qw-sidebar-expanded";
const GROUP_COLLAPSE_KEY = "qw-sidebar-collapsed-groups";

interface ContextMenu {
  x: number;
  y: number;
  projectId: string;
  showGroupMenu?: boolean;
}

export default function Sidebar() {
  const pathname = usePathname();
  const [projects, setProjects] = useState<Project[]>([]);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [groups, setGroups] = useState<SidebarGroup[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [backendStatus, setBackendStatus] = useState<"online" | "offline" | "recovering">("online");
  const [expanded, setExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [version, setVersion] = useState<string>("");
  const configRef = useRef<Record<string, unknown> | null>(null);

  // Restore persisted state on mount — only on desktop-width screens
  useEffect(() => {
    try {
      if (window.innerWidth >= 768) {
        const stored = localStorage.getItem(SIDEBAR_KEY);
        if (stored === "true") setExpanded(true);
      }
      const storedGroups = localStorage.getItem(GROUP_COLLAPSE_KEY);
      if (storedGroups) setCollapsedGroups(new Set(JSON.parse(storedGroups)));
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
    fetch("/api/version")
      .then((r) => r.json())
      .then((d) => setVersion(d.version || ""))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw new Error(`Config fetch failed: ${r.status}`);
        return r.json();
      })
      .then((cfg) => {
        configRef.current = cfg;
        setProjects((cfg.projects || []).filter((p: Project & { archived?: boolean }) => !p.archived));
        setPinnedIds(cfg.pinned_projects || []);
        setGroups(cfg.sidebar_groups || []);
      })
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

  const persistPins = useCallback((newPins: string[]) => {
    setPinnedIds(newPins);
    // Re-read latest config before writing to avoid clobbering concurrent changes
    fetch("/api/config")
      .then((r) => r.json())
      .then((latest) => {
        const updated = { ...latest, pinned_projects: newPins };
        configRef.current = updated;
        return fetch("/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updated),
        });
      })
      .catch(() => {});
  }, []);

  const toggleGroupCollapse = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      try { localStorage.setItem(GROUP_COLLAPSE_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  const persistGroups = useCallback((newGroups: SidebarGroup[]) => {
    setGroups(newGroups);
    fetch("/api/config")
      .then((r) => r.json())
      .then((latest) => {
        const updated = { ...latest, sidebar_groups: newGroups };
        configRef.current = updated;
        return fetch("/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updated),
        });
      })
      .catch(() => {});
  }, []);

  const moveToGroup = (projectId: string, groupName: string) => {
    const newGroups = groups.map((g) => ({
      ...g,
      projects: g.projects.filter((id) => id !== projectId),
    }));
    if (groupName === "__ungrouped__") {
      persistGroups(newGroups.filter((g) => g.projects.length > 0));
    } else {
      const target = newGroups.find((g) => g.name === groupName);
      if (target) {
        target.projects.push(projectId);
      } else {
        newGroups.push({ name: groupName, projects: [projectId] });
      }
      persistGroups(newGroups.filter((g) => g.projects.length > 0));
    }
    setContextMenu(null);
  };

  const handlePin = (projectId: string) => {
    if (pinnedIds.includes(projectId)) return;
    persistPins([projectId, ...pinnedIds]);
    setContextMenu(null);
  };

  const handleUnpin = (projectId: string) => {
    persistPins(pinnedIds.filter((id) => id !== projectId));
    setContextMenu(null);
  };

  const handleContextMenu = (e: React.MouseEvent, projectId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, projectId });
  };

  // Close context menu on click anywhere
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  // Sort projects: pinned first (in pin order), then grouped, then ungrouped
  const pinnedSet = new Set(pinnedIds);
  const pinnedProjects = pinnedIds
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is Project => !!p);

  const groupedIds = new Set(groups.flatMap((g) => g.projects));
  const unpinnedProjects = projects.filter((p) => !pinnedSet.has(p.id));
  const ungroupedProjects = unpinnedProjects.filter((p) => !groupedIds.has(p.id));

  return (
    <aside
      className={`shrink-0 h-full border-r border-border bg-bg-surface flex flex-col py-3 transition-[width] duration-200 ease-in-out overflow-hidden ${
        expanded ? "w-52 items-stretch px-2" : "w-16 items-center"
      }`}
    >
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
        {/* Pinned group */}
        {pinnedProjects.length > 0 && (
          <>
            {expanded && (
              <span className="text-[10px] uppercase tracking-widest text-text-muted px-2">Pinned</span>
            )}
            {pinnedProjects.map((project) => (
              <ProjectIcon
                key={project.id}
                project={project}
                isActive={activeProjectId === project.id}
                expanded={expanded}
                pinned
                onContextMenu={handleContextMenu}
              />
            ))}
            <div className={`h-px bg-border ${expanded ? "" : "w-6"}`} />
          </>
        )}

        {/* Grouped projects */}
        {groups.map((group) => {
          const groupProjects = group.projects
            .map((id) => unpinnedProjects.find((p) => p.id === id))
            .filter((p): p is Project => !!p);
          if (groupProjects.length === 0) return null;
          const isCollapsed = collapsedGroups.has(group.name);
          return (
            <div key={group.name} className="flex flex-col gap-1">
              {/* Group header */}
              <button
                onClick={() => toggleGroupCollapse(group.name)}
                className={`flex items-center gap-1 text-text-muted hover:text-text transition-colors ${
                  expanded ? "px-2 py-0.5" : "justify-center w-full"
                }`}
                title={`${isCollapsed ? "Expand" : "Collapse"} ${group.name}`}
              >
                {expanded ? (
                  <>
                    <ChevronDownIcon collapsed={isCollapsed} />
                    <span className="text-[10px] uppercase tracking-widest truncate">{group.name}</span>
                  </>
                ) : (
                  <div className={`w-6 h-px ${isCollapsed ? "bg-text-muted" : "bg-border"}`} />
                )}
              </button>
              {/* Group children */}
              {!isCollapsed && groupProjects.map((project) => (
                <ProjectIcon
                  key={project.id}
                  project={project}
                  isActive={activeProjectId === project.id}
                  expanded={expanded}
                  pinned={false}
                  onContextMenu={handleContextMenu}
                />
              ))}
            </div>
          );
        })}

        {/* Ungrouped projects */}
        {ungroupedProjects.length > 0 && groups.length > 0 && (
          <>
            {expanded && (
              <span className="text-[10px] uppercase tracking-widest text-text-muted px-2">Ungrouped</span>
            )}
            {groups.length > 0 && !expanded && (
              <div className="w-6 h-px bg-border" />
            )}
          </>
        )}
        {ungroupedProjects.map((project) => (
          <ProjectIcon
            key={project.id}
            project={project}
            isActive={activeProjectId === project.id}
            expanded={expanded}
            pinned={false}
            onContextMenu={handleContextMenu}
          />
        ))}

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

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed bg-bg-surface border border-border py-1 z-50 text-xs"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {pinnedSet.has(contextMenu.projectId) ? (
            <button
              className="w-full px-3 py-1.5 text-left text-text hover:bg-[#1a1a1a] transition-colors"
              onClick={() => handleUnpin(contextMenu.projectId)}
            >
              Unpin
            </button>
          ) : (
            <button
              className="w-full px-3 py-1.5 text-left text-text hover:bg-[#1a1a1a] transition-colors"
              onClick={() => handlePin(contextMenu.projectId)}
            >
              Pin to top
            </button>
          )}
          <div className="h-px bg-border my-1" />
          {!contextMenu.showGroupMenu ? (
            <button
              className="w-full px-3 py-1.5 text-left text-text hover:bg-[#1a1a1a] transition-colors"
              onClick={() => setContextMenu({ ...contextMenu, showGroupMenu: true })}
            >
              Move to group...
            </button>
          ) : (
            <div className="flex flex-col">
              {groups.map((g) => (
                <button
                  key={g.name}
                  className="w-full px-3 py-1.5 text-left text-text hover:bg-[#1a1a1a] transition-colors"
                  onClick={() => moveToGroup(contextMenu.projectId, g.name)}
                >
                  {g.name}
                </button>
              ))}
              <button
                className="w-full px-3 py-1.5 text-left text-text hover:bg-[#1a1a1a] transition-colors"
                onClick={() => {
                  const name = prompt("New group name:");
                  if (!name?.trim()) return;
                  const trimmed = name.trim();
                  if (groups.some((g) => g.name.toLowerCase() === trimmed.toLowerCase())) {
                    alert(`Group "${trimmed}" already exists.`);
                    return;
                  }
                  moveToGroup(contextMenu.projectId, trimmed);
                }}
              >
                + New group
              </button>
              {groupedIds.has(contextMenu.projectId) && (
                <button
                  className="w-full px-3 py-1.5 text-left text-text-muted hover:bg-[#1a1a1a] transition-colors"
                  onClick={() => moveToGroup(contextMenu.projectId, "__ungrouped__")}
                >
                  Remove from group
                </button>
              )}
            </div>
          )}
        </div>
      )}

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

      {/* #524: expand/collapse toggle — moved to bottom, larger + bordered */}
      <button
        onClick={toggleExpanded}
        className={`flex shrink-0 items-center justify-center w-10 h-10 rounded-sm border border-border text-text-muted hover:text-accent hover:border-accent/50 transition-colors ${
          expanded ? "self-end" : "self-center"
        }`}
        title={expanded ? "Collapse sidebar" : "Expand sidebar"}
      >
        {expanded ? <CollapseIcon /> : <ExpandIcon />}
      </button>

      <div className="h-1" />

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

      {version && (
        <div className={`text-[10px] text-text-muted/40 ${expanded ? "px-3" : "text-center"} pt-2`}>
          v{version}
        </div>
      )}
    </aside>
  );
}
