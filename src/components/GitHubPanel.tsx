"use client";

import { useState, useEffect, useCallback } from "react";
import InfoTooltip from "./InfoTooltip";
import OvernightQueueModal from "./OvernightQueueModal";
import BatchProgressPanel from "./BatchProgressPanel";
import { useLocale } from "@/components/LocaleProvider";

interface Issue {
  number: number;
  title: string;
  state: string;
  assignees: { login: string }[];
  url: string;
}

interface Review {
  author: { login: string };
  state: string;
  body: string;
}

interface PR {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  assignees: { login: string }[];
  reviewDecision: string;
  reviews: Review[];
  statusCheckRollup: { state: string }[];
  url: string;
}

// #411 / quadwork#281: minimal shape for the recently-closed lists.
// Both endpoints return the same fields the panel needs, so a single
// type covers both columns.
interface ClosedItem {
  number: number;
  title: string;
  url: string;
}

function StatusDot({ color }: { color: string }) {
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${color}`} />;
}

function issueStatusColor(state: string): string {
  return state === "OPEN" ? "bg-accent" : "bg-error";
}

function reviewColor(decision: string): string {
  if (decision === "APPROVED") return "bg-accent";
  if (decision === "CHANGES_REQUESTED") return "bg-error";
  return "bg-[#ffcc00]";
}

function reviewTextColor(decision: string): string {
  if (decision === "APPROVED") return "text-accent";
  if (decision === "CHANGES_REQUESTED") return "text-error";
  return "text-[#ffcc00]";
}

function reviewLabel(decision: string): string {
  if (decision === "APPROVED") return "ok";
  if (decision === "CHANGES_REQUESTED") return "chg";
  return "rev";
}

function ciColor(rollup: { state: string }[]): string {
  if (!rollup || rollup.length === 0) return "text-text-muted";
  const states = rollup.map((c) => c.state);
  if (states.every((s) => s === "SUCCESS")) return "text-accent";
  if (states.some((s) => s === "FAILURE" || s === "ERROR")) return "text-error";
  return "text-[#ffcc00]";
}

function ciLabel(rollup: { state: string }[]): string {
  if (!rollup || rollup.length === 0) return "—";
  const states = rollup.map((c) => c.state);
  if (states.every((s) => s === "SUCCESS")) return "pass";
  if (states.some((s) => s === "FAILURE" || s === "ERROR")) return "fail";
  return "run";
}

interface GitHubPanelProps {
  projectId: string;
}

// #554: rate limit status shape from /api/github/rate-limit
interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetInMinutes: number;
  low: boolean;
  critical: boolean;
}

export default function GitHubPanel({ projectId }: GitHubPanelProps) {
  const { locale } = useLocale();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [prs, setPrs] = useState<PR[]>([]);
  // #411 / quadwork#281: recently closed issues + merged PRs.
  const [closedIssues, setClosedIssues] = useState<ClosedItem[]>([]);
  const [mergedPrs, setMergedPrs] = useState<ClosedItem[]>([]);
  const [queueModalOpen, setQueueModalOpen] = useState(false);
  // #554: rate limit indicator
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null);

  // #226: auto-create OVERNIGHT-QUEUE.md on dashboard load if it
  // doesn't exist yet. Idempotent — POST returns `existed:true`
  // when the file is already there. Covers projects that pre-date
  // #204 (the wizard fix that seeds the file at create time).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/queue?project=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data || data.exists) return;
        return fetch(`/api/queue?project=${encodeURIComponent(projectId)}`, { method: "POST" });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  const fetchData = useCallback(() => {
    fetch(`/api/github/issues?project=${encodeURIComponent(projectId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => { if (Array.isArray(data)) setIssues(data); })
      .catch(() => {});

    fetch(`/api/github/prs?project=${encodeURIComponent(projectId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => { if (Array.isArray(data)) setPrs(data); })
      .catch(() => {});

    // #411 / quadwork#281: pull recently closed issues + merged PRs
    // on the same poll cadence so the "Recently closed" sections
    // refresh whenever a batch finishes a ticket.
    fetch(`/api/github/closed-issues?project=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (Array.isArray(data)) setClosedIssues(data); })
      .catch(() => {});

    fetch(`/api/github/merged-prs?project=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (Array.isArray(data)) setMergedPrs(data); })
      .catch(() => {});
  }, [projectId]);

  // #554: poll rate limit status every 60s
  useEffect(() => {
    const fetchRL = () => {
      fetch("/api/github/rate-limit")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => { if (data) setRateLimit(data); })
        .catch(() => {});
    };
    fetchRL();
    const rlInterval = setInterval(fetchRL, 60000);
    return () => clearInterval(rlInterval);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* #554: rate limit indicator */}
      {rateLimit && (rateLimit.critical || rateLimit.low) && (
        <div className={`px-3 py-1 text-[10px] shrink-0 ${
          rateLimit.critical
            ? "bg-error/20 text-error"
            : "bg-[#ffcc00]/20 text-[#ffcc00]"
        }`}>
          {rateLimit.critical
            ? (locale === "ko"
              ? `GitHub API 제한에 걸렸습니다 - 캐시된 데이터를 표시합니다. ${rateLimit.resetInMinutes}분 후 초기화됩니다`
              : `GitHub API rate limited — showing cached data. Resets in ${rateLimit.resetInMinutes}m`)
            : (locale === "ko"
              ? `GitHub API 남음: ${rateLimit.remaining}/${rateLimit.limit}. ${rateLimit.resetInMinutes}분 후 초기화`
              : `GitHub API: ${rateLimit.remaining}/${rateLimit.limit} remaining. Resets in ${rateLimit.resetInMinutes}m`)
          }
        </div>
      )}
      {/* #226: side-by-side issues + PRs columns */}
      <div className="flex-1 min-h-0 flex">
        {/* Issues column */}
        <div className="flex-1 min-w-0 flex flex-col border-r border-border">
          <div className="px-3 py-1.5 border-b border-border shrink-0 flex items-center gap-1.5">
            <span className="text-[10px] text-text-muted uppercase tracking-wider">
              {locale === "ko" ? `이슈 (${issues.length})` : `Issues (${issues.length})`}
            </span>
            <InfoTooltip>
              {locale === "ko"
                ? <><b>이슈</b> - 이 프로젝트 GitHub 저장소의 열린 이슈입니다. 항목을 클릭하면 GitHub에서 열립니다.</>
                : <><b>Issues</b> — open issues on the project&apos;s GitHub repo. Click any item to open it on GitHub.</>}
            </InfoTooltip>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {issues.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-text-muted">{locale === "ko" ? "이슈 없음" : "No issues"}</div>
            )}
            {issues.map((issue) => (
              <a
                key={issue.number}
                href={issue.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-1 font-mono hover:bg-[#1a1a1a] transition-colors cursor-pointer border-b border-border/50"
              >
                <StatusDot color={issueStatusColor(issue.state)} />
                <span className="text-[11px] text-text-muted w-8 shrink-0">#{issue.number}</span>
                <span className="text-[11px] text-text truncate flex-1 min-w-0">{issue.title}</span>
                {issue.assignees?.[0] && (
                  <span className="text-[10px] text-text-muted shrink-0">
                    {issue.assignees[0].login}
                  </span>
                )}
              </a>
            ))}
            {/* #411 / quadwork#281: Recently closed issues — last 5,
                muted style with a ✓ to distinguish from open. */}
            <div className="px-3 pt-2 pb-1 text-[9px] text-text-muted uppercase tracking-wider">
              {locale === "ko" ? "최근 닫힌 이슈" : "Recently closed"}
            </div>
            {closedIssues.length === 0 && (
              <div className="px-3 py-1 text-[11px] text-text-muted">{locale === "ko" ? "아직 없음" : "None yet"}</div>
            )}
            {closedIssues.map((issue) => (
              <a
                key={`closed-${issue.number}`}
                href={issue.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-1 font-mono opacity-60 hover:opacity-100 hover:bg-[#1a1a1a] transition-all cursor-pointer border-b border-border/30"
              >
                <span className="text-[11px] text-text-muted shrink-0">✓</span>
                <span className="text-[11px] text-text-muted w-8 shrink-0">#{issue.number}</span>
                <span className="text-[11px] text-text-muted truncate flex-1 min-w-0">{issue.title}</span>
              </a>
            ))}
          </div>
        </div>

        {/* PRs column */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-3 py-1.5 border-b border-border shrink-0 flex items-center gap-1.5">
            <span className="text-[10px] text-text-muted uppercase tracking-wider">
              {locale === "ko" ? `풀 리퀘스트 (${prs.length})` : `Pull Requests (${prs.length})`}
            </span>
            <InfoTooltip>
              {locale === "ko"
                ? <><b>풀 리퀘스트</b> - 검토 또는 병합을 기다리는 열린 PR입니다. 클릭하면 GitHub에서 열립니다.</>
                : <><b>Pull Requests</b> — open PRs awaiting review or merge. Click to open on GitHub.</>}
            </InfoTooltip>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {prs.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-text-muted">{locale === "ko" ? "PR 없음" : "No PRs"}</div>
            )}
            {prs.map((pr) => {
              const reviews = pr.reviews || [];
              const decision = pr.reviewDecision || "REVIEW_REQUIRED";

              // Extract per-agent review status from body text
              const agentStatus: Record<string, string> = {};
              for (const r of reviews) {
                const body = (r.body || "").trim();
                // Current names checked first; legacy Reviewer1/2 and T2a/b
                // kept as fallback for reviews posted before the slug rename.
                if (/^(?:RE2|Reviewer2|T2b)\b/i.test(body)) {
                  agentStatus["re2"] = r.state;
                } else if (/^(?:RE1|Reviewer1|T2a)\b/i.test(body) || /^##\s*Verdict/i.test(body)) {
                  agentStatus["re1"] = r.state;
                }
              }

              return (
                <a
                  key={pr.number}
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-1 font-mono hover:bg-[#1a1a1a] transition-colors cursor-pointer border-b border-border/50"
                >
                  <StatusDot color={reviewColor(decision)} />
                  <span className="text-[11px] text-text-muted w-8 shrink-0">#{pr.number}</span>
                  <span className="text-[11px] text-text truncate flex-1 min-w-0">{pr.title}</span>
                  {pr.assignees?.[0] && (
                    <span className="text-[10px] text-text-muted shrink-0">
                      {pr.assignees[0].login}
                    </span>
                  )}
                  {["re1", "re2"].map((agent) => {
                    const state = agentStatus[agent];
                    return (
                      <span
                        key={agent}
                        className={`text-[10px] shrink-0 ${
                          state ? reviewTextColor(state) : "text-text-muted"
                        }`}
                      >
                        {agent}:{state ? reviewLabel(state) : "—"}
                      </span>
                    );
                  })}
                  <span className={`text-[10px] shrink-0 ${ciColor(pr.statusCheckRollup)}`}>
                    {ciLabel(pr.statusCheckRollup)}
                  </span>
                </a>
              );
            })}
            {/* #411 / quadwork#281: Recently merged PRs — last 5,
                muted style with a ✓ to distinguish from open. */}
            <div className="px-3 pt-2 pb-1 text-[9px] text-text-muted uppercase tracking-wider">
              {locale === "ko" ? "최근 병합됨" : "Recently merged"}
            </div>
            {mergedPrs.length === 0 && (
              <div className="px-3 py-1 text-[11px] text-text-muted">{locale === "ko" ? "아직 없음" : "None yet"}</div>
            )}
            {mergedPrs.map((pr) => (
              <a
                key={`merged-${pr.number}`}
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-1 font-mono opacity-60 hover:opacity-100 hover:bg-[#1a1a1a] transition-all cursor-pointer border-b border-border/30"
              >
                <span className="text-[11px] text-text-muted shrink-0">✓</span>
                <span className="text-[11px] text-text-muted w-8 shrink-0">#{pr.number}</span>
                <span className="text-[11px] text-text-muted truncate flex-1 min-w-0">{pr.title}</span>
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* #413 / quadwork#282: Current Batch Progress section sits
          between the issues/PRs lists and the OVERNIGHT-QUEUE.md
          row. Reads /api/batch-progress on its own 30s cadence. */}
      <div className="shrink-0">
        <BatchProgressPanel projectId={projectId} />
      </div>

      {/* #226: compact OVERNIGHT-QUEUE.md row at the bottom */}
      <div className="shrink-0 flex items-center justify-between px-3 py-1.5 border-t border-border">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-text-muted font-mono">OVERNIGHT-QUEUE.md</span>
          <InfoTooltip position="above">
            {locale === "ko"
              ? <><b>야간 큐</b> - Head가 다음 티켓을 고를 때 읽는 작업 큐 파일입니다. 편집을 눌러 배치 내용과 순서를 수정할 수 있습니다.</>
              : <><b>Overnight Queue</b> — the task queue file Head reads to pick the next ticket. Click Edit to modify batch contents and ordering.</>}
          </InfoTooltip>
        </div>
        <button
          onClick={() => setQueueModalOpen(true)}
          className="px-2 py-0.5 text-[10px] text-text-muted hover:text-accent border border-border hover:border-accent transition-colors uppercase tracking-wider"
        >
          {locale === "ko" ? "편집" : "Edit"}
        </button>
      </div>

      <OvernightQueueModal
        open={queueModalOpen}
        projectId={projectId}
        onClose={() => setQueueModalOpen(false)}
      />
    </div>
  );
}
