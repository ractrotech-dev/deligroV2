"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  markSettlementPaidAction,
  voidSettlementAction,
} from "@/app/admin/settlements/actions";
import { formatINR } from "@/lib/utils/format";

/**
 * What to do next on an unfinished payment.
 *
 * Under the one-admin rule (0152, on by default) an admin finishes it here in one
 * step: send the money, enter the reference and a reason, done. A request someone
 * else made is approved the same way, with no reason needed. With the rule off, a
 * payment nobody has asked for is sent for approval, and one this admin asked for
 * waits for someone else.
 *
 * An old adjustment can change the amount while the payment waits. It is then rebuilt under
 * a new id, and this takes the person straight to it to check the new amount.
 */
export function SettlementActions({
  id,
  netPayable,
  pendingRequest,
  viewerId,
  mayApproveOwn = false,
}: Readonly<{
  id: string;
  netPayable: number;
  pendingRequest: { id: string; requestedBy: string; requestedByName: string } | null;
  viewerId: string;
  /** The one-admin rule is on: this admin may finish their own payment, with a reason. */
  mayApproveOwn?: boolean;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [paymentRef, setPaymentRef] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const owes = netPayable < 0;
  const mine = pendingRequest === null || pendingRequest.requestedBy === viewerId;
  const canApprove = !owes && (!mine || mayApproveOwn);
  const selfApproving = canApprove && mine;
  const canRequest = !owes && pendingRequest === null && !mayApproveOwn;

  const submit = () =>
    startTransition(async () => {
      setError(null);
      setNotice(null);
      const fd = new FormData();
      fd.set("id", id);
      fd.set("paymentRef", paymentRef);
      fd.set("note", note);
      const result = await markSettlementPaidAction(fd);
      if (!result.ok) {
        // Rebuilt under a new id: this page's payment is gone, so go to the new one.
        if (result.movedTo) {
          router.push(`/admin/settlements/${result.movedTo}?changed=1`);
          return;
        }
        setError(result.error);
        router.refresh();
        return;
      }
      if (result.requested) setNotice("Sent for approval.");
      router.refresh();
    });

  const cancel = () =>
    startTransition(async () => {
      setError(null);
      const reason = window.prompt("Cancel this payment? Its orders go back to unpaid.\n\nWhy are you cancelling it?", "");
      if (reason === null) return;
      if (reason.trim().length < 3) {
        setError("Say why you are cancelling this payment.");
        return;
      }
      const result = await voidSettlementAction(id, reason.trim());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });

  const amount = formatINR(Math.abs(netPayable));
  let message: string;
  if (owes) {
    message = `This shop owes you ${amount}, so there is nothing to send. Cancel this payment; it comes off their next one.`;
  } else if (canRequest) {
    message = `Next, ask another admin or a manager to approve ${amount}.`;
  } else if (selfApproving) {
    message = `Send ${amount} from your bank or UPI app, then write down the payment reference here.`;
  } else if (mine) {
    message = "Waiting for someone else to approve this and send the money.";
  } else {
    message = `${pendingRequest?.requestedByName ?? "Someone"} asked to pay this. Send ${amount} from your bank or UPI app, then write down the payment reference here.`;
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-snug text-ink">{message}</p>

      {canApprove ? (
        <label className="block space-y-1 text-[12.5px]">
          <span className="block font-medium text-muted">Payment reference</span>
          <input
            className="h-9 w-full max-w-[320px] rounded-[var(--c-r)] border border-line bg-surface px-2.5 text-[13px] text-ink"
            value={paymentRef}
            onChange={(e) => setPaymentRef(e.target.value)}
            placeholder="From your bank or UPI app"
            disabled={pending}
          />
        </label>
      ) : null}

      {selfApproving ? (
        <label className="block space-y-1 text-[12.5px]">
          <span className="block font-medium text-muted">Reason for this payment</span>
          <input
            className="h-9 w-full max-w-[320px] rounded-[var(--c-r)] border border-line bg-surface px-2.5 text-[13px] text-ink"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="For example, weekly shop payment"
            disabled={pending}
            maxLength={500}
          />
        </label>
      ) : null}

      {error ? <p className="text-[12.5px] font-medium text-deal">{error}</p> : null}
      {notice ? <p className="text-[12.5px] text-muted">{notice}</p> : null}

      <div className="flex flex-wrap gap-2">
        {canRequest ? (
          <button
            type="button"
            disabled={pending}
            onClick={submit}
            className="c-btn c-btn-dark disabled:opacity-50"
          >
            {pending ? "Sending…" : "Send for approval"}
          </button>
        ) : null}
        {canApprove ? (
          <button
            type="button"
            disabled={pending || !paymentRef.trim() || (selfApproving && note.trim().length < 3)}
            onClick={submit}
            className="c-btn c-btn-dark disabled:opacity-50"
          >
            {pending ? "Saving…" : "I have paid"}
          </button>
        ) : null}
        <button
          type="button"
          disabled={pending}
          onClick={cancel}
          className="c-btn c-btn-outline disabled:opacity-50"
        >
          Cancel payment
        </button>
      </div>
    </div>
  );
}
