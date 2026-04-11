"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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

interface ActivityStats {
  today: number;
  week: number;
  month: number;
  total: number;
  by_project: Record<string, { today: number; week: number; month: number; total: number }>;
}

function fmtHours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return "0h";
  if (h < 1) return `${(h * 60).toFixed(0)}m`;
  return `${h.toFixed(1)}h`;
}

export default function TopHeader() {
  // #372: TopHeader mixes localStorage-derived state (tagline
  // animation toggle), an async activity-stats fetch, and a
  // typewriter animation that all tick independently on the
  // client. Next.js was rendering slightly different text between
  // the SSR pass and the first client render, producing React
  // error #418 ("hydration failed — text content mismatch") and
  // forcing React to throw away the server-rendered subtree and
  // fully re-render — which operators observed as an unexplained
  // "right column unmounts and remounts" whenever the client
  // re-hydrated mid-interaction. Gating the whole header on a
  // mounted flag gives the SSR and first-client render identical
  // output (an empty 48px placeholder shell), then triggers a
  // single safe client-side render after hydration. No more
  // mismatch, no more subtree remount cascade.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [aboutOpen, setAboutOpen] = useState(false);
  // #430 / quadwork#312: work-hours stat polling. 60s cadence.
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [showStatsTooltip, setShowStatsTooltip] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/activity/stats")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled && d) setStats(d); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
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
  // transition produces an empty `liveSuffix` AFTER the typewriter
  // has typed something. We need to wait until the suffix has been
  // non-empty at least once before treating empty as "cycle done"
  // — otherwise the initial mount value (also "") would trip this
  // immediately. Use a ref so the gate doesn't re-trigger renders.
  const hasTypedRef = useRef(false);
  useEffect(() => {
    if (!animationEnabled) return;
    if (liveSuffix.length > 0) {
      hasTypedRef.current = true;
    } else if (hasTypedRef.current) {
      setShowToggle(true);
    }
  }, [animationEnabled, liveSuffix]);

  if (!mounted) {
    // #372: empty placeholder shell with the same dimensions as
    // the real header so layout doesn't jump on hydration. SSR
    // and first client render produce identical HTML → no #418.
    return (
      <header
        className="sticky top-0 z-40 flex h-12 items-center justify-between border-b border-white/10 bg-neutral-950/90 px-4 backdrop-blur"
        aria-hidden="true"
      />
    );
  }

  return (
    <>
      <header className="sticky top-0 z-40 flex h-12 items-center justify-between border-b border-white/10 bg-neutral-950/90 px-4 backdrop-blur">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/" className="flex items-center gap-1.5 text-sm font-bold text-accent hover:text-blue-400 shrink-0">
            <img src="/icon.svg" alt="" width={18} height={18} className="inline-block" />
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
          {/* #430 / quadwork#312: work-hours stat block. Globally
              aggregated across all projects. Hover/focus surfaces
              the per-project breakdown from stats.by_project. */}
          {stats && (
            <div
              className="relative hidden md:flex items-center gap-2 text-[10px] text-neutral-500"
              onMouseEnter={() => setShowStatsTooltip(true)}
              onMouseLeave={() => setShowStatsTooltip(false)}
              onFocus={() => setShowStatsTooltip(true)}
              onBlur={() => setShowStatsTooltip(false)}
              tabIndex={0}
            >
              <span className="text-neutral-200">Your AI team worked:</span>
              <span>Today <span className="text-neutral-200">{fmtHours(stats.today)}</span></span>
              <span className="text-neutral-700">·</span>
              <span>Week <span className="text-neutral-200">{fmtHours(stats.week)}</span></span>
              <span className="text-neutral-700">·</span>
              <span>Month <span className="text-neutral-200">{fmtHours(stats.month)}</span></span>
              {showStatsTooltip && (
                <div className="absolute top-6 right-0 z-50 min-w-[220px] p-2 text-[10px] leading-snug text-neutral-200 bg-neutral-900 border border-white/15 rounded shadow-lg">
                  <div className="mb-1 text-neutral-400 uppercase tracking-wider text-[9px]">Per project</div>
                  {Object.entries(stats.by_project).length === 0 && (
                    <div className="text-neutral-500">No activity logged yet</div>
                  )}
                  {Object.entries(stats.by_project).map(([id, s]) => (
                    <div key={id} className="flex items-baseline gap-2">
                      <span className="text-neutral-400 truncate flex-1">{id}</span>
                      <span className="tabular-nums text-neutral-200">{fmtHours(s.month)}</span>
                      <span className="text-neutral-600 text-[9px]">/ mo</span>
                    </div>
                  ))}
                  <div className="mt-1 pt-1 border-t border-white/10 text-neutral-500">
                    Lifetime: <span className="text-neutral-200">{fmtHours(stats.total)}</span>
                  </div>
                  {/* #335 / quadwork#335: narrow scope after #338 removed
                      the home hero — only the top-header tooltip carries
                      the best-effort undercount note now. */}
                  <div className="mt-1 pt-1 border-t border-white/10 text-neutral-500 leading-snug">
                    ⓘ Stats are best-effort. Server restarts may undercount in-flight sessions.
                  </div>
                </div>
              )}
            </div>
          )}
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
