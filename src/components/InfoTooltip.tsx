"use client";

import { useState, useRef, useEffect } from "react";

interface InfoTooltipProps {
  children: React.ReactNode;
}

/**
 * #407: Reusable (?) info tooltip button. Click to toggle a popover
 * with help text. Dismisses on click-outside or Escape.
 *
 * Matches the existing pattern from ControlBar (#311) and
 * AgentTerminalsGrid — consistent `w-3.5 h-3.5 rounded-full`
 * styling with accent hover.
 */
export default function InfoTooltip({ children }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-3.5 h-3.5 rounded-full border border-border text-[9px] leading-none text-text-muted hover:text-accent hover:border-accent inline-flex items-center justify-center"
      >?</button>
      {open && (
        <div className="absolute left-0 top-5 z-30 w-64 p-2 text-[10px] leading-snug text-text bg-bg-surface border border-border rounded shadow-lg">
          {children}
        </div>
      )}
    </div>
  );
}
