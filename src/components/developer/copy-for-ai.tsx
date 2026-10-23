"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/**
 * Copies a ready-made report (see `lib/developer/ai-report.ts`) to the
 * clipboard, to paste into an AI assistant or a ticket.
 *
 * The text is rendered into the page by the server component that owns the
 * data, so the button never fetches anything. Falls back to a hidden textarea
 * where the async clipboard is unavailable (an http preview, an old browser).
 */
export function CopyForAI({
  text,
  label = "Copy for AI",
  className,
}: Readonly<{
  text: string | null;
  label?: string;
  className?: string;
}>) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  if (!text) return null;

  const copy = async (e: React.MouseEvent) => {
    // Inside a <summary> a click would also toggle the row.
    e.preventDefault();
    e.stopPropagation();
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      area.remove();
    }
    setState(ok ? "copied" : "failed");
    setTimeout(() => setState("idle"), 1800);
  };

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy a detailed report you can paste into an AI assistant"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-[11.5px] font-semibold text-ink hover:border-ink/30",
        state === "copied" && "border-green/40 text-green",
        state === "failed" && "border-deal/40 text-deal",
        className
      )}
    >
      {state === "copied" ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}
