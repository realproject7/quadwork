"use client";

import { useEffect, useState } from "react";

// #866: always-on GitHub rate-limit badge for the GITHUB panel header.
// Self-contained: fetches /api/github/rate-limit on the same 60s cadence as
// GitHubPanel and renders all three buckets (core / graphql / search) inline,
// each colored independently by its OWN remaining %. Reuses the existing
// exempt `gh api rate_limit` poll (#554/#802) — no new billable API calls.
// #886: also renders a second group for the reviewer-token account when the
// response includes a `reviewer` block (two-account setups), since GitHub
// budgets are per-account, not aggregated.

interface Bucket {
  limit: number;
  remaining: number;
  resetInMinutes: number;
}

interface ReviewerBlock {
  login?: string;
  core?: Bucket;
  graphql?: Bucket;
  search?: Bucket;
}

interface RateLimitResponse {
  core?: Bucket;
  graphql?: Bucket;
  search?: Bucket;
  reviewer?: ReviewerBlock;
}

// Per-bucket color by its own remaining %: green ≥50% healthy, red ≤5% (or 0)
// gone, orange in between (warning). search is a small bucket (30/min) so its
// % swings fast — that's expected.
function bucketColor(b: Bucket): string {
  if (!b.limit) return "text-text-muted";
  const pct = b.remaining / b.limit;
  if (b.remaining === 0 || pct <= 0.05) return "text-error";
  if (pct >= 0.5) return "text-accent";
  return "text-warning";
}

// Render the colored span for each present bucket. Skips any bucket the
// endpoint didn't return rather than crashing.
function bucketSpans(items: { label: string; b?: Bucket }[]) {
  return items
    .filter((it): it is { label: string; b: Bucket } =>
      !!it.b && typeof it.b.remaining === "number" && typeof it.b.limit === "number",
    )
    .map(({ label, b }) => (
      <span
        key={label}
        className="flex items-center gap-1 whitespace-nowrap"
        title={`${label}: ${b.remaining}/${b.limit} remaining · resets in ${b.resetInMinutes}m`}
      >
        <span className={bucketColor(b)} aria-hidden>
          ●
        </span>
        <span>{label}</span>
        <span>
          {b.remaining}/{b.limit}
        </span>
      </span>
    ));
}

export default function GitHubRateLimitBadge() {
  const [data, setData] = useState<RateLimitResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/github/rate-limit")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d) setData(d);
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Degrade gracefully: render nothing until we have data.
  const mainSpans = data
    ? bucketSpans([
        { label: "core", b: data.core },
        { label: "gql", b: data.graphql },
        { label: "search", b: data.search },
      ])
    : [];
  if (mainSpans.length === 0) return null;

  // #886: reviewer account — graphql is the at-risk budget (review discovery),
  // so show it (plus core/search when present). Absent on single-account setups.
  const reviewer = data?.reviewer;
  const reviewerSpans = reviewer
    ? bucketSpans([
        { label: "gql", b: reviewer.graphql },
        { label: "core", b: reviewer.core },
        { label: "search", b: reviewer.search },
      ])
    : [];

  return (
    <div className="flex items-center gap-2 text-[10px] font-mono text-text-muted">
      {mainSpans}
      {reviewerSpans.length > 0 && (
        <>
          <span className="text-border" aria-hidden>
            |
          </span>
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="opacity-70">{reviewer?.login || "reviewer"}:</span>
            {reviewerSpans}
          </span>
        </>
      )}
    </div>
  );
}
