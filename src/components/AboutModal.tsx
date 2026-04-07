"use client";

import { useEffect } from "react";

interface AboutModalProps {
  open: boolean;
  onClose: () => void;
}

const GITHUB_URL = "https://github.com/realproject7/quadwork";

export default function AboutModal({ open, onClose }: AboutModalProps) {
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
      aria-labelledby="about-title"
    >
      <div
        className="relative mx-4 max-w-lg w-full rounded-lg border border-white/10 bg-neutral-950 p-6 shadow-2xl"
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

        <h2 id="about-title" className="text-lg font-semibold text-white">What is QuadWork?</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          QuadWork is a local dashboard that runs a team of 4 AI agents — Head, Dev, and two Reviewers — that code, review, and ship while you sleep.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          Every task follows a strict GitHub workflow: Issue → Branch → Pull Request → 2 Reviews → Merge. Branch protection ensures no agent can skip the process.
        </p>

        <h3 className="mt-5 text-sm font-semibold text-white">Why QuadWork?</h3>
        <ul className="mt-2 space-y-1.5 text-sm text-neutral-300">
          <li>🤖 <b>Run 24/7</b> — agents work overnight while you rest</li>
          <li>🛡️ <b>Always reviewed</b> — every PR needs 2 independent approvals</li>
          <li>🔒 <b>Local-first</b> — runs entirely on your machine, no data leaves</li>
          <li>🧰 <b>Bring your own CLI</b> — works with Claude Code, Codex, or both</li>
          <li>📦 <b>One install</b> — <code className="rounded bg-white/5 px-1 py-0.5 text-[12px]">npx quadwork init</code> and you&apos;re set</li>
        </ul>

        <div className="mt-5">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300"
          >
            Read the full docs on GitHub →
          </a>
        </div>
      </div>
    </div>
  );
}
