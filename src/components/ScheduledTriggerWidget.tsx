"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import { useLocale } from "@/components/LocaleProvider";
import { assignmentRequestFields, ownedCurrentBatchSnapshot } from "@/lib/batchIdentity";

interface ScheduledTriggerWidgetProps {
  projectId: string;
  idle?: boolean;
}

// Batch progress / active shapes from /api/batch-progress and /api/batch-active.
interface BatchState {
  active: boolean;
  complete: boolean;
  completeConfirmed: boolean;
  liveActiveBatchCleared: boolean;
  items: Array<{
    number: number;
    issue_number: number;
    status: string;
    repo_key: string;
    repo: string;
    work_item_ref: string | { repo_key: string; repo: string; number: number; kind: "issue" | "pr" };
    ownership_key: string | null;
    kind: "issue" | "pr";
    installation_id: string | null;
    batch_number: number;
    assignment_attempt: string | null;
    provenance: "owned" | "foreign" | "unowned" | "legacy_unowned";
    assignment_key: string | null;
    current: boolean;
    owned: boolean;
  }>;
  batch_number: number | null;
  installation_id: string | null;
  assignment_attempt: string | null;
  provenance: "owned" | "foreign" | "unowned" | "legacy_unowned";
  assignment_key: string | null;
  assignment_items: Array<{
    work_item_ref: { repo_key: string; repo: string; number: number; kind: "issue" | "pr" };
    ownership_key: string;
  }>;
  current: boolean;
  owned: boolean;
  multi_repository: boolean;
  compatibility_mode: "v1" | "v2";
  admission_generation: number;
  batch_observation_fingerprint?: string;
}

interface BatchActiveState {
  active: boolean;
  installation_id: string | null;
  batch_number: number | null;
  assignment_attempt: string | null;
  provenance: "owned" | "foreign" | "unowned" | "legacy_unowned";
  assignment_key: string | null;
  assignment_items: Array<{
    work_item_ref: { repo_key: string; repo: string; number: number; kind: "issue" | "pr" };
    ownership_key: string;
  }>;
  current: boolean;
  owned: boolean;
  multi_repository: boolean;
  compatibility_mode: "v1" | "v2";
  admission_generation: number;
  batch_observation_fingerprint?: string;
}

interface BatchLifecycleSnapshot {
  authority: "v2_owned" | "legacy_compatibility" | "empty_current";
  compatibility_mode: "v1" | "v2";
  fingerprint: string;
  admission_generation: number;
  batch_observation_fingerprint?: string;
  active: boolean;
  complete: boolean;
  completeConfirmed: boolean;
  liveActiveBatchCleared: boolean;
  hasItems: boolean;
  installation_id: string | null;
  batch_number: number | null;
  assignment_attempt: string | null;
  provenance: "owned" | "unowned" | "legacy_unowned";
  assignment_key: string | null;
  assignment_items: Array<{
    work_item_ref: { repo_key: string; repo: string; number: number; kind: "issue" | "pr" };
    ownership_key: string;
  }>;
}

// Lifecycle poll cadence (same as BatchProgressPanel).
const LIFECYCLE_POLL_MS = 30_000;
const STATE_POLL_MS = 5_000;

interface MonitorEvaluation {
  applied: boolean;
  command: string;
  evaluated_at?: string;
  terminal?: boolean;
  changed?: boolean;
  reason?: string;
  stall_state?: string;
  subject?: { subject_key: string; item?: string; row_status?: string | null } | null;
  conditions?: Array<{ kind: string; immediate: boolean; due_at: number | null }>;
  deliveries?: Array<{ kind: string | null; ok: boolean; duplicate: boolean; code: string | null }>;
}

// #1036: GET /api/triggers now reports Project Monitor state. There is no
// message, interval, or duration: the monitor is fixed policy.
interface MonitorInfo {
  enabled: boolean;
  mode: "enabled" | "suspended" | "archived";
  observation_hash: string | null;
  unresolved: Array<{ kind: string; due_at: number }>;
  deliveries: Array<{ kind: string; phase: "recorded" | "appended" | "woken" }>;
  last_evaluation: MonitorEvaluation | null;
  legacy_trigger_retained: boolean;
}

