"use client";

import { useEffect } from "react";

// #814: small reusable confirmation modal (dark / sharp-corners / monospace).
// Used for the "Set Inactive?" confirmation in the sidebar and settings.
interface ConfirmModalProps {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  // Esc cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="mx-4 max-w-sm border border-border bg-bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-[13px] font-semibold text-text">{title}</h2>
        <p className="mb-4 text-[11px] leading-relaxed text-text-muted">{body}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border border-border px-3 py-1 text-[11px] text-text-muted transition-colors hover:text-text"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="border border-accent bg-accent/10 px-3 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/20"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
