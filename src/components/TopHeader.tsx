"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AboutModal from "./AboutModal";

const GITHUB_URL = "https://github.com/realproject7/quadwork";

const TAGLINE_VARIANTS = [
  "sleep.",
  "eat.",
  "enjoy life.",
  "touch grass.",
  "spend time with people.",
  "watch a movie.",
  "take a vacation.",
  "go for a run.",
];

// Typewriter timings — tuned to feel brisk but readable.
const TYPE_MS = 70;
const DELETE_MS = 35;
const HOLD_MS = 2000;

function useTypewriter(variants: string[]) {
  const [index, setIndex] = useState(0);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"typing" | "holding" | "deleting">("typing");

  useEffect(() => {
    const current = variants[index];
    let timer: ReturnType<typeof setTimeout>;

    if (phase === "typing") {
      if (text.length < current.length) {
        timer = setTimeout(() => setText(current.slice(0, text.length + 1)), TYPE_MS);
      } else {
        timer = setTimeout(() => setPhase("holding"), 0);
      }
    } else if (phase === "holding") {
      timer = setTimeout(() => setPhase("deleting"), HOLD_MS);
    } else {
      if (text.length > 0) {
        timer = setTimeout(() => setText(current.slice(0, text.length - 1)), DELETE_MS);
      } else {
        setIndex((i) => (i + 1) % variants.length);
        setPhase("typing");
      }
    }

    return () => clearTimeout(timer);
  }, [text, phase, index, variants]);

  return text;
}

export default function TopHeader() {
  const [aboutOpen, setAboutOpen] = useState(false);
  const suffix = useTypewriter(TAGLINE_VARIANTS);

  return (
    <>
      <header className="sticky top-0 z-40 flex h-12 items-center justify-between border-b border-white/10 bg-neutral-950/90 px-4 backdrop-blur">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/" className="text-sm font-bold text-white hover:text-blue-400 shrink-0">
            QuadWork
          </Link>
          <span className="hidden sm:inline text-neutral-600">|</span>
          <span className="hidden sm:inline text-[13px] text-neutral-400 truncate">
            Your AI dev team while you{" "}
            <span className="text-neutral-200">{suffix}</span>
            <span className="ml-0.5 inline-block w-[1px] h-[12px] align-middle bg-neutral-400 animate-qw-blink" />
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setAboutOpen(true)}
            aria-label="About QuadWork"
            className="rounded p-1 text-neutral-400 hover:bg-white/5 hover:text-white"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="10" cy="10" r="8" />
              <path d="M10 9v5" strokeLinecap="round" />
              <circle cx="10" cy="6.5" r="0.8" fill="currentColor" />
            </svg>
          </button>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] text-neutral-400 hover:text-white"
          >
            QuadWork github
          </a>
        </div>
      </header>
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  );
}
