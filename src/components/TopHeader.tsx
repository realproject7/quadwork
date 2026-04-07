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

function useTypewriter(variants: string[], enabled: boolean) {
  const [index, setIndex] = useState(0);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"typing" | "holding" | "deleting">("typing");

  useEffect(() => {
    // #227: when disabled, the live `index` / `phase` / `text` are
    // intentionally left untouched — toggling back on must resume
    // exactly where the animation was paused, not restart from the
    // first variant. The render side substitutes the static first
    // variant for display while disabled; we just stop scheduling
    // phase transitions here.
    if (!enabled) return;

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
  }, [text, phase, index, variants, enabled]);

  return text;
}

const TAGLINE_LS_KEY = "quadwork_tagline_animation";

export default function TopHeader() {
  const [aboutOpen, setAboutOpen] = useState(false);
  // #227: tagline animation toggle persisted in localStorage. Default
  // is "on" for new visitors. Initialised lazily so SSR doesn't try
  // to read window.localStorage during the first render.
  const [animationEnabled, setAnimationEnabled] = useState(true);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(TAGLINE_LS_KEY);
      if (saved === "off") setAnimationEnabled(false);
    } catch { /* localStorage unavailable — keep default */ }
  }, []);
  const toggleAnimation = () => {
    setAnimationEnabled((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(TAGLINE_LS_KEY, next ? "on" : "off"); } catch {}
      return next;
    });
  };

  const liveSuffix = useTypewriter(TAGLINE_VARIANTS, animationEnabled);
  // #227: when disabled, freeze on the first variant ("sleep.").
  // The hook keeps its live index/phase intact, so re-enabling
  // resumes from where the animation was paused.
  const suffix = animationEnabled ? liveSuffix : (TAGLINE_VARIANTS[0] || "");

  // #227: the toggle should appear only after the typewriter
  // completes one cycle (operator has seen the animation in
  // motion) or after a ~5s fallback. If the animation is already
  // off (operator paused it on a previous visit), show the toggle
  // immediately so they can re-enable.
  const [showToggle, setShowToggle] = useState(false);
  useEffect(() => {
    if (!animationEnabled) { setShowToggle(true); return; }
    const t = setTimeout(() => setShowToggle(true), 5000);
    return () => clearTimeout(t);
  }, [animationEnabled]);
  // First-cycle completion: a "deleting → empty → next variant"
  // transition produces an empty `liveSuffix`. Show as soon as we
  // observe the first one.
  useEffect(() => {
    if (animationEnabled && liveSuffix === "") setShowToggle(true);
  }, [animationEnabled, liveSuffix]);

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
            {animationEnabled && (
              <span className="ml-0.5 inline-block w-[1px] h-[12px] align-middle bg-neutral-400 animate-qw-blink" />
            )}
          </span>
          {/* #227: small unobtrusive toggle for the tagline animation.
              Hidden until the operator has seen one full cycle of the
              animation (or a ~5s fallback) so it isn't a discoverable
              affordance the very first frame. */}
          {showToggle && (
            <button
              type="button"
              onClick={toggleAnimation}
              aria-label={animationEnabled ? "Pause tagline animation" : "Resume tagline animation"}
              aria-pressed={animationEnabled}
              title={animationEnabled ? "Pause tagline animation" : "Resume tagline animation"}
              className="hidden sm:inline-flex items-center justify-center w-3.5 h-3.5 ml-1 rounded-full border border-white/15 text-neutral-500 hover:text-white hover:border-white/40 transition-colors text-[8px]"
            >
              {animationEnabled ? "❚❚" : "▶"}
            </button>
          )}
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