const COPY = {
  en: {
    label: (mode: string) => `Project Monitor${mode === "enabled" ? " (observing)" : mode === "suspended" ? " (suspended)" : ""}`,
    tooltip: (
      <>
        <b>Project Monitor</b> is a Head-only observer with a fixed policy. It watches the current qualified assignment and writes one structured event to <b>@head</b> only when a transition is due: terminal-red CI, a passing draft, a worker exit before status, BLOCKED, an overdue WAITING, an overdue merge gate, merged-but-not-advanced, or next-item-unassigned. Unchanged state writes nothing and wakes no agent. It never sends a periodic message to all agents.
      </>
    ),
    mode: "Mode",
    start: "Start Monitor",
    starting: "Starting…",
    evaluate: "Evaluate now",
    evaluating: "Evaluating…",
    stop: "Stop Monitor",
    stopping: "Stopping…",
    lastEvaluation: "Last evaluation",
    none: "none yet",
    changed: "transition observed",
    unchanged: "no change (nothing written)",
    terminal: "batch terminal — conditions cleared",
    subject: "Subject",
    conditions: "Conditions",
    deliveries: "Head events",
    unresolved: "Armed deadlines",
    legacyRetained: "A legacy scheduled-trigger message is retained as disabled data and is never sent.",
    autoStopStatus: "Batch complete — monitor conditions cleared.",
    refused: (reason: string) => `Not started: ${reason}`,
  },
  ko: {
    label: (mode: string) => `프로젝트 모니터${mode === "enabled" ? " (관찰 중)" : mode === "suspended" ? " (일시 중지)" : ""}`,
    tooltip: (
      <>
        <b>프로젝트 모니터</b>는 고정 정책의 Head 전용 관찰자입니다. 현재 자격 있는 할당을 관찰하고, 전환이 실제로 발생했을 때만 <b>@head</b>에게 구조화된 이벤트 하나를 씁니다: CI 실패 확정, 통과한 드래프트, 상태 보고 전 워커 종료, BLOCKED, WAITING 기한 초과, 머지 게이트 기한 초과, 머지 후 미진행, 다음 항목 미할당. 변화가 없으면 아무것도 쓰지 않고 어떤 에이전트도 깨우지 않습니다. 모든 에이전트에게 주기적으로 메시지를 보내지 않습니다.
      </>
    ),
    mode: "모드",
    start: "모니터 시작",
    starting: "시작 중…",
    evaluate: "지금 평가",
    evaluating: "평가 중…",
    stop: "모니터 중지",
    stopping: "중지 중…",
    lastEvaluation: "마지막 평가",
    none: "아직 없음",
    changed: "전환 관찰됨",
    unchanged: "변화 없음 (기록 없음)",
    terminal: "배치 종료 — 조건 정리됨",
    subject: "대상",
    conditions: "조건",
    deliveries: "Head 이벤트",
    unresolved: "예약된 기한",
    legacyRetained: "예전 예약 트리거 메시지는 비활성 데이터로만 보관되며 전송되지 않습니다.",
    autoStopStatus: "배치 완료 — 모니터 조건이 정리되었습니다.",
    refused: (reason: string) => `시작되지 않음: ${reason}`,
  },
} as const;

