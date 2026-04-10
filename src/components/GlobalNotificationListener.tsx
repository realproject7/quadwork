"use client";

/**
 * #391: Global notification listener — plays the notification chime for
 * ALL projects with sound enabled, regardless of which page is displayed.
 *
 * Mounted once in the root layout so it survives page navigation. Polls
 * /api/chat per project on a 3s interval (same cadence as ChatPanel).
 * Replaces the per-ChatPanel notification logic to avoid double-play.
 */

import { useEffect, useRef, useCallback } from "react";
import { playNotificationSound } from "../lib/notificationSound";

interface Project {
  id: string;
  agentchattr_url?: string;
}

// How often to re-fetch config to pick up added/removed projects.
const CONFIG_REFRESH_MS = 30_000;

export default function GlobalNotificationListener() {
  // Per-project cursors so we only fire on genuinely new messages.
  const cursorsRef = useRef<Record<string, number>>({});
  // Operator name for filtering self-messages.
  const operatorNameRef = useRef<string>("user");
  // Project list refreshed from config.
  const projectsRef = useRef<Project[]>([]);
  // Whether initial config has loaded (skip polling until we know projects).
  const readyRef = useRef(false);

  // Seed cursor for a single project (best-effort, non-blocking).
  const seedCursor = useCallback((projectId: string) => {
    if (cursorsRef.current[projectId] != null) return; // already seeded
    fetch(`/api/chat?path=/api/messages&channel=general&cursor=0&project=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const msgs: { id: number }[] = Array.isArray(data) ? data : data.messages || [];
        if (msgs.length > 0) {
          cursorsRef.current[projectId] = Math.max(...msgs.map((m) => m.id));
        } else {
          // Mark as seeded with 0 so pollAll doesn't skip it.
          cursorsRef.current[projectId] = 0;
        }
      })
      .catch(() => {});
  }, []);

  // Fetch config to populate/refresh project list + operator name.
  // Seeds cursors for any newly discovered projects.
  const refreshConfig = useCallback(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg) return;
        if (typeof cfg.operator_name === "string" && cfg.operator_name) {
          operatorNameRef.current = cfg.operator_name;
        }
        const projects: Project[] = cfg.projects || [];
        projectsRef.current = projects;
        // Seed cursors for any projects we haven't seen yet.
        for (const p of projects) {
          seedCursor(p.id);
        }
        // Clean up cursors for removed projects.
        const activeIds = new Set(projects.map((p) => p.id));
        for (const id of Object.keys(cursorsRef.current)) {
          if (!activeIds.has(id)) delete cursorsRef.current[id];
        }
        readyRef.current = true;
      })
      .catch(() => {
        // Transient failure — readyRef stays as-is. If this was the
        // first attempt, the next refresh cycle will retry.
      });
  }, [seedCursor]);

  // Initial config fetch + periodic refresh to pick up project changes
  // and recover from transient startup failures.
  useEffect(() => {
    refreshConfig();
    const interval = setInterval(refreshConfig, CONFIG_REFRESH_MS);
    return () => clearInterval(interval);
  }, [refreshConfig]);

  const pollAll = useCallback(() => {
    if (!readyRef.current) return;
    for (const project of projectsRef.current) {
      const cursor = cursorsRef.current[project.id];
      // Skip projects whose cursor hasn't been seeded yet.
      if (cursor == null) continue;
      fetch(
        `/api/chat?path=/api/messages&channel=general&cursor=${cursor}&project=${encodeURIComponent(project.id)}`,
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data) return;
          const msgs: { id: number; sender: string; type?: string }[] = Array.isArray(data)
            ? data
            : data.messages || [];
          if (msgs.length === 0) return;

          const prevCursor = cursorsRef.current[project.id] ?? 0;
          const maxId = Math.max(...msgs.map((m) => m.id));
          if (maxId > prevCursor) cursorsRef.current[project.id] = maxId;

          const opName = operatorNameRef.current;
          const hasNewAgentMessage = msgs.some(
            (m) =>
              m.id > prevCursor &&
              (m.type === undefined || m.type === "chat") &&
              m.sender !== "user" &&
              m.sender !== opName &&
              m.sender !== "system",
          );
          if (hasNewAgentMessage) playNotificationSound();
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    // Small delay on first poll to let config + cursor seeding complete.
    const initial = setTimeout(pollAll, 2000);
    const interval = setInterval(pollAll, 3000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [pollAll]);

  // Invisible — no DOM output.
  return null;
}
