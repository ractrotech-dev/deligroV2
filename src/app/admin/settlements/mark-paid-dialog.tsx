"use client";

import { useState, useTransition } from "react";
import { Modal } from "@/components/ui/confirm-dialog";

const INPUT =
  "h-9 w-full rounded-[var(--c-r)] border border-line bg-surface px-2.5 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60";

/**
 * Asks for what makes "Mark as paid" a record: how it was paid and why. The money
 * has already gone by hand, by bank, UPI or cash; this writes it down. Stays open
 * with the error if the save fails. `key` it per open, so it starts blank.
 */
export function MarkPaidDialog({
  title,
  summary,
  onClose,
  onSubmit,
}: Readonly<{
  title: string;
  /** What is being marked, with the amount: this is the operator's last check. */
  summary: string;
  onClose: () => void;
  /** Resolves to an error to show, or null when it is done. */
  onSubmit: (paymentRef: string, note: string) => Promise<string | null>;
}>) {
  const [pending, start] = useTransition();
  const [paymentRef, setPaymentRef] = useState("");
  const [note, setNote] = useState("Paid manually");
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    start(async () => {
      setError(null);
      const failed = await onSubmit(paymentRef, note);
      if (failed) setError(failed);
    });

  return (
    <Modal open onClose={onClose} title={title}>
      <div className="space-y-3">
        <p className="text-[13px] leading-snug text-ink">{summary}</p>
        <label className="block space-y-1 text-[12.5px]">
          <span className="block font-medium text-muted">Payment reference</span>
          <input
            className={INPUT}
            value={paymentRef}
            onChange={(e) => setPaymentRef(e.target.value)}
            placeholder="UPI or bank reference. For cash, write Cash"
            disabled={pending}
            maxLength={200}
            autoFocus
          />
        </label>
        <label className="block space-y-1 text-[12.5px]">
          <span className="block font-medium text-muted">Reason</span>
          <input
            className={INPUT}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
            maxLength={500}
          />
        </label>
        {error ? <p className="text-[12.5px] font-medium text-deal">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className="c-btn c-btn-outline disabled:opacity-50">
            Close
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || !paymentRef.trim() || note.trim().length < 3}
            className="c-btn c-btn-dark disabled:opacity-50"
          >
            {pending ? "Saving…" : "Mark as paid"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** One sentence on how a mark-paid run went, naming anything that failed. */
export function markPaidOutcome(
  res: { paid: number; requested: number; failed: { id: string; error: string }[] },
  noun: string,
  nameOf: (id: string) => string
): { notice: string | null; problem: string | null } {
  const of = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const parts = [
    res.paid > 0 ? `${of(res.paid)} marked as paid.` : "",
    res.requested > 0 ? `${of(res.requested)} sent for approval.` : "",
  ].filter(Boolean);
  return {
    notice: parts.length ? parts.join(" ") : null,
    problem: res.failed.length
      ? res.failed.map((f) => `${nameOf(f.id)}: ${f.error}`).join(" ")
      : null,
  };
}
