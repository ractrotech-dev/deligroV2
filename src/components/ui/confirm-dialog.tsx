"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";

/**
 * The app's first modal. Everything else confirms with window.confirm, but a
 * password *reveal* needs to show a value, and a destructive action deserves a
 * real dialog — so this is a small tokenised portal, not a design system.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Dialogs always open from a client interaction; guard SSR for safety.
  if (!open || typeof document === "undefined") return null;

  // Portal into the phone shell, not <body>. `.app-shell` is the containing
  // block for `position: fixed` descendants (it carries a transform — see
  // globals.css), so a fixed overlay placed inside it stays within the phone
  // frame on desktop instead of spanning the whole browser window. Fall back to
  // <body> for non-framed layouts (e.g. the vendor dashboard).
  const container = document.querySelector(".app-shell") ?? document.body;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Click-outside-to-close is a real button under the panel rather than a
          click handler on the dialog itself, so the panel needs no
          stopPropagation. Out of the tab order: Escape already closes. */}
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div className="relative w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-xl">
        <h2 className="text-heading text-[17px]">{title}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>,
    container
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="text-sm text-muted">{message}</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onClose} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          size="sm"
          onClick={onConfirm}
          disabled={busy}
          className={danger ? "bg-deal shadow-none hover:brightness-105" : undefined}
        >
          {busy ? "Working…" : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
