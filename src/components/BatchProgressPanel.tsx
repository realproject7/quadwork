"use client";

import { useEffect, useState, useCallback, type ReactNode } from "react";
import InfoTooltip from "./InfoTooltip";
import { useLocale } from "@/components/LocaleProvider";
import { workItemDisplayLabel, workItemReactKey } from "@/lib/batchIdentity";
import { sessionTokenHeaders } from "@/lib/sessionToken";

interface BatchProgressItem {
  number: number;
  issue_number: number;
  repo_key: string;
  repo: string;
  work_item_ref: string | { repo_key: string; repo: string; number: number; kind: "issue" | "pr" };
  ownership_key?: string | null;
  kind: "issue" | "pr";
  installation_id?: string | null;
  batch_number?: number | null;
  assignment_attempt?: string | null;
  provenance?: "owned" | "foreign" | "unowned" | "legacy_unowned";
  assignment_key?: string | null;
  current?: boolean;
  owned?: boolean;
  title: string;
  url: string | null;
  pr_number?: number;
  live_pr?: {
    number: number;
    url: string;
    state: "OPEN";
    tip: string;
  } | null;
  // #350: "closed" = issue CLOSED with no linked PR (superseded,
  // not planned, or runbook-only). Rendered at 100% like merged
  // but with a distinct label from the server.
  // #871: review batches add "approved" / "changes_requested" statuses.
  // #907: "finalizing" = both reviewers approved, item not yet written `approved`.
  status: "queued" | "in_review" | "finalizing" | "approved1" | "ready" | "merged" | "closed" | "approved" | "changes_requested" | "unknown";
  progress: number; // 0..100
  label: string;
  // #871: present only on review-batch items (extends the shape from #870).
  review_state?: "queued" | "in-review" | "approved" | "changes-requested";
  approvals?: number; // 0..2
  // #1048: current exact-SHA review cycle for a code item with a live PR.
  // Readiness, CI, and reviews are orthogonal facts; the UI renders all three
  // instead of the scalar `in_review` label. Absent when no cycle is current.
  review_handoff?: ReviewHandoff | null;
}

type ReviewReadiness = "draft_or_not_ready" | "contract_changed" | "ready";
type ReviewCi =
  | "unknown" | "pending" | "pass" | "product_failure" | "control_plane_failure"
  | "cancelled" | "missing_required" | "missing_policy" | "ci_less_pending" | "ci_less_pass";
type ReviewCount = "not_dispatched" | "0/2" | "1/2" | "2/2" | "changes_requested";

interface ReviewHandoff {
  pr_number: number;
  readiness: ReviewReadiness;
  ci: ReviewCi;
  review: ReviewCount;
  head_gate_due: boolean;
  dev_fix_owner: boolean;
}

interface ReviewHandoffCopy {
  readiness: Record<ReviewReadiness, string>;
  ci: Record<ReviewCi, string>;
  review: Record<ReviewCount, string>;
  headGateDue: string;
  devFix: string;
}

interface BatchProgressData {
  active?: boolean;
  batch_number: number | null;
  items: BatchProgressItem[];
  summary: string;
  complete: boolean;
  // #870/#871: "code" (default) | "ticket-review" | "pr-review".
  batch_type?: "code" | "ticket-review" | "pr-review";
  multi_repository?: boolean;
  validation_errors?: Array<{ code: string; message: string }>;
  compatibility_mode?: "v1" | "v2";
  batch_observation_fingerprint?: string;
  assignment_items?: Array<{
    work_item_ref: { repo_key: string; repo: string; number: number; kind: "issue" | "pr" };
    ownership_key: string;
  }>;
}

type WorkTaskState =
  | "queued" | "building" | "candidate_ready" | "independent_review"
  | "reconcile" | "changes_requested" | "accepted" | "staged"
  | "blocked" | "deferred";

