"use client";

interface PanelHeaderProps {
  label: string;
  status?: "running" | "stopped" | "error";
}

export default function PanelHeader({ label, status }: PanelHeaderProps) {
  const dotColor =
    status === "running"
      ? "bg-accent"
      : status === "error"
        ? "bg-error"
        : "bg-text-muted";

  return (
    <div className="flex items-center gap-2 px-3 h-7 shrink-0 border-b border-border">
      {status && (
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
      )}
      <span className="text-[11px] text-text-muted uppercase tracking-wider">
        {label}
      </span>
    </div>
  );
}
