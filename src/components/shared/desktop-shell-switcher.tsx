"use client";

import { Monitor, Smartphone } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { ShellMode } from "@/lib/shell-mode";

// Re-exported for the shells and hooks that have always imported the type from
// here. The definition itself lives with the concept, in `lib/shell-mode.ts`,
// so the server resolver and this button cannot drift apart.
export type { ShellMode };

/**
 * The app ↔ web layout switch, in two placements.
 *
 * `ShellModeToggle` is the control itself, with no positioning of its own, so a
 * shell that has a real header can sit it among that header's other controls —
 * which is where a layout switch belongs, next to the things that change what
 * you are looking at rather than floating over the content.
 *
 * `DesktopShellSwitcher` is the floating placement, still needed by shells that
 * have no console header to put it in: the phone-frame preview is a 390px
 * device on a bare backdrop, and the vendor console's top bar is `lg:hidden`.
 *
 * Both are hidden below 480px. A real phone never gets the console layout, so
 * an operator on a handset must never see a control offering it.
 */
export function ShellModeToggle({
  mode,
  onChange,
  hydrated,
  className,
}: Readonly<{
  mode: ShellMode;
  onChange: (mode: ShellMode) => void;
  hydrated: boolean;
  className?: string;
}>) {
  return (
    <div
      role="group"
      aria-label="Layout"
      className={cn(
        // Same shape as RangeTabs, so the header reads as one set of controls
        // rather than a header plus a transplanted floating widget.
        "hidden items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 min-[480px]:flex",
        className
      )}
    >
      <ModeButton
        active={mode === "app"}
        disabled={!hydrated}
        onClick={() => onChange("app")}
        icon={<Smartphone className="size-3.5" />}
        label="App"
      />
      <ModeButton
        active={mode === "web"}
        disabled={!hydrated}
        onClick={() => onChange("web")}
        icon={<Monitor className="size-3.5" />}
        label="Web"
      />
    </div>
  );
}

/** Floating placement, for shells with no header to host the toggle. */
export function DesktopShellSwitcher({
  mode,
  onChange,
  hydrated,
}: Readonly<{
  mode: ShellMode;
  onChange: (mode: ShellMode) => void;
  hydrated: boolean;
}>) {
  return (
    <div className="shell-switcher pointer-events-none fixed bottom-5 right-5 z-[100] hidden min-[480px]:block">
      <div className="pointer-events-auto rounded-2xl border border-line bg-surface/95 p-1 shadow-[var(--shadow-lg)] backdrop-blur-md">
        <ShellModeToggle
          mode={mode}
          onChange={onChange}
          hydrated={hydrated}
          className="border-0 bg-transparent p-0"
        />
      </div>
    </div>
  );
}

function ModeButton({
  active,
  disabled,
  onClick,
  icon,
  label,
}: Readonly<{
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}>) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "press flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-[5px] text-[12px] font-semibold transition-colors disabled:opacity-40",
        active
          ? "bg-ink text-[color:var(--surface)]"
          : "text-muted hover:bg-surface-2 hover:text-ink"
      )}
    >
      {icon}
      {label}
    </button>
  );
}
