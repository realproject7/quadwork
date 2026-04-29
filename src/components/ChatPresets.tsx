"use client";

import { useState, useEffect, useCallback } from "react";

export interface Preset {
  id: string;
  title: string;
  message: string;
}

const STORAGE_KEY = "qw-chat-presets";

const DEFAULT_PRESETS: Preset[] = [
  {
    id: "default-1",
    title: "Queue Check — Trigger",
    message: `@head @dev @re1 @re2 – Queue check.
@head: Merge any PR with both approvals, assign next from ~/.quadwork/{{project}}/OVERNIGHT-QUEUE.md.
@dev: Work on assigned ticket or address review feedback.
@re1 & @re2: Review open PRs. If @dev pushed fixes, re-review. Post verdict on PR AND notify @dev here.
ALL: Communicate via this chat by tagging agents. Your terminal is NOT visible.`,
  },
  {
    id: "default-2",
    title: "Suffix Reminder",
    message: `All agents: ignore numeric suffixes in your identity. dev, dev-1, dev-2 are the same Dev agent. re1, re1-2 are the same RE1. re2, re2-2 are the same RE2. head, head-2 are the same Head. When tagging others, use the base name (@dev, @re1, @re2, @head). When checking for mentions to you, match your base role name regardless of suffix.`,
  },
  {
    id: "default-3",
    title: "Check Queue Format",
    message: `@head Check your OVERNIGHT-QUEUE.md formatting. Each Active Batch item must start with \`- #<number>\` (dash, space, hash, issue number). Do NOT use \`- Issue #598\` format — only \`- #598 description\`. The Current Batch panel won't recognize items in any other format. Fix if needed and confirm.`,
  },
  {
    id: "default-4",
    title: "Agent Online Check",
    message: `@head Are you online? If so, ping @dev, @re1, and @re2 to confirm whether they are online and available.`,
  },
];

function loadPresets(): Preset[] {
  if (typeof window === "undefined") return DEFAULT_PRESETS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_PRESETS));
      return DEFAULT_PRESETS;
    }
    return JSON.parse(raw);
  } catch {
    return DEFAULT_PRESETS;
  }
}

function savePresets(presets: Preset[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

interface ChatPresetsProps {
  projectId: string;
  onSend: (message: string) => void;
}

export default function ChatPresets({ projectId, onSend }: ChatPresetsProps) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [editing, setEditing] = useState<Preset | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editMessage, setEditMessage] = useState("");

  useEffect(() => {
    setPresets(loadPresets());
  }, []);

  const persist = useCallback((next: Preset[]) => {
    setPresets(next);
    savePresets(next);
  }, []);

  const handleSend = (preset: Preset) => {
    const msg = preset.message.replace(/\{\{project\}\}/g, projectId);
    onSend(msg);
    setOpen(false);
  };

  const handleDelete = (id: string) => {
    persist(presets.filter((p) => p.id !== id));
  };

  const startEdit = (preset: Preset) => {
    setEditing(preset);
    setEditTitle(preset.title);
    setEditMessage(preset.message);
  };

  const startNew = () => {
    setEditing({ id: "", title: "", message: "" });
    setEditTitle("");
    setEditMessage("");
  };

  const saveEdit = () => {
    if (!editTitle.trim() || !editMessage.trim()) return;
    if (editing && editing.id) {
      persist(
        presets.map((p) =>
          p.id === editing.id ? { ...p, title: editTitle, message: editMessage } : p
        )
      );
    } else {
      persist([...presets, { id: `preset-${Date.now()}`, title: editTitle, message: editMessage }]);
    }
    setEditing(null);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 px-1.5 py-2 text-[10px] text-text-muted hover:text-accent transition-colors"
        title="Message presets"
      >
        Preset
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="shrink-0 px-1.5 py-2 text-[10px] text-accent transition-colors"
        title="Close presets"
      >
        Preset
      </button>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={() => { setOpen(false); setEditing(null); }} />
      {/* Modal */}
      <div className="absolute bottom-full left-0 right-0 mb-1 z-50 border border-border bg-bg-surface max-h-[60vh] overflow-y-auto">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
          <span className="text-[11px] text-text font-semibold">Message Presets</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={startNew}
              className="text-[10px] text-accent hover:underline"
            >
              + New
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); setEditing(null); }}
              className="text-[11px] text-text-muted hover:text-text"
            >
              ✕
            </button>
          </div>
        </div>

        {editing ? (
          <div className="p-3 flex flex-col gap-2">
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Preset title"
              className="w-full bg-transparent border border-border px-2 py-1 text-[11px] text-text outline-none focus:border-accent"
            />
            <textarea
              value={editMessage}
              onChange={(e) => setEditMessage(e.target.value)}
              placeholder="Message body"
              rows={5}
              className="w-full bg-transparent border border-border px-2 py-1 text-[11px] text-text outline-none focus:border-accent resize-y font-mono"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={saveEdit}
                disabled={!editTitle.trim() || !editMessage.trim()}
                className="px-2 py-0.5 text-[10px] text-accent border border-accent/40 hover:bg-accent/10 transition-colors disabled:opacity-30"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="px-2 py-0.5 text-[10px] text-text-muted border border-border hover:text-text transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {presets.length === 0 && (
              <div className="px-3 py-4 text-[11px] text-text-muted text-center">
                No presets. Click &quot;+ New&quot; to create one.
              </div>
            )}
            {presets.map((preset) => (
              <div key={preset.id} className="px-3 py-2 hover:bg-accent/5 group">
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => handleSend(preset)}
                    className="text-left flex-1 min-w-0"
                  >
                    <div className="text-[11px] text-text font-medium truncate">{preset.title}</div>
                    <div className="text-[10px] text-text-muted truncate mt-0.5">
                      {preset.message.slice(0, 80)}{preset.message.length > 80 ? "…" : ""}
                    </div>
                  </button>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => startEdit(preset)}
                      className="text-[10px] text-text-muted hover:text-accent"
                      title="Edit"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(preset.id)}
                      className="text-[10px] text-text-muted hover:text-error"
                      title="Delete"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
