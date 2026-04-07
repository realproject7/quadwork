"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface OvernightQueueWidgetProps {
  projectId: string;
}

const REFRESH_MS = 10_000;

/**
 * Bottom-right operator widget for OVERNIGHT-QUEUE.md (#209).
 *
 * Default state is read-only plain-text view of the raw markdown
 * (we deliberately skip a markdown renderer dep — the queue file is
 * structured enough that a monospace <pre> is legible and there are
 * no links/images in the template). Polls `GET /api/queue` every 10s
 * so Head agent updates show up without a manual refresh.
 *
 * Edit mode swaps to a textarea with a warning banner reminding
 * the operator that Head owns the file. Save hits `PUT /api/queue`;
 * cancel discards local edits and reloads.
 *
 * Empty-file state (shouldn't happen post-#204) shows a
 * "Create from template" button that hits `POST /api/queue`.
 */
export default function OvernightQueueWidget({ projectId }: OvernightQueueWidgetProps) {
  const [content, setContent] = useState<string>("");
  const [exists, setExists] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editingRef = useRef(false);
  editingRef.current = editing;

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/queue?project=${encodeURIComponent(projectId)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      const data = await r.json();
      setExists(!!data.exists);
      // Don't clobber the draft while the operator is actively editing.
      if (!editingRef.current) setContent(data.content || "");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const onEdit = () => {
    setDraft(content);
    setEditing(true);
  };

  const onCancel = () => {
    setEditing(false);
    setDraft("");
    load();
  };

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/queue?project=${encodeURIComponent(projectId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      setContent(draft);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onCreate = async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/queue?project=${encodeURIComponent(projectId)}`, { method: "POST" });
      if (!r.ok) throw new Error(`${r.status}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 border border-border">
      <div className="flex items-center justify-between h-7 px-3 shrink-0 border-b border-border">
        <span className="text-[11px] text-text-muted uppercase tracking-wider">OVERNIGHT-QUEUE.md</span>
        <div className="flex items-center gap-2">
          {error && <span className="text-[10px] text-error">err: {error}</span>}
          {!editing && exists && (
            <button
              onClick={onEdit}
              className="text-[10px] text-text-muted hover:text-accent uppercase tracking-wider"
            >
              Edit
            </button>
          )}
          {editing && (
            <>
              <button
                onClick={onSave}
                disabled={saving}
                className="text-[10px] text-accent hover:text-accent-dim uppercase tracking-wider disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                onClick={onCancel}
                disabled={saving}
                className="text-[10px] text-text-muted hover:text-text uppercase tracking-wider disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {editing && (
        <div className="shrink-0 px-3 py-1.5 border-b border-border bg-bg-surface text-[10px] text-text-muted leading-snug">
          ⚠️ Editing manually may conflict with the Head agent. Use the chat
          panel to ask Head to update the queue when possible.
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {exists === false ? (
          <div className="p-3 text-[11px] text-text-muted">
            <p className="mb-2">No OVERNIGHT-QUEUE.md for this project yet.</p>
            <button
              onClick={onCreate}
              disabled={saving}
              className="px-2 py-1 border border-border hover:border-accent hover:text-accent text-[11px] disabled:opacity-50"
            >
              Create OVERNIGHT-QUEUE.md from template
            </button>
          </div>
        ) : editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="w-full h-full p-3 bg-bg text-text text-[11px] font-mono resize-none outline-none"
          />
        ) : (
          <pre className="p-3 text-[11px] font-mono whitespace-pre-wrap text-text">{content}</pre>
        )}
      </div>
    </div>
  );
}
