"use client";

import { useEffect } from "react";
import OvernightQueueWidget from "./OvernightQueueWidget";

interface OvernightQueueModalProps {
  open: boolean;
  projectId: string;
  onClose: () => void;
}

/**
 * Modal wrapper around <OvernightQueueWidget /> for #226.
 *
 * The queue widget moved out of the bottom-right Operator Features
 * panel and into a compact "OVERNIGHT-QUEUE.md [Edit]" row at the
 * bottom of the GitHub panel. Click Edit → this modal opens with
 * the same widget content (auto-refresh + view/edit toggle + save +
 * warning banner — all unchanged).
 */
export default function OvernightQueueModal({ open, projectId, onClose }: OvernightQueueModalProps) {
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
      aria-labelledby="queue-modal-title"
    >
      <div
        className="relative mx-4 w-full max-w-3xl h-[80vh] flex flex-col rounded-lg border border-white/10 bg-neutral-950 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
          <h2 id="queue-modal-title" className="text-[12px] font-semibold text-white">
            OVERNIGHT-QUEUE.md
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-neutral-400 hover:bg-white/5 hover:text-white"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 4l12 12M16 4L4 16" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <OvernightQueueWidget projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
