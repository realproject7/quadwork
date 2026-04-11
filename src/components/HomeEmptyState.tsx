"use client";

import Link from "next/link";
import { useState } from "react";
import HowToWorkModal from "./HowToWorkModal";

interface HomeEmptyStateProps {
  hasProjects: boolean;
}

/**
 * Hero block for the home route (#229).
 *
 * Replaces the bare empty grid with a friendly icon + headline + CTA
 * that adapts to whether the user has any projects yet. Always
 * surfaces a "How to Work" button that opens the timeline modal.
 */
export default function HomeEmptyState({ hasProjects }: HomeEmptyStateProps) {
  const [howOpen, setHowOpen] = useState(false);

  const headline = hasProjects
    ? "Pick a project from the sidebar to start working"
    : "Welcome to QuadWork — let's set up your first AI dev team";
  const subtext = hasProjects
    ? "Each project has its own 4-agent team and chat. Click any chip in the left sidebar to open one."
    : "QuadWork runs Head, Dev, and two Reviewers as a team. They open issues, write code, review PRs, and merge — while you sleep.";

  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-12 border border-border bg-bg-surface">
      {/* #446: QuadWork symbol replaces the generic agent-team icon */}
      <img src="/quadwork-symbol.svg" alt="" width={64} height={64} aria-hidden />

      <h1 className="mt-5 text-lg font-semibold text-text max-w-md">{headline}</h1>
      <p className="mt-2 text-[12px] text-text-muted leading-relaxed max-w-md">{subtext}</p>

      <div className="mt-5 flex items-center gap-3">
        {hasProjects ? (
          <span className="text-[11px] text-text-muted italic">← look at the left sidebar</span>
        ) : (
          <Link
            href="/setup"
            className="px-4 py-2 text-[12px] font-semibold text-bg bg-accent hover:bg-accent-dim transition-colors"
          >
            Add Your First Project →
          </Link>
        )}
        <button
          type="button"
          onClick={() => setHowOpen(true)}
          className="px-4 py-2 text-[12px] text-text-muted border border-border hover:text-text hover:border-text-muted transition-colors"
        >
          How to Work
        </button>
      </div>

      <HowToWorkModal open={howOpen} onClose={() => setHowOpen(false)} />
    </div>
  );
}
