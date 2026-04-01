"use client";

import { useState, useEffect, useCallback } from "react";

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

export default function GitHubPanel({ projectId }: GitHubPanelProps) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [prs, setPrs] = useState<PR[]>([]);

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
  }, [projectId]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Issues */}
      <div className="px-3 py-1.5 border-b border-border">
        <span className="text-[10px] text-text-muted uppercase tracking-wider">
          Issues ({issues.length})
        </span>
      </div>
      {issues.length === 0 && (
        <div className="px-3 py-2 text-[11px] text-text-muted">No issues</div>
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

      {/* PRs */}
      <div className="px-3 py-1.5 border-b border-border mt-1">
        <span className="text-[10px] text-text-muted uppercase tracking-wider">
          Pull Requests ({prs.length})
        </span>
      </div>
      {prs.length === 0 && (
        <div className="px-3 py-2 text-[11px] text-text-muted">No PRs</div>
      )}
      {prs.map((pr) => {
        const reviews = pr.reviews || [];
        const decision = pr.reviewDecision || "REVIEW_REQUIRED";

        // Extract per-agent review status from body text
        // Reviews start with "T2a" or "T2b", or contain "## Verdict:" (T2a format)
        const agentStatus: Record<string, string> = {};
        for (const r of reviews) {
          const body = (r.body || "").trim();
          if (/^T2b\b/i.test(body)) {
            agentStatus["t2b"] = r.state;
          } else if (/^T2a\b/i.test(body) || /^##\s*Verdict/i.test(body)) {
            agentStatus["t2a"] = r.state;
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
            {/* Per-agent review slots */}
            {["t2a", "t2b"].map((agent) => {
              const state = agentStatus[agent];
              return (
                <span
                  key={agent}
                  className={`text-[10px] shrink-0 ${
                    state
                      ? reviewTextColor(state)
                      : "text-text-muted"
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
    </div>
  );
}
