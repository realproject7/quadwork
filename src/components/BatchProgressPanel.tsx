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
  status: "queued" | "in_review" | "approved1" | "ready" | "merged" | "closed" | "unknown";
  progress: number; // 0..100
  label: string;
}

interface BatchProgressData {
  batch_number: number | null;
  items: BatchProgressItem[];
  summary: string;
  complete: boolean;
}

interface BatchProgressPanelProps {
  projectId: string;
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
export default function BatchProgressPanel({ projectId }: BatchProgressPanelProps) {
  const { locale } = useLocale();
  const [data, setData] = useState<BatchProgressData | null>(null);

  const load = useCallback(() => {
    fetch(`/api/batch-progress?project=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setData(d); })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  if (!data) {
    return (
      <div className="px-3 py-1.5 text-[11px] text-text-muted border-t border-border">
        {locale === "ko" ? "배치 진행 상황 로딩 중..." : "Loading batch progress…"}
      </div>
    );
  }

  // Empty state — no active batch in OVERNIGHT-QUEUE.md.
  if (!data.items || data.items.length === 0) {
    return (
      <div className="border-t border-border">
        <div className="px-3 py-1.5 flex items-center gap-2">
          <span className="text-[10px] text-text-muted uppercase tracking-wider">
            {locale === "ko" ? "현재 배치: (없음)" : "Current Batch: (none)"}
          </span>
        </div>
        <div className="px-3 pb-2 text-[11px] text-text-muted">
          {locale === "ko" ? "활성 배치가 없습니다. 채팅에서 Head에게 시작을 요청하세요." : "No active batch. Ask Head to start one via the chat."}
        </div>
      </div>
    );
  }

  // Complete state — all items merged.
  if (data.complete) {
    return (
      <div className="border-t border-border">
        <div className="px-3 py-1.5 flex items-center gap-2">
          <span className="text-[10px] text-text-muted uppercase tracking-wider">
            {locale === "ko" ? `현재 배치: ${data.batch_number ?? "—"}번` : `Current Batch: Batch ${data.batch_number ?? "—"}`}
          </span>
          <span className="text-[10px] text-accent">{locale === "ko" ? "✅ 완료" : "✅ COMPLETE"}</span>
        </div>
        <div className="px-3 pb-2 text-[11px] text-text-muted">
          {locale === "ko" ? `${data.items.length}개 항목 모두 병합됨. 다음 배치를 기다리는 중.` : `All ${data.items.length} items merged. Waiting for the next batch.`}
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-border">
      <div className="px-3 py-1.5 flex items-center gap-2 border-b border-border/40">
        <span className="text-[10px] text-text-muted uppercase tracking-wider">
          {locale === "ko" ? `현재 배치: ${data.batch_number ?? "—"}번` : `Current Batch: Batch ${data.batch_number ?? "—"}`}
        </span>
        <span className="text-[10px] text-text-muted">{locale === "ko" ? `(${data.items.length}개 항목)` : `(${data.items.length} items)`}</span>
        <InfoTooltip>
          {locale === "ko"
            ? <><b>현재 배치</b> - 활성 배치 진행 상황 추적기입니다. GitHub를 조회해 각 이슈 상태를 대기 → 검토 중 → 승인 → 병합 순으로 추적합니다.</>
            : <><b>Current Batch</b> — progress tracker for the active batch. Polls GitHub to resolve each issue&apos;s status (queued &rarr; in review &rarr; approved &rarr; merged).</>}
        </InfoTooltip>
      </div>
      <div className="max-h-40 overflow-y-auto">
        {data.items.map((item) => {
          const row = (
            <div className="flex items-center gap-2 px-3 py-1 font-mono">
              <span className="text-[11px] text-text-muted w-8 shrink-0 tabular-nums">
                #{item.issue_number}
              </span>
              <ProgressBar percent={item.progress} />
              <span className="text-[11px] text-text-muted tabular-nums shrink-0 w-9 text-right">
                {item.progress}%
              </span>
              <span className="text-[11px] text-text truncate flex-1 min-w-0">
                {item.label}
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
      {data.summary && (
        <div className="px-3 py-1.5 text-[11px] text-text-muted border-t border-border/40">
          {data.summary}
        </div>
      )}
    </div>
  );
}
