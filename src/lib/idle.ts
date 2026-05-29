// #814: shared per-project Active/Inactive (idle) state. The source of truth is
// `project.idle` in config (#812). Toggling persists via PUT /api/config — the
// server's syncTriggers hook stops a now-idle project's trigger — and broadcasts
// a lightweight in-tab signal so every open view (the dashboard's pollers, the
// sidebar switch, the settings switch) re-syncs without a manual reload.

export const IDLE_EVENT = "quadwork:idle-changed";

export interface IdleChangeDetail {
  projectId: string;
  idle: boolean;
}

export function emitIdleChange(projectId: string, idle: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<IdleChangeDetail>(IDLE_EVENT, { detail: { projectId, idle } }));
}

// Subscribe to idle changes. Returns an unsubscribe fn (use directly in useEffect).
export function onIdleChange(handler: (detail: IdleChangeDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => handler((e as CustomEvent<IdleChangeDetail>).detail);
  window.addEventListener(IDLE_EVENT, listener);
  return () => window.removeEventListener(IDLE_EVENT, listener);
}

// Persist a project's idle flag: re-read the latest config, flip ONLY this
// project's flag (preserving everything else), write it back. Throws on failure
// so callers can revert their optimistic UI. Broadcasts on success.
export async function persistProjectIdle(projectId: string, idle: boolean): Promise<void> {
  const r = await fetch("/api/config");
  if (!r.ok) throw new Error("config read failed");
  const cfg = await r.json();
  const entry = (cfg.projects || []).find((p: { id: string }) => p.id === projectId);
  if (!entry) throw new Error("project not found in config");
  entry.idle = idle;
  const put = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!put.ok) throw new Error("config write failed");
  emitIdleChange(projectId, idle);
}

// Confirmation copy shown only when setting a project Inactive (parking it).
// Resuming (→ Active) is safe and needs no confirmation.
export const idleConfirmTitle = (name: string) => `Set "${name}" to Inactive?`;
export const IDLE_CONFIRM_BODY =
  "This pauses everything for this project: GitHub polling, the GitHub board & batch progress, scheduled triggers, and bridge auto-lifecycle. Agents stay running but won't be pulsed; the dashboard shows last-known data until you set it Active again.";
