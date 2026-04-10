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

export default function GlobalNotificationListener() {
  // Per-project cursors so we only fire on genuinely new messages.
  const cursorsRef = useRef<Record<string, number>>({});
  // Operator name for filtering self-messages.
  const operatorNameRef = useRef<string>("user");
  // Project list refreshed from config.
  const projectsRef = useRef<Project[]>([]);
  // Whether initial config has loaded (skip polling until we know projects).
  const readyRef = useRef(false);

  // Fetch config once to populate project list + operator name, then
  // seed per-project cursors so the first genuinely new message chimes
  // instead of being swallowed by the "initial backfill" guard.
  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then(async (cfg) => {
        if (!cfg) return;
        if (typeof cfg.operator_name === "string" && cfg.operator_name) {
          operatorNameRef.current = cfg.operator_name;
        }
        const projects: Project[] = cfg.projects || [];
        projectsRef.current = projects;
        // Seed cursors: fetch current max message id per project so
        // the polling loop treats everything already present as "seen".
        await Promise.all(
          projects.map((p) =>
            fetch(`/api/chat?path=/api/messages&channel=general&cursor=0&project=${encodeURIComponent(p.id)}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((data) => {
                if (!data) return;
                const msgs: { id: number }[] = Array.isArray(data) ? data : data.messages || [];
                if (msgs.length > 0) {
                  cursorsRef.current[p.id] = Math.max(...msgs.map((m) => m.id));
                }
              })
              .catch(() => {}),
          ),
        );
        readyRef.current = true;
      })
      .catch(() => {});
  }, []);

  const pollAll = useCallback(() => {
    if (!readyRef.current) return;
    for (const project of projectsRef.current) {
      const cursor = cursorsRef.current[project.id] ?? 0;
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
    // Small delay on first poll to let config load.
    const initial = setTimeout(pollAll, 1500);
    const interval = setInterval(pollAll, 3000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [pollAll]);

  // Invisible — no DOM output.
  return null;
}
