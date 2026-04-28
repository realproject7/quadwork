"use client";

import { useState } from "react";
import HowToWorkModal from "./HowToWorkModal";
import { useLocale } from "@/components/LocaleProvider";

interface ProjectChatEmptyStateProps {
  onInsert: (text: string) => void;
}

const COPY = {
  en: {
    ready: "Ready when you are",
    tell: "Tell your team what to build. Try something like:",
    howToWork: "How to Work",
    examples: [
      "@head start a new feature: <describe>",
      "@head review the latest PR",
      "@head what's our current sprint?",
    ],
  },
  ko: {
    ready: "언제든지 시작하세요",
    tell: "팀에게 무엇을 만들지 말해보세요. 예를 들어:",
    howToWork: "사용 방법",
    examples: [
      "@head 새로운 기능 시작: <설명>",
      "@head 최신 PR 리뷰해줘",
      "@head 현재 스프린트 상황이 어때?",
    ],
  },
} as const;

/**
 * Empty state inside the AgentChattr chat panel (#229) for projects
 * with zero messages. Replaces the bare "No messages" centered text
 * with a friendly icon, headline, and three click-to-insert example
 * chips.
 */
export default function ProjectChatEmptyState({ onInsert }: ProjectChatEmptyStateProps) {
  const { locale } = useLocale();
  const t = COPY[locale];
  const [howOpen, setHowOpen] = useState(false);

  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-10 gap-3">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden className="text-accent">
        <path d="M6 8h28a2 2 0 0 1 2 2v17a2 2 0 0 1-2 2H16l-7 6v-6h-3a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <circle cx="14" cy="18" r="1.4" fill="currentColor" />
        <circle cx="20" cy="18" r="1.4" fill="currentColor" />
        <circle cx="26" cy="18" r="1.4" fill="currentColor" />
      </svg>
      <div className="text-[13px] font-semibold text-text">{t.ready}</div>
      <div className="text-[11px] text-text-muted">{t.tell}</div>
      <div className="flex flex-col gap-1.5 mt-1 w-full max-w-sm">
        {t.examples.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => onInsert(ex)}
            className="text-left px-2 py-1 text-[11px] font-mono text-text-muted border border-border hover:text-accent hover:border-accent transition-colors truncate"
          >
            {ex}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setHowOpen(true)}
        className="mt-2 text-[11px] text-text-muted underline underline-offset-2 hover:text-text"
      >
        {t.howToWork}
      </button>
      <HowToWorkModal open={howOpen} onClose={() => setHowOpen(false)} />
    </div>
  );
}
