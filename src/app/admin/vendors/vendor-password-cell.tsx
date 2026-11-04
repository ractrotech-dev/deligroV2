"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { VendorPasswordDialog } from "./vendor-password-dialog";

/** The cell's text: nothing issued, the password once revealed, else a mask. */
function passwordText(value: string | null, shown: boolean): string {
  if (!value) return "Not issued";
  return shown ? value : "••••••••••";
}

/**
 * The login password column on the admin vendor table.
 *
 * Hidden by default and revealed per row on purpose. The admin desk needs to
 * read a password back to an owner who has lost theirs, but a list of forty
 * shops with forty live credentials printed down one column is a screenshot, a
 * shoulder-surf and a support-call recording waiting to happen. One row at a
 * time is the whole difference.
 *
 * Copy only appears once the password is showing. Resetting goes through the one
 * dialog that the shop's Access tab uses too.
 */
export function VendorPasswordCell({
  id,
  name,
  password,
}: Readonly<{
  id: string;
  name: string;
  /** The stored password, or null when none has been issued yet. */
  password: string | null;
}>) {
  const router = useRouter();
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  // The action's own return value, so a freshly generated password appears
  // without waiting for the router refresh to land.
  const [issued, setIssued] = useState<string | null>(null);

  const value = issued ?? password;

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard blocked — the value can still be revealed and typed.
    }
  };

  const chip =
    "grid size-7 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40";

  return (
    <div className="flex items-center gap-1">
      <code
        className={cn(
          "text-data min-w-0 flex-1 truncate text-[12.5px] font-semibold",
          value ? "text-ink" : "text-muted"
        )}
        title={shown && value ? value : undefined}
      >
        {passwordText(value, shown)}
      </code>

      {value ? (
        <RevealAndCopy
          shown={shown}
          copied={copied}
          chip={chip}
          onToggle={() => {
            setShown((s) => !s);
            setCopied(false);
          }}
          onCopy={copy}
        />
      ) : null}

      <button
        type="button"
        onClick={() => setEditing(true)}
        className="c-btn c-btn-outline shrink-0"
      >
        Reset password
      </button>

      <VendorPasswordDialog
        id={id}
        name={name}
        open={editing}
        onClose={() => setEditing(false)}
        onDone={(next) => {
          setIssued(next);
          setShown(true);
          setCopied(false);
          router.refresh();
        }}
      />
    </div>
  );
}

/** Show / hide and copy, for a row that has a password to act on. */
function RevealAndCopy({
  shown,
  copied,
  chip,
  onToggle,
  onCopy,
}: Readonly<{
  shown: boolean;
  copied: boolean;
  chip: string;
  onToggle: () => void;
  onCopy: () => void;
}>) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        className={chip}
        title={shown ? "Hide password" : "Show password"}
        aria-label={shown ? "Hide password" : "Show password"}
      >
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
      {shown ? (
        <button
          type="button"
          onClick={onCopy}
          className={chip}
          title="Copy password"
          aria-label="Copy password"
        >
          {copied ? (
            <Check className="size-3.5 text-green" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
      ) : null}
    </>
  );
}
