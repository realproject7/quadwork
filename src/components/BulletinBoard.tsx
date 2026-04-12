"use client";

import { useState, useEffect, useCallback } from "react";

interface BulletinReply {
  from: string;
  date: string;
  content: string;
}

interface BulletinPost {
  id: string;
  from_project: string;
  to_project: string;
  from_agent: string;
  date: string;
  status: string;
  content: string;
  replies: BulletinReply[];
}

interface BulletinBoardProps {
  projectId?: string;
  onClose: () => void;
}

export default function BulletinBoard({ projectId, onClose }: BulletinBoardProps) {
  const [posts, setPosts] = useState<BulletinPost[]>([]);
  const [tab, setTab] = useState<"inbox" | "sent" | "all">("all");
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNewPost, setShowNewPost] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [newTo, setNewTo] = useState("");
  const [newContent, setNewContent] = useState("");
  const [error, setError] = useState("");

  const fetchPosts = useCallback(() => {
    const params = new URLSearchParams({ month });
    if (projectId && tab === "inbox") params.set("project", projectId);
    else if (projectId && tab === "sent") params.set("project", projectId);
    fetch(`/api/bulletin?${params}`)
      .then((r) => r.json())
      .then((data) => {
        let filtered = data.posts || [];
        if (projectId && tab === "inbox") {
          filtered = filtered.filter((p: BulletinPost) => p.to_project === projectId);
        } else if (projectId && tab === "sent") {
          filtered = filtered.filter((p: BulletinPost) => p.from_project === projectId);
        }
        setPosts(filtered);
      })
      .catch(() => setPosts([]));
  }, [month, projectId, tab]);

  useEffect(() => { fetchPosts(); }, [fetchPosts]);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => {
        if (data.projects) {
          setProjects(data.projects.map((p: { id: string }) => p.id));
        }
      })
      .catch(() => {});
  }, []);

  const handleCreate = () => {
    if (!projectId || !newTo || !newContent.trim()) return;
    setError("");
    fetch("/api/bulletin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_project: projectId,
        from_agent: "operator",
        to_project: newTo,
        content: newContent.trim(),
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setNewTo("");
          setNewContent("");
          setShowNewPost(false);
          fetchPosts();
        } else {
          setError(data.error || "Failed to create post");
        }
      })
      .catch(() => setError("Network error"));
  };

  const handleStatusToggle = (postId: string, currentStatus: string) => {
    const newStatus = currentStatus === "open" ? "closed" : "open";
    fetch(`/api/bulletin/${postId}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    })
      .then((r) => r.json())
      .then((data) => { if (data.ok) fetchPosts(); })
      .catch(() => {});
  };

  // Month navigation
  const adjustMonth = (delta: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-bg-surface border border-border w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-text uppercase tracking-wider">Bulletin Board</span>
            {projectId && (
              <div className="flex gap-1">
                {(["inbox", "sent", "all"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`text-[10px] px-2 py-0.5 ${tab === t ? "bg-accent/20 text-accent" : "text-text-muted hover:text-text"}`}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {projectId && (
              <button
                onClick={() => setShowNewPost(!showNewPost)}
                className="text-[10px] px-2 py-0.5 text-accent hover:text-text border border-accent/30 hover:border-accent"
              >
                {showNewPost ? "Cancel" : "+ New Post"}
              </button>
            )}
            <button onClick={onClose} className="text-text-muted hover:text-text text-xs px-1">x</button>
          </div>
        </div>

        {/* Month navigation */}
        <div className="flex items-center justify-center gap-3 px-4 py-1.5 border-b border-border/50 text-[10px] text-text-muted">
          <button onClick={() => adjustMonth(-1)} className="hover:text-text">{"<"}</button>
          <span className="text-text tabular-nums">{month}</span>
          <button onClick={() => adjustMonth(1)} className="hover:text-text">{">"}</button>
        </div>

        {/* New post form */}
        {showNewPost && projectId && (
          <div className="px-4 py-2 border-b border-border bg-bg-surface">
            <div className="flex gap-2 mb-2">
              <span className="text-[10px] text-text-muted shrink-0 pt-0.5">To:</span>
              <select
                value={newTo}
                onChange={(e) => setNewTo(e.target.value)}
                className="text-[11px] bg-bg border border-border text-text px-1 py-0.5 flex-1"
              >
                <option value="">Select project...</option>
                {projects.filter((p) => p !== projectId).map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="Message content..."
              className="w-full text-[11px] bg-bg border border-border text-text px-2 py-1 resize-none h-20"
            />
            {error && <div className="text-[10px] text-error mt-1">{error}</div>}
            <div className="flex justify-end mt-1">
              <button
                onClick={handleCreate}
                disabled={!newTo || !newContent.trim()}
                className="text-[10px] px-3 py-0.5 bg-accent text-bg font-semibold hover:bg-accent/80 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Post
              </button>
            </div>
          </div>
        )}

        {/* Posts list */}
        <div className="flex-1 overflow-y-auto">
          {posts.length === 0 && (
            <div className="px-4 py-6 text-[11px] text-text-muted text-center">
              No posts for {month}
            </div>
          )}
          {posts.map((post) => (
            <div key={post.id} className="border-b border-border/50 last:border-b-0">
              <button
                onClick={() => setExpandedId(expandedId === post.id ? null : post.id)}
                className="w-full text-left px-4 py-2 hover:bg-bg/50 flex items-center gap-3"
              >
                <span className="text-[10px] text-accent font-mono shrink-0">{post.id}</span>
                <span className="text-[10px] text-text-muted shrink-0">
                  {post.from_project} {">"} {post.to_project}
                </span>
                <span className="text-[10px] text-text-muted shrink-0 tabular-nums">
                  {post.date?.slice(0, 10)}
                </span>
                <span
                  className={`text-[9px] px-1 py-px shrink-0 ${
                    post.status === "open"
                      ? "bg-accent/15 text-accent"
                      : "bg-text-muted/15 text-text-muted"
                  }`}
                >
                  {post.status}
                </span>
                <span className="text-[10px] text-text truncate min-w-0">
                  {post.content.slice(0, 80)}
                </span>
              </button>

              {expandedId === post.id && (
                <div className="px-4 pb-3 pt-1">
                  <div className="text-[10px] text-text-muted mb-1">
                    From: {post.from_agent} | {post.date}
                  </div>
                  <div className="text-[11px] text-text whitespace-pre-wrap mb-2 bg-bg p-2 border border-border/50">
                    {post.content}
                  </div>

                  {post.replies.length > 0 && (
                    <div className="ml-3 border-l border-border/50 pl-3 mb-2">
                      {post.replies.map((r, i) => (
                        <div key={i} className="mb-2">
                          <div className="text-[9px] text-text-muted">{r.from} | {r.date}</div>
                          <div className="text-[10px] text-text whitespace-pre-wrap">{r.content}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  <button
                    onClick={() => handleStatusToggle(post.id, post.status)}
                    className="text-[9px] text-text-muted hover:text-text border border-border px-2 py-0.5"
                  >
                    Mark as {post.status === "open" ? "closed" : "open"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
