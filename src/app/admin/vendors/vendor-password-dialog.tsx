"use client";

import { useState, useTransition } from "react";
import { Modal } from "@/components/ui/confirm-dialog";
import { fieldCls } from "@/components/ui/field";
import { focusOnMount } from "@/lib/utils/focus";
import { resetVendorPasswordAction, setVendorPasswordAction } from "./actions";

/**
 * The one way to reset a vendor's password, from the table and the shop's Access
 * tab. One button: with the field empty Deligro makes a password, otherwise the
 * typed one is used. Either replaces the current login immediately.
 */
export function VendorPasswordDialog({
  id,
  name,
  open,
  onClose,
  onDone,
}: Readonly<{
  id: string;
  name: string;
  open: boolean;
  onClose: () => void;
  /** Receives the new password, so the caller can show it straight away. */
  onDone: (password: string) => void;
}>) {
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const typed = draft.trim();
  const canSubmit = !pending && (typed.length === 0 || typed.length >= 8);

  const close = () => {
    setDraft("");
    setError(null);
    onClose();
  };

  const submit = () => {
    if (!canSubmit) return;
    setError(null);
    start(async () => {
      let password: string;
      if (typed) {
        const res = await setVendorPasswordAction(id, typed);
        if (!res.ok) {
          setError(res.error ?? "Couldn't reset the password.");
          return;
        }
        password = typed;
      } else {
        const res = await resetVendorPasswordAction(id);
        if (!res.ok || !res.tempPassword) {
          setError(res.error ?? "Couldn't reset the password.");
          return;
        }
        password = res.tempPassword;
      }
      setDraft("");
      onDone(password);
      onClose();
    });
  };

  return (
    <Modal open={open} onClose={close} title="Reset password">
      <p className="text-sm text-muted">
        <b className="text-ink">{name}</b>&apos;s current password stops working
        straight away. The new one is saved here so you can read it back to them.
      </p>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        className={`${fieldCls} mt-3 font-mono`}
        placeholder="Leave empty and Deligro makes one"
        ref={focusOnMount}
        spellCheck={false}
        autoComplete="off"
        aria-label="New password"
      />
      <p className="mt-1.5 text-[11px] text-muted">If you type one, use at least 8 characters.</p>
      {error ? <p className="mt-2 text-xs font-medium text-deal">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="c-btn c-btn-outline" onClick={close} disabled={pending}>
          Cancel
        </button>
        <button type="button" className="c-btn c-btn-dark disabled:opacity-50" onClick={submit} disabled={!canSubmit}>
          {pending ? "Resetting…" : "Reset password"}
        </button>
      </div>
    </Modal>
  );
}