interface WorkTaskBatchProjection {
  version: number;
  batch_manifest_digest: string;
  delivery_mode: "integrated" | "isolated";
  frozen: boolean;
  repositories: Array<{
    repository_key: string;
    base_sha: string | null;
    work_items: Array<{
      work_item: { repoKey: string; repo: string; number: number; kind: "issue" | "pr" };
      issue_body_revision: string;
      tasks: Array<{
        work_task_ref: { repository_key: string; task_key: string };
        task_key: string;
        goal: string;
        state: WorkTaskState;
      }>;
    }>;
  }>;
}

interface WorkTaskBatchData {
  ok?: boolean;
  active: boolean;
  projection: WorkTaskBatchProjection | null;
}

interface WorkTaskCopy {
  currentBatch: (n: number | string) => string;
  workTasks: (n: number) => string;
  workTaskTooltip: ReactNode;
  workTaskStates: Record<WorkTaskState, string>;
}

interface BatchProgressPanelProps {
  projectId: string;
  idle?: boolean;
}

const COPY = {
  en: {
    loading: "Loading batch progress…",
    idlePaused: "Project is idle — batch progress polling is paused.",
    currentBatchNone: "Current Batch: (none)",
    noActiveBatch: "No active batch. Ask Head to start one via the chat.",
    invalidQueue: "Queue validation failed",
    currentBatch: (n: number | string) => `Current Batch: Batch ${n}`,
    complete: "✅ COMPLETE",
    allMerged: (n: number) => `All ${n} items merged. Waiting for the next batch.`,
    // #871: review batches never "merge" — use review wording.
    allReviewed: (n: number) => `All ${n} items approved. Waiting for the next batch.`,
    itemsCount: (n: number) => `(${n} items)`,
    // #871: review-state labels (mirror the existing PR approval wording).
    rs: { queued: "queued", inReview: "in review", oneOfTwo: "1 of 2 approvals", finalizing: "2 of 2 · finalizing", approved: "approved", changesRequested: "changes requested" },
    reviewSummary: (approved: number, total: number, needSecond: number, changes: number) => {
      const parts = [`${approved}/${total} reviewed`];
      if (needSecond > 0) parts.push(`${needSecond} need 2nd approval`);
      if (changes > 0) parts.push(`${changes} changes requested`);
      return parts.join(" · ");
    },
    tooltip: (
      <>
        <b>Current Batch</b> — progress tracker for the active batch. Polls GitHub to resolve each issue&apos;s status (queued &rarr; in review &rarr; approved &rarr; merged).
      </>
    ),
    // #871: review batches are driven by the queue's Active Batch states — no
    // GitHub polling, no "merged" terminal state.
    tooltipReview: (
      <>
        <b>Current Batch</b> — review progress for the active batch, driven by the queue&apos;s Active Batch states (queued &rarr; in review &rarr; approved).
      </>
    ),
    workTasks: (n: number) => `(${n} tasks)`,
    workTaskTooltip: (
      <>
        <b>Work Tasks</b> — immutable local slices inside each ticket. Their state is independent of PR delivery; candidate and review details remain server-bound.
      </>
    ),
    workTaskStates: {
      queued: "queued", building: "building", candidate_ready: "candidate ready", independent_review: "independent review",
      reconcile: "reconciling", changes_requested: "changes requested", accepted: "accepted", staged: "staged",
      blocked: "blocked", deferred: "deferred",
    },
    // #1048: orthogonal current-cycle facts, e.g. "PR #12 · ready · CI pending · reviews 1/2".
    handoff: {
      readiness: { draft_or_not_ready: "draft", contract_changed: "contract changed", ready: "ready" },
      ci: {
        unknown: "CI unknown", pending: "CI pending", pass: "CI pass", product_failure: "CI failed",
        control_plane_failure: "CI control-plane failure", cancelled: "CI cancelled",
        missing_required: "CI missing required checks", missing_policy: "CI policy missing",
        ci_less_pending: "CI-less pending", ci_less_pass: "CI-less pass",
      },
      review: {
        not_dispatched: "reviews not dispatched", "0/2": "reviews 0/2", "1/2": "reviews 1/2", "2/2": "reviews 2/2",
        changes_requested: "changes requested",
      },
      headGateDue: "head gate due",
      devFix: "dev fix",
    },
  },
  ko: {
    loading: "배치 진행 상황 로딩 중...",
    idlePaused: "프로젝트가 유휴 상태입니다 — 배치 진행 폴링이 일시 중지되었습니다.",
    currentBatchNone: "현재 배치: (없음)",
    noActiveBatch: "활성 배치가 없습니다. 채팅에서 Head에게 시작을 요청하세요.",
    invalidQueue: "큐 검증 실패",
    currentBatch: (n: number | string) => `현재 배치: ${n}번`,
    complete: "✅ 완료",
    allMerged: (n: number) => `${n}개 항목 모두 병합됨. 다음 배치를 기다리는 중.`,
    // #871: 리뷰 배치는 병합되지 않음 — 리뷰 문구 사용.
    allReviewed: (n: number) => `${n}개 항목 모두 승인됨. 다음 배치를 기다리는 중.`,
    itemsCount: (n: number) => `(${n}개 항목)`,
    // #871: 리뷰 상태 라벨.
    rs: { queued: "대기 중", inReview: "검토 중", oneOfTwo: "2명 중 1명 승인", finalizing: "2명 모두 승인 · 마무리 중", approved: "승인됨", changesRequested: "변경 요청됨" },
    reviewSummary: (approved: number, total: number, needSecond: number, changes: number) => {
      const parts = [`${approved}/${total} 검토됨`];
      if (needSecond > 0) parts.push(`${needSecond}건 2차 승인 필요`);
      if (changes > 0) parts.push(`${changes}건 변경 요청`);
      return parts.join(" · ");
    },
    tooltip: (
      <>
        <b>현재 배치</b> - 활성 배치 진행 상황 추적기입니다. GitHub를 조회해 각 이슈 상태를 대기 → 검토 중 → 승인 → 병합 순으로 추적합니다.
      </>
    ),
    // #871: 리뷰 배치는 큐의 Active Batch 상태로 진행됩니다 — GitHub 조회 없음, "병합" 상태 없음.
    tooltipReview: (
      <>
        <b>현재 배치</b> - 큐의 Active Batch 상태로 추적하는 리뷰 진행 상황입니다 (대기 → 검토 중 → 승인).
      </>
    ),
    workTasks: (n: number) => `(${n}개 작업)`,
    workTaskTooltip: (
      <>
        <b>작업 단위</b> - 각 티켓 안의 불변 로컬 작업 단위입니다. 상태는 PR 전달과 독립적이며, 후보 및 리뷰 상세는 서버 경계 안에 유지됩니다.
      </>
    ),
    workTaskStates: {
      queued: "대기", building: "빌드 중", candidate_ready: "후보 준비", independent_review: "독립 검토 중",
      reconcile: "조정 중", changes_requested: "변경 요청", accepted: "승인", staged: "스테이징",
      blocked: "차단됨", deferred: "보류됨",
    },
    // #1048: 준비/CI/리뷰 상태를 따로 표시 — 예: "PR #12 · 준비됨 · CI 대기 · 리뷰 1/2".
    handoff: {
      readiness: { draft_or_not_ready: "초안", contract_changed: "계약 변경됨", ready: "준비됨" },
      ci: {
        unknown: "CI 미확인", pending: "CI 대기", pass: "CI 통과", product_failure: "CI 실패",
        control_plane_failure: "CI 제어 오류", cancelled: "CI 취소됨",
        missing_required: "CI 필수 검사 누락", missing_policy: "CI 정책 없음",
        ci_less_pending: "CI 없음 · 대기", ci_less_pass: "CI 없음 · 통과",
      },
      review: {
        not_dispatched: "리뷰 미배정", "0/2": "리뷰 0/2", "1/2": "리뷰 1/2", "2/2": "리뷰 2/2",
        changes_requested: "변경 요청됨",
      },
      headGateDue: "헤드 머지 게이트",
      devFix: "개발 수정 필요",
    },
  },
} as const;

