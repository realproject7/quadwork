"use client";

// #814: compact Active/Inactive switch. ON (accent #00ff88) = Active
// (idle:false), OFF (muted) = Inactive/parked (idle:true) — the switch shows
// `active = !project.idle`. Sharp-cornered, monospace aesthetic — deliberately
// NOT the rounded iOS-blue style. Stops click propagation so it works inside a
// clickable nav row.
interface ActiveSwitchProps {
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title?: string;
}

export default function ActiveSwitch({ active, onToggle, disabled, title }: ActiveSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      disabled={disabled}
      title={title || (active ? "Active — click to set Inactive (park)" : "Inactive — click to set Active (resume)")}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) onToggle();
      }}
      className={`relative inline-flex h-3 w-6 shrink-0 items-center border transition-colors duration-150 disabled:opacity-50 ${
        active ? "border-accent bg-accent/15" : "border-border bg-transparent hover:border-text-muted"
      }`}
    >
      <span
        className={`block h-2 w-2 transition-transform duration-150 ${
          active ? "translate-x-[14px] bg-accent" : "translate-x-[2px] bg-text-muted"
        }`}
      />
    </button>
  );
}
