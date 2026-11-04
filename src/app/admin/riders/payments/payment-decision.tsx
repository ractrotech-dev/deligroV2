"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fieldCls } from "@/components/ui/field";
import { formatMoney } from "@/lib/rider/admin-money";
import { decideRiderPaymentAction } from "./actions";

/**
 * Approve or reject one waiting payment. Approving records money already sent,
 * so it asks for the bank or UPI reference. Approving your own request (the
 * one-admin rule) also asks for a reason, which goes on the record.
 */
export function PaymentDecision({
  requestId,
  amount,
  periodEnd,
  today,
  mine,
  canDecide,
}: Readonly<{
  requestId: string;
  amount: number;
  periodEnd: string | null;
  today: string;
  /** This admin asked for it. */
  mine: boolean;
  canDecide: boolean;
}>) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState<"approve" | "reject" | null>(null);
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmAmount, setConfirmAmount] = useState<number | null>(null);

  const send = (decision: "approve" | "reject" | "cancel") => {
    setError(null);
    start(async () => {
      const result = await decideRiderPaymentAction({ requestId, decision, reference, paidOn, confirmAmount, note });
      if (!result.ok) {
        setError(result.error ?? "That didn't go through. Try again.");
        if (result.newAmount !== undefined) setConfirmAmount(result.newAmount);
        return;
      }
      router.refresh();
    });
  };

  const shown = confirmAmount ?? amount;
  const reasonMissing = mine && note.trim().length < 3;

  return (
    <div className="flex flex-col items-end gap-2 whitespace-normal">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {canDecide ? (
          <>
            <button type="button" disabled={busy} onClick={() => setOpen(open === "approve" ? null : "approve")} className="c-btn-affirm disabled:opacity-50">
              Approve
            </button>
            <button type="button" disabled={busy} onClick={() => setOpen(open === "reject" ? null : "reject")} className="c-btn-deny disabled:opacity-50">
              Reject
            </button>
          </>
        ) : null}
        {mine ? (
          <button type="button" disabled={busy} onClick={() => send("cancel")} className="c-btn-quiet disabled:opacity-50">
            Cancel
          </button>
        ) : null}
        {mine && !canDecide ? <span className="text-[12px] text-muted">Someone else must approve this</span> : null}
      </div>

      {open === "approve" ? (
        <div className="w-[280px] space-y-2 text-left">
          <p className="text-[12.5px] text-ink">Send {formatMoney(shown)} from your bank or UPI app, then record it here.</p>
          <label className="block text-[12px] font-medium text-muted">
            Payment reference
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={80}
              placeholder="From your bank or UPI app; for cash, a receipt number"
              className={`${fieldCls} mt-1`}
              disabled={busy}
            />
          </label>
          <label className="block text-[12px] font-medium text-muted">
            Paid on
            <input
              type="date"
              value={paidOn}
              min={periodEnd ?? undefined}
              max={today}
              onChange={(e) => setPaidOn(e.target.value)}
              className={`${fieldCls} mt-1`}
              disabled={busy}
            />
          </label>
          <label className="block text-[12px] font-medium text-muted">
            {mine ? "Reason for paying" : "Note (optional)"}
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder={mine ? "For example, October salary" : undefined}
              className={`${fieldCls} mt-1`}
              disabled={busy}
            />
          </label>
          <button
            type="button"
            disabled={busy || !reference.trim() || reasonMissing}
            onClick={() => send("approve")}
            className="c-btn c-btn-dark disabled:opacity-50"
          >
            {busy ? "Saving…" : `I have paid ${formatMoney(shown)}`}
          </button>
        </div>
      ) : null}

      {open === "reject" ? (
        <div className="w-[280px] space-y-2 text-left">
          <label className="block text-[12px] font-medium text-muted">
            Why are you rejecting it?
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={`${fieldCls} mt-1`} disabled={busy} />
          </label>
          <button type="button" disabled={busy || note.trim().length < 3} onClick={() => send("reject")} className="c-btn c-btn-outline disabled:opacity-50">
            {busy ? "Saving…" : "Reject"}
          </button>
        </div>
      ) : null}

      {error ? <p className="max-w-[280px] text-right text-[12px] font-medium text-deal">{error}</p> : null}
    </div>
  );
}