// #1048: render readiness, CI, and review together — never a scalar "in review".
function handoffLabel(handoff: ReviewHandoff, c: ReviewHandoffCopy): string {
  const parts = [`PR #${handoff.pr_number}`, c.readiness[handoff.readiness], c.ci[handoff.ci], c.review[handoff.review]];
  if (handoff.head_gate_due) parts.push(c.headGateDue);
  else if (handoff.dev_fix_owner) parts.push(c.devFix);
  return parts.join(" · ");
}

// #871: localized label for a review-batch item, derived from review_state.
function reviewLabel(item: BatchProgressItem, rs: { queued: string; inReview: string; oneOfTwo: string; finalizing: string; approved: string; changesRequested: string }): string {
  switch (item.review_state) {
    case "approved": return rs.approved;
    case "changes-requested": return rs.changesRequested;
    // #907: 2/2 approvals (not yet written `approved`) is a finalizing state,
    // never "1 of 2"; 1/2 shows "1 of 2 approvals".
    case "in-review": return (item.approvals ?? 0) >= 2 ? rs.finalizing : (item.approvals ?? 0) === 1 ? rs.oneOfTwo : rs.inReview;
    case "queued":
    default: return rs.queued;
  }
}

const BAR_SEGMENTS = 20;

function ProgressBar({ percent }: { percent: number }) {
  const filled = Math.round((percent / 100) * BAR_SEGMENTS);
  const empty = BAR_SEGMENTS - filled;
  return (
    <span className="font-mono text-[11px] tabular-nums whitespace-nowrap">
      <span className="text-accent">{"█".repeat(filled)}</span>
      <span className="text-text-muted">{"░".repeat(empty)}</span>
    </span>
  );
}

