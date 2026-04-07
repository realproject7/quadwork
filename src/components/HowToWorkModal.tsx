"use client";

import { useEffect } from "react";

interface HowToWorkModalProps {
  open: boolean;
  onClose: () => void;
}

const STEPS: { title: string; body: string }[] = [
  {
    title: "You assign a task in the chat",
    body: "Tell @head what to build. Be as specific or as vague as you like.",
  },
  {
    title: "Head creates a GitHub issue",
    body: "Head opens an issue, adds it to the queue, and waits for your trigger.",
  },
  {
    title: "Dev writes the code",
    body: "Dev clones a branch, implements the change, and opens a pull request.",
  },
  {
    title: "Reviewers check the work",
    body: "Reviewer1 and Reviewer2 each review the PR independently. Both must approve before the PR is mergeable.",
  },
  {
    title: "Head merges and continues",
    body: "Head merges the approved PR and assigns the next ticket from the queue. The cycle continues all night while you sleep.",
  },
];

/**
 * "How to Work" modal (#229).
 *
 * Vertical-timeline explanation of the 4-agent workflow. Accessible
 * from both empty states (HomeEmptyState + ProjectChatEmptyState).
 * Closes on Escape, backdrop click, or the X button.
 */
export default function HowToWorkModal({ open, onClose }: HowToWorkModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="how-to-work-title"
    >
      <div
        className="relative mx-4 max-w-xl w-full max-h-[90vh] overflow-auto rounded-lg border border-white/10 bg-neutral-950 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded p-1 text-neutral-400 hover:bg-white/5 hover:text-white"
        >
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 4l12 12M16 4L4 16" strokeLinecap="round" />
          </svg>
        </button>

        <h2 id="how-to-work-title" className="text-base font-semibold text-white">How QuadWork builds your code</h2>
        <p className="mt-2 text-[12px] text-neutral-400">
          Five steps from your one-line request to a merged pull request.
        </p>

        <ol className="mt-5 relative">
          {/* Vertical accent line connecting the step circles. */}
          <span aria-hidden className="absolute left-[14px] top-3 bottom-3 w-px bg-accent/30" />
          {STEPS.map((step, i) => (
            <li key={i} className="relative pl-10 pb-5 last:pb-0">
              <span
                className="absolute left-0 top-0 inline-flex items-center justify-center w-7 h-7 rounded-full border border-accent bg-neutral-950 text-accent text-[12px] font-semibold tabular-nums"
                aria-hidden
              >
                {i + 1}
              </span>
              <div className="text-[13px] font-semibold text-white">{step.title}</div>
              <div className="mt-1 text-[12px] leading-relaxed text-neutral-400">{step.body}</div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
