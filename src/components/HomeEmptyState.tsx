"use client";

import Link from "next/link";
import { useState } from "react";
import HowToWorkModal from "./HowToWorkModal";
import { useLocale } from "@/components/LocaleProvider";

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
  const { locale } = useLocale();
  const [howOpen, setHowOpen] = useState(false);

  const headline = hasProjects
    ? (locale === "ko"
      ? "사이드바에서 프로젝트를 골라 작업을 시작하세요"
      : "Pick a project from the sidebar to start working")
    : (locale === "ko"
      ? "QuadWork에 오신 걸 환영합니다\n- 첫 AI 개발 팀을 설정해볼까요"
      : "Welcome to QuadWork — let's set up your first AI dev team");
  const subtext = hasProjects
    ? (locale === "ko"
      ? "각 프로젝트는 자체 4인 에이전트 팀과 채팅을 가집니다.\n왼쪽 사이드바에서 아무 프로젝트나 눌러 열 수 있습니다."
      : "Each project has its own 4-agent team and chat. Click any chip in the left sidebar to open one.")
    : (locale === "ko"
      ? "QuadWork는 Head, Dev, Reviewer 둘을 한 팀으로 운영합니다.\n이슈를 만들고, 코드를 작성하고, PR을 리뷰하고, 병합합니다.\n당신이 쉬는 동안에도요."
      : "QuadWork runs Head, Dev, and two Reviewers as a team. They open issues, write code, review PRs, and merge — while you sleep.");

  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-12 border border-border bg-bg-surface">
      {/* #446: QuadWork symbol replaces the generic agent-team icon */}
      <img src="/quadwork-symbol.svg" alt="" width={64} height={64} aria-hidden />

      <h1 className={`mt-5 text-lg font-semibold text-text max-w-md whitespace-pre-line ${locale === "ko" ? "ko-help" : ""}`}>{headline}</h1>
      <p className={`mt-2 text-[12px] text-text-muted leading-relaxed max-w-md whitespace-pre-line ${locale === "ko" ? "ko-help" : ""}`}>{subtext}</p>

      <div className="mt-5 flex items-center gap-3">
        {hasProjects ? (
          <span className="text-[11px] text-text-muted italic">
            {locale === "ko" ? "← 왼쪽 사이드바를 보세요" : "← look at the left sidebar"}
          </span>
        ) : (
          <Link
            href="/setup"
            className="px-4 py-2 text-[12px] font-semibold text-bg bg-accent hover:bg-accent-dim transition-colors"
          >
            {locale === "ko" ? "첫 프로젝트 추가 →" : "Add Your First Project →"}
          </Link>
        )}
        <button
          type="button"
          onClick={() => setHowOpen(true)}
          className="px-4 py-2 text-[12px] text-text-muted border border-border hover:text-text hover:border-text-muted transition-colors"
        >
          {locale === "ko" ? "사용 방법" : "How to Work"}
        </button>
      </div>

      <HowToWorkModal open={howOpen} onClose={() => setHowOpen(false)} />
    </div>
  );
}