function workTaskStateClass(state: WorkTaskState): string {
  if (state === "accepted" || state === "staged") return "text-accent";
  if (state === "changes_requested" || state === "blocked") return "text-error";
  if (state === "independent_review" || state === "reconcile") return "text-warning";
  return "text-text-muted";
}

function WorkTaskBatch({
  batch,
  batchNumber,
  t,
}: {
  batch: WorkTaskBatchProjection;
  batchNumber: number | null | undefined;
  t: WorkTaskCopy;
}) {
  const taskCount = batch.repositories.reduce((count, repository) =>
    count + repository.work_items.reduce((itemCount, item) => itemCount + item.tasks.length, 0), 0);
  return (
    <div className="border-t border-border">
      <div className="px-3 py-1.5 flex items-center gap-2 border-b border-border/40">
        <span className="text-[10px] text-text-muted uppercase tracking-wider">
          {t.currentBatch(batchNumber ?? "—")}
        </span>
        <span className="text-[10px] text-text-muted">{t.workTasks(taskCount)}</span>
        <InfoTooltip>{t.workTaskTooltip}</InfoTooltip>
      </div>
      <div className="max-h-52 overflow-y-auto" role="list" aria-label={t.workTasks(taskCount)}>
        {batch.repositories.map((repository) => (
          <section key={repository.repository_key} className="border-b border-border/30 last:border-b-0" role="listitem">
            <div className="px-3 py-1 text-[10px] text-text-muted font-mono truncate" title={repository.repository_key}>
              [{repository.repository_key}]
            </div>
            {repository.work_items.map((item) => (
              <div key={`${repository.repository_key}:${item.work_item.repo}:${item.work_item.kind}:${item.work_item.number}`} className="pb-1">
                <div className="px-3 py-0.5 text-[11px] text-text font-mono truncate" title={`${item.work_item.repo}#${item.work_item.number}`}>
                  {item.work_item.repo}#{item.work_item.number}
                </div>
                <div role="list" aria-label={`${item.work_item.repo} work tasks`}>
                  {item.tasks.map((task) => (
                    <div key={`${repository.repository_key}:${item.work_item.repo}:${item.work_item.number}:${task.task_key}`} role="listitem" className="flex items-center gap-2 px-3 py-1 pl-6 font-mono">
                      <span className="text-[11px] text-text shrink-0">{task.task_key}</span>
                      <span className={`text-[10px] shrink-0 ${workTaskStateClass(task.state)}`}>{t.workTaskStates[task.state]}</span>
                      <span className="text-[11px] text-text-muted truncate min-w-0" title={task.goal}>{task.goal}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * #413 / quadwork#282: Current Batch Progress panel.
 *
 * Reads /api/batch-progress (which itself parses the active batch
 * out of OVERNIGHT-QUEUE.md and resolves each issue against
 * GitHub) and renders a row per item with a progress bar + status
 * label. Polls every 30s on the same cadence as the rest of the
 * GitHub panel.
 */
export default function BatchProgressPanel({ projectId, idle = false }: BatchProgressPanelProps) {
  const { locale } = useLocale();
  const t = COPY[locale];
  const [data, setData] = useState<BatchProgressData | null>(null);
  const [workTaskBatch, setWorkTaskBatch] = useState<WorkTaskBatchData | null>(null);

  const load = useCallback(async () => {
    const project = encodeURIComponent(projectId);
    try {
      const [progressResponse, workTaskResponse] = await Promise.all([
        fetch(`/api/batch-progress?project=${project}`),
        sessionTokenHeaders().then((headers) => fetch(`/api/work-task-batch?project=${project}`, { headers })),
      ]);
      if (progressResponse.ok) {
        const progress = await progressResponse.json();
        if (progress) setData(progress);
      }
      if (workTaskResponse.ok) {
        const nested = await workTaskResponse.json();
        if (nested?.ok === true && typeof nested.active === "boolean") {
          setWorkTaskBatch({ active: nested.active, projection: nested.projection ?? null });
          return;
        }
      }
      setWorkTaskBatch(null);
    } catch {
      setWorkTaskBatch(null);
    }
  }, [projectId]);

  useEffect(() => {
    if (idle) return; // #812: parked project — stop polling batch progress
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load, idle]);

  if (workTaskBatch?.active === true && workTaskBatch.projection !== null) {
    return <WorkTaskBatch batch={workTaskBatch.projection} batchNumber={data?.batch_number} t={t} />;
  }

  if (!data) {
    // #812: a project that is already idle on open has no cached batch data
    // and never fetches — show a paused state instead of "Loading…" forever.
    if (idle) {
      return (
        <div className="border-t border-border">
          <div className="px-3 py-1.5 flex items-center gap-2">
            <span className="text-[10px] text-text-muted uppercase tracking-wider">Idle</span>
          </div>
          <div className="px-3 pb-2 text-[11px] text-text-muted">
            {t.idlePaused}
          </div>
        </div>
      );
    }
    return (
      <div className="px-3 py-1.5 text-[11px] text-text-muted border-t border-border">
        {t.loading}
      </div>
    );
  }

  if (Array.isArray(data.validation_errors) && data.validation_errors.length > 0) {
    return (
      <div className="border-t border-border" role="alert">
        <div className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wider">
          {t.invalidQueue}
        </div>
        <ul className="px-3 pb-2 space-y-1 text-[11px] text-text-muted font-mono">
          {data.validation_errors.slice(0, 4).map((error, index) => (
            <li key={`${error.code}:${index}`}>{error.code}: {error.message}</li>
          ))}
        </ul>
      </div>
    );
  }

  // Current Batch is explicitly empty when the server's live-queue authority
  // says inactive. Defensive item checks keep older servers compatible, but a
  // stale row array can never override active:false.
  if (data.active === false || !data.items || data.items.length === 0) {
    return (
      <div className="border-t border-border">
        <div className="px-3 py-1.5 flex items-center gap-2">
          <span className="text-[10px] text-text-muted uppercase tracking-wider">
            {t.currentBatchNone}
          </span>
        </div>
        <div className="px-3 pb-2 text-[11px] text-text-muted">
          {t.noActiveBatch}
        </div>
      </div>
    );
  }

  // #871: review batches (ticket-review / pr-review) render review states +
  // review wording; code batches keep the existing merge-based path.
  const isReview = data.batch_type === "ticket-review" || data.batch_type === "pr-review";

  // Complete state — all items merged (code) / approved (review).
  if (data.complete) {
    return (
      <div className="border-t border-border">
        <div className="px-3 py-1.5 flex items-center gap-2">
          <span className="text-[10px] text-text-muted uppercase tracking-wider">
            {t.currentBatch(data.batch_number ?? "—")}
          </span>
          <span className="text-[10px] text-accent">{t.complete}</span>
        </div>
        <div className="px-3 pb-2 text-[11px] text-text-muted">
          {isReview ? t.allReviewed(data.items.length) : t.allMerged(data.items.length)}
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-border">
      <div className="px-3 py-1.5 flex items-center gap-2 border-b border-border/40">
        <span className="text-[10px] text-text-muted uppercase tracking-wider">
          {t.currentBatch(data.batch_number ?? "—")}
        </span>
        <span className="text-[10px] text-text-muted">{t.itemsCount(data.items.length)}</span>
        <InfoTooltip>
          {isReview ? t.tooltipReview : t.tooltip}
        </InfoTooltip>
      </div>
      <div className="max-h-40 overflow-y-auto">
        {data.items.map((item) => {
          // #871: review item → localized review-state label; changes-requested
          // gets the warning token. Code items (no review_state) use the
          // server label exactly as before.
          const isReviewItem = !!item.review_state;
          // #1048: a current review cycle renders its orthogonal dimensions;
          // the server's scalar label is only the fallback when no cycle exists.
          const handoff = item.review_handoff ?? null;
          const displayLabel = handoff
            ? handoffLabel(handoff, t.handoff)
            : isReviewItem ? reviewLabel(item, t.rs) : item.label;
          const labelClass = handoff?.head_gate_due
            ? "text-accent"
            : handoff?.dev_fix_owner || item.review_state === "changes-requested" ? "text-warning" : "text-text";
          const itemKey = workItemReactKey(item);
          const itemRefLabel = workItemDisplayLabel(item, data.multi_repository === true);
          const row = (
            <div className="flex items-center gap-2 px-3 py-1 font-mono">
              <span className="text-[11px] text-text-muted shrink-0 tabular-nums whitespace-nowrap">
                {itemRefLabel}
              </span>
              <ProgressBar percent={item.progress} />
              <span className="text-[11px] text-text-muted tabular-nums shrink-0 w-9 text-right">
                {item.progress}%
              </span>
              <span className={`text-[11px] truncate flex-1 min-w-0 ${labelClass}`} title={displayLabel}>
                {displayLabel}
              </span>
            </div>
          );
          if (!item.url) {
            return <div key={itemKey}>{row}</div>;
          }
          return (
            <a
              key={itemKey}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block hover:bg-[#1a1a1a] transition-colors border-b border-border/30"
            >
              {row}
            </a>
          );
        })}
      </div>
      {(() => {
        // #871: review batches show "N/M reviewed · K need 2nd approval"
        // (computed from review_state/approvals); code batches use the
        // server-provided summary unchanged.
        let summaryText = data.summary;
        if (isReview) {
          const approved = data.items.filter((it) => it.review_state === "approved").length;
          const needSecond = data.items.filter((it) => it.review_state === "in-review" && (it.approvals ?? 0) === 1).length;
          const changes = data.items.filter((it) => it.review_state === "changes-requested").length;
          summaryText = t.reviewSummary(approved, data.items.length, needSecond, changes);
        }
        return summaryText ? (
          <div className="px-3 py-1.5 text-[11px] text-text-muted border-t border-border/40">
            {summaryText}
          </div>
        ) : null;
      })()}
    </div>
  );
}
