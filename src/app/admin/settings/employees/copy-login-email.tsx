"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** The login email on a Team row, with a button that copies it. */
export function CopyLoginEmail({ email }: Readonly<{ email: string }>) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the email is on screen to select by hand */
    }
  };

  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate text-ink">{email}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Email copied" : `Copy ${email}`}
        title={copied ? "Copied" : "Copy email"}
        className="grid size-6 shrink-0 place-items-center rounded-[var(--c-r)] text-muted hover:bg-surface-2 hover:text-ink"
      >
        {copied ? <Check className="size-3.5 text-green" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}
