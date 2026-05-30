"use client";

import { useEffect, useState, useCallback } from "react";
import InfoTooltip from "./InfoTooltip";
import { useLocale } from "@/components/LocaleProvider";

interface BatchProgressItem {
  issue_number: number;
  title: string;
  url: string | null;
  pr_number?: number;
  // #350: "closed" = issue CLOSED with no linked PR (superseded,
  // not planned, or runbook-only). Rendered at 100% like merged
  // but with a distinct label from the server.
  // #871: review batches add "approved" / "changes_requested" statuses.
  status: "queued" | "in_review" | "approved1" | "ready" | "merged" | "closed" | "approved" | "changes_requested" | "unknown";
  progress: number; // 0..100
  label: string;
  // #871: present only on review-batch items (extends the shape from #870).
  review_state?: "queued" | "in-review" | "approved" | "changes-requested";
  approvals?: number; // 0..2
}

interface BatchProgressData {
  batch_number: number | null;
  items: BatchProgressItem[];
  summary: string;
  complete: boolean;
  // #870/#871: "code" (default) | "ticket-review" | "pr-review".
  batch_type?: "code" | "ticket-review" | "pr-review";
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
    currentBatch: (n: number | string) => `Current Batch: Batch ${n}`,
    complete: "✅ COMPLETE",
    allMerged: (n: number) => `All ${n} items merged. Waiting for the next batch.`,
    // #871: review batches never "merge" — use review wording.
    allReviewed: (n: number) => `All ${n} items approved. Waiting for the next batch.`,
    itemsCount: (n: number) => `(${n} items)`,
    // #871: review-state labels (mirror the existing PR approval wording).
    rs: { queued: "queued", inReview: "in review", oneOfTwo: "1 of 2 approvals", approved: "approved", changesRequested: "changes requested" },
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
  },
  ko: {
    loading: "배치 진행 상황 로딩 중...",
    idlePaused: "프로젝트가 유휴 상태입니다 — 배치 진행 폴링이 일시 중지되었습니다.",
    currentBatchNone: "현재 배치: (없음)",
    noActiveBatch: "활성 배치가 없습니다. 채팅에서 Head에게 시작을 요청하세요.",
    currentBatch: (n: number | string) => `현재 배치: ${n}번`,
    complete: "✅ 완료",
    allMerged: (n: number) => `${n}개 항목 모두 병합됨. 다음 배치를 기다리는 중.`,
    // #871: 리뷰 배치는 병합되지 않음 — 리뷰 문구 사용.
    allReviewed: (n: number) => `${n}개 항목 모두 승인됨. 다음 배치를 기다리는 중.`,
    itemsCount: (n: number) => `(${n}개 항목)`,
    // #871: 리뷰 상태 라벨.
    rs: { queued: "대기 중", inReview: "검토 중", oneOfTwo: "2명 중 1명 승인", approved: "승인됨", changesRequested: "변경 요청됨" },
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
  },
} as const;

// #871: localized label for a review-batch item, derived from review_state.
function reviewLabel(item: BatchProgressItem, rs: { queued: string; inReview: string; oneOfTwo: string; approved: string; changesRequested: string }): string {
  switch (item.review_state) {
    case "approved": return rs.approved;
    case "changes-requested": return rs.changesRequested;
    case "in-review": return (item.approvals ?? 0) >= 1 ? rs.oneOfTwo : rs.inReview;
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

  const load = useCallback(() => {
    fetch(`/api/batch-progress?project=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setData(d); })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    if (idle) return; // #812: parked project — stop polling batch progress
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load, idle]);

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

  // Empty state — no active batch in OVERNIGHT-QUEUE.md.
  if (!data.items || data.items.length === 0) {
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
          const displayLabel = isReviewItem ? reviewLabel(item, t.rs) : item.label;
          const isChanges = item.review_state === "changes-requested";
          const row = (
            <div className="flex items-center gap-2 px-3 py-1 font-mono">
              <span className="text-[11px] text-text-muted w-8 shrink-0 tabular-nums">
                #{item.issue_number}
              </span>
              <ProgressBar percent={item.progress} />
              <span className="text-[11px] text-text-muted tabular-nums shrink-0 w-9 text-right">
                {item.progress}%
              </span>
              <span className={`text-[11px] truncate flex-1 min-w-0 ${isChanges ? "text-warning" : "text-text"}`}>
                {displayLabel}
              </span>
            </div>
          );
          if (!item.url) {
            return <div key={item.issue_number}>{row}</div>;
          }
          return (
            <a
              key={item.issue_number}
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
          const needSecond = data.items.filter((it) => it.review_state === "in-review" && (it.approvals ?? 0) >= 1).length;
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
