// #814: shared per-project Active/Inactive (idle) state. The source of truth is
// `project.idle` in config (#812). Toggling persists via PATCH /api/projects/:id/flags
// (#971) — the server's syncTriggers hook stops a now-idle project's trigger — and broadcasts
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

// #971: persist a project's idle flag via the field-scoped endpoint — the
// server merges ONLY this field under an atomic read-modify-write, so a toggle
// can't clobber a concurrent write with a stale whole-config snapshot. Throws on
// failure so callers can revert their optimistic UI. Broadcasts on success.
export async function persistProjectIdle(projectId: string, idle: boolean): Promise<void> {
  const put = await fetch(`/api/projects/${encodeURIComponent(projectId)}/flags`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idle }),
  });
  if (!put.ok) throw new Error("config write failed");
  emitIdleChange(projectId, idle);
}

// Confirmation copy shown only when setting a project Inactive (parking it).
// Resuming (→ Active) is safe and needs no confirmation.
export const idleConfirmTitle = (name: string) => `Set "${name}" to Inactive?`;
export const IDLE_CONFIRM_BODY =
  "This pauses everything for this project: GitHub polling, the GitHub board & batch progress, scheduled triggers, and bridge auto-lifecycle. Agents stay running but won't be pulsed; the dashboard shows last-known data until you set it Active again.";
