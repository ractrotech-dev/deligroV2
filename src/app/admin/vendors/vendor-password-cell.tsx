"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/confirm-dialog";
import { fieldCls } from "@/components/ui/field";
import { cn } from "@/lib/utils/cn";
import { focusOnMount } from "@/lib/utils/focus";
import {
  resetVendorPasswordAction,
  setVendorPasswordAction,
} from "./actions";

/**
 * The login password column on the admin vendor table.
 *
 * Hidden by default and revealed per row on purpose. The admin desk needs to
 * read a password back to an owner who has lost theirs, but a list of forty
 * shops with forty live credentials printed down one column is a screenshot, a
 * shoulder-surf and a support-call recording waiting to happen. One row at a
 * time is the whole difference.
 *
 * "New" generates and stores a fresh legible password; "Set" takes one the
 * operator typed, for the owner who wants something memorable. Both replace the
 * vendor's current login immediately — the confirm before "New" exists because
 * that is easy to click by accident while scanning a table.
 */
export function VendorPasswordCell({
  id,
  name,
  password,
}: {
  id: string;
  name: string;
  /** The stored password, or null when none has been issued yet. */
  password: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The action's own return value, so a freshly generated password appears
  // without waiting for the router refresh to land.
  const [issued, setIssued] = useState<string | null>(null);

  const value = issued ?? password;

  const regenerate = () => {
    if (
      !window.confirm(
        `Generate a new password for ${name}? Their current password stops working straight away.`
      )
    ) {
      return;
    }
    setError(null);
    start(async () => {
      const res = await resetVendorPasswordAction(id);
      if (!res.ok || !res.tempPassword) {
        setError(res.error ?? "Couldn't generate a password.");
        return;
      }
      setIssued(res.tempPassword);
      setShown(true);
      setCopied(false);
      router.refresh();
    });
  };

  const save = () => {
    setError(null);
    start(async () => {
      const res = await setVendorPasswordAction(id, draft);
      if (!res.ok) {
        setError(res.error ?? "Couldn't set the password.");
        return;
      }
      setIssued(draft.trim());
      setEditing(false);
      setDraft("");
      setShown(true);
      router.refresh();
    });
  };

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
    "press grid size-7 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40";

  return (
    <div className="flex items-center gap-1">
      <code
        className={cn(
          "text-data min-w-0 flex-1 truncate text-[12.5px] font-semibold",
          value ? "text-ink" : "text-muted"
        )}
        title={shown && value ? value : undefined}
      >
        {!value ? "Not issued" : shown ? value : "••••••••••"}
      </code>

      {value ? (
        <>
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            className={chip}
            title={shown ? "Hide password" : "Show password"}
            aria-label={shown ? "Hide password" : "Show password"}
          >
            {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={copy}
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
        </>
      ) : null}

      <button
        type="button"
        onClick={regenerate}
        disabled={pending}
        className={cn(chip, "text-violet-500 hover:bg-violet-500/15")}
        title="Generate a new password"
        aria-label="Generate a new password"
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : value ? (
          <RefreshCw className="size-3.5" />
        ) : (
          <KeyRound className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={() => {
          setDraft("");
          setError(null);
          setEditing(true);
        }}
        disabled={pending}
        className={cn(chip, "w-auto px-1.5 text-[11px] font-bold text-accent-ink")}
        title="Set a specific password"
      >
        Set
      </button>

      {error ? (
        <span className="text-[11px] font-medium text-deal">{error}</span>
      ) : null}

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title="Set a password"
      >
        <p className="text-sm text-muted">
          Choose the login password for <b className="text-ink">{name}</b>. It
          replaces their current one immediately, and is saved here so you can
          read it back to them later.
        </p>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim().length >= 8) save();
          }}
          className={`${fieldCls} mt-3 font-mono`}
          placeholder="At least 8 characters"
          ref={focusOnMount}
          spellCheck={false}
          autoComplete="off"
          aria-label="New password"
        />
        {error ? (
          <p className="mt-2 text-xs font-medium text-deal">{error}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setEditing(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={pending || draft.trim().length < 8}
          >
            {pending ? "Saving…" : "Set password"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
