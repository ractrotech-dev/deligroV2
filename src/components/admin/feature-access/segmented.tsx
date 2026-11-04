"use client";

import { cn } from "@/lib/utils/cn";

function selectedTone(v: string): string {
  if (v === "off") return "bg-deal-soft text-deal";
  if (v === "on") return "bg-green-soft text-green";
  return "bg-surface-2 text-ink";
}

/** On / Off, or Same as everyone / On / Off: the one switch control in App features. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  value: T;
  options: [T, string][];
  disabled: boolean;
  onChange: (v: T) => void;
}>) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-[var(--c-r)] border border-line p-0.5">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          onClick={() => value !== v && onChange(v)}
          className={cn(
            "press h-7 whitespace-nowrap rounded-[5px] px-2.5 text-[12px] font-semibold disabled:opacity-60",
            value === v ? selectedTone(v) : "text-muted"
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
