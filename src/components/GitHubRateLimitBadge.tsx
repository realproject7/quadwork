"use client";

import { useEffect, useState } from "react";

// #866: always-on GitHub rate-limit badge for the GITHUB panel header.
// Self-contained: fetches /api/github/rate-limit on the same 60s cadence as
// GitHubPanel and renders all three buckets (core / graphql / search) inline,
// each colored independently by its OWN remaining %. Reuses the existing
// exempt `gh api rate_limit` poll (#554/#802) — no new billable API calls.

interface Bucket {
  limit: number;
  remaining: number;
  resetInMinutes: number;
}

interface RateLimitResponse {
  core?: Bucket;
  graphql?: Bucket;
  search?: Bucket;
}

const BUCKETS: { key: keyof RateLimitResponse; label: string }[] = [
  { key: "core", label: "core" },
  { key: "graphql", label: "gql" },
  { key: "search", label: "search" },
];

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

  // Degrade gracefully: render nothing until we have data, and skip any bucket
  // the endpoint didn't return rather than crashing.
  const visible = data
    ? BUCKETS.filter(({ key }) => {
        const b = data[key];
        return b && typeof b.remaining === "number" && typeof b.limit === "number";
      })
    : [];
  if (visible.length === 0) return null;

  return (
    <div className="flex items-center gap-2 text-[10px] font-mono text-text-muted">
      {visible.map(({ key, label }) => {
        const b = data![key]!;
        return (
          <span
            key={key}
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
        );
      })}
    </div>
  );
}