function formatAt(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

/**
 * Operator Features widget for the Project Monitor (#1036), in the right rail.
 *
 * Replaces the Scheduled Trigger editor. The operator cannot author a message,
 * cadence, or recipient list: Start enables the fixed-policy Head-only monitor
 * for the live batch, Evaluate now runs one deduplicated evaluation, and Stop
 * suspends observation. State is sourced from GET /api/triggers every 5s.
 */
export default function ScheduledTriggerWidget({ projectId, idle = false }: ScheduledTriggerWidgetProps) {
  const { locale } = useLocale();
  const t = COPY[locale];
  const [monitor, setMonitor] = useState<MonitorInfo | null>(null);
  const [busy, setBusy] = useState<null | "start" | "evaluate" | "stop">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const prevBatchRef = useRef<BatchLifecycleSnapshot | null>(null);
  const monitorRef = useRef<MonitorInfo | null>(null);
  useEffect(() => { monitorRef.current = monitor; }, [monitor]);
  useEffect(() => { prevBatchRef.current = null; setNotice(null); }, [projectId]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/triggers");
      if (!r.ok) throw new Error(`${r.status}`);
      const data: Record<string, MonitorInfo> = await r.json();
      setMonitor(data[projectId] || null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    if (idle) return; // #812: parked project — stop polling monitor state
    load();
    const id = window.setInterval(load, STATE_POLL_MS);
    return () => window.clearInterval(id);
  }, [load, idle]);

  const post = useCallback(async (action: "start" | "send-now" | "stop", body: Record<string, unknown>) => {
    const r = await fetch(`/api/triggers/${encodeURIComponent(projectId)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await r.json().catch(() => null);
    if (!r.ok && !(payload && typeof payload.reason === "string")) throw new Error(`${r.status}`);
    return payload;
  }, [projectId]);

  const start = async () => {
    setBusy("start"); setError(null); setNotice(null);
    try {
      const payload = await post("start", {});
      if (payload && payload.applied === false) setNotice(t.refused(payload.reason || payload.code || "refused"));
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const evaluate = async () => {
    setBusy("evaluate"); setError(null); setNotice(null);
    try {
      const payload = await post("send-now", {});
      if (payload && payload.applied === false) setNotice(t.refused(payload.reason || payload.code || "refused"));
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const stop = async () => {
    setBusy("stop"); setError(null); setNotice(null);
    try {
      await post("stop", {});
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  // Batch lifecycle polling: join live Active Batch authority with progress.
  // A confirmed completion or an explicit clear suspends an observing monitor
  // with the exact assignment identity; nothing here starts one automatically
  // (#1036: unarchive/restore remain suspended until an explicit start).
  const checkBatchLifecycle = useCallback(async () => {
    try {
      const project = encodeURIComponent(projectId);
      const [activeResponse, progressResponse] = await Promise.all([
        fetch(`/api/batch-active?project=${project}`),
        fetch(`/api/batch-progress?project=${project}`),
      ]);
      if (!activeResponse.ok || !progressResponse.ok) return;
      const active: BatchActiveState = await activeResponse.json();
      const data: BatchState = await progressResponse.json();
      const next = ownedCurrentBatchSnapshot(active, data) as BatchLifecycleSnapshot | null;
      if (!next) return;
      prevBatchRef.current = next;
      if ((next.completeConfirmed || next.liveActiveBatchCleared) && monitorRef.current?.enabled) {
        await fetch(`/api/triggers/${encodeURIComponent(projectId)}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(assignmentRequestFields(next)),
        });
        setNotice(t.autoStopStatus);
        await load();
      }
    } catch { /* non-fatal */ }
  }, [projectId, load, t.autoStopStatus]);

  useEffect(() => {
    if (idle) return;
    checkBatchLifecycle();
    const id = window.setInterval(checkBatchLifecycle, LIFECYCLE_POLL_MS);
    return () => window.clearInterval(id);
  }, [checkBatchLifecycle, idle]);

  const mode = monitor?.mode || "suspended";
  const observing = mode === "enabled";
  const last = monitor?.last_evaluation || null;

  return (
    <div className="flex flex-col border border-border">
      <div className="flex items-center justify-between h-7 px-3 shrink-0 border-b border-border">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-text-muted uppercase tracking-wider">{t.label(mode)}</span>
          <InfoTooltip>{t.tooltip}</InfoTooltip>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-[10px] text-error">err: {error}</span>}
        </div>
      </div>
      {notice && (
        <div className="px-3 py-1 text-[10px] text-accent bg-accent/5 border-b border-border/50">{notice}</div>
      )}
      <div className="p-3 flex flex-col gap-2 text-[11px]">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="flex items-center gap-1">
            {observing && (
              <span className="relative inline-flex items-center justify-center w-2 h-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 animate-ping" />
                <span className="relative w-1.5 h-1.5 rounded-full bg-accent" />
              </span>
            )}
            <span className="text-text-muted">{t.mode}:</span>
            <span className={observing ? "text-accent" : "text-text"}>{mode}</span>
          </span>
          {monitor && monitor.unresolved.length > 0 && (
            <span className="text-text-muted">
              {t.unresolved}: {monitor.unresolved.map((c) => c.kind).join(", ")}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1 bg-bg-surface border border-border p-2 font-mono">
          <div className="text-text-muted">{t.lastEvaluation}{last?.evaluated_at ? ` · ${formatAt(last.evaluated_at)}` : ""}</div>
          {!last ? (
            <div className="text-text-muted">{t.none}</div>
          ) : (
            <>
              <div className="text-text">
                {last.applied === false
                  ? t.refused(last.reason || "refused")
                  : last.terminal ? t.terminal : last.changed ? t.changed : t.unchanged}
              </div>
              {last.subject && (
                <div className="text-text-muted">{t.subject}: {last.subject.item || last.subject.subject_key}{last.subject.row_status ? ` (${last.subject.row_status})` : ""}</div>
              )}
              {last.conditions && last.conditions.length > 0 && (
                <div className="text-text-muted">{t.conditions}: {last.conditions.map((c) => c.kind).join(", ")}</div>
              )}
              {last.deliveries && last.deliveries.length > 0 && (
                <div className="text-text-muted">
                  {t.deliveries}: {last.deliveries.map((d) => `${d.kind}${d.ok ? (d.duplicate ? " (dup)" : "") : ` (${d.code || "failed"})`}`).join(", ")}
                </div>
              )}
            </>
          )}
        </div>
        {monitor?.legacy_trigger_retained && (
          <div className="text-[10px] text-text-muted">{t.legacyRetained}</div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          {!observing ? (
            <button
              onClick={start}
              disabled={busy !== null || mode === "archived"}
              className="px-3 py-1 text-[11px] font-semibold text-bg bg-accent hover:bg-accent-dim disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {busy === "start" ? t.starting : t.start}
            </button>
          ) : (
            <>
              <button
                onClick={evaluate}
                disabled={busy !== null}
                className="px-3 py-1 text-[11px] font-semibold text-bg bg-accent hover:bg-accent-dim disabled:opacity-50 transition-colors"
              >
                {busy === "evaluate" ? t.evaluating : t.evaluate}
              </button>
              <button
                onClick={stop}
                disabled={busy !== null}
                className="px-3 py-1 text-[11px] text-text-muted border border-border hover:text-error hover:border-error/40 disabled:opacity-50 transition-colors"
              >
                {busy === "stop" ? t.stopping : t.stop}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
