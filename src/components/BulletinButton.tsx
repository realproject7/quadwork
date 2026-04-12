"use client";

import { useState, useEffect, useCallback } from "react";
import InfoTooltip from "./InfoTooltip";
import BulletinBoard from "./BulletinBoard";

const REFRESH_MS = 30000;

export default function BulletinButton({ projectId }: { projectId: string }) {
  const [inboxCount, setInboxCount] = useState(0);
  const [open, setOpen] = useState(false);

  const fetchCount = useCallback(() => {
    const month = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    })();
    fetch(`/api/bulletin?month=${month}&project=${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((data) => {
        const posts = data.posts || [];
        const inbox = posts.filter(
          (p: { to_project: string; status: string }) =>
            p.to_project === projectId && p.status === "open"
        );
        setInboxCount(inbox.length);
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    fetchCount();
    const iv = setInterval(fetchCount, REFRESH_MS);
    return () => clearInterval(iv);
  }, [fetchCount]);

  return (
    <>
      <div className="border border-border bg-bg-surface">
        <div className="flex items-center justify-between px-3 h-7 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-text-muted uppercase tracking-wider">
              Bulletin Board
            </span>
            <InfoTooltip>
              <b>Bulletin Board</b> — a shared message board for cross-project
              coordination. Agents from any project can post updates that agents
              in other projects can read. Use post IDs (e.g. QW-0042) to
              reference specific messages when instructing agents.
            </InfoTooltip>
          </div>
          {inboxCount > 0 && (
            <span className="text-[9px] bg-accent/20 text-accent px-1.5 py-px">
              {inboxCount} open
            </span>
          )}
        </div>
        <div className="px-3 py-2">
          <button
            onClick={() => setOpen(true)}
            className="text-[10px] text-accent hover:text-text transition-colors"
          >
            View Bulletin {"\u2192"}
          </button>
        </div>
      </div>

      {open && (
        <BulletinBoard
          projectId={projectId}
          onClose={() => { setOpen(false); fetchCount(); }}
        />
      )}
    </>
  );
}
