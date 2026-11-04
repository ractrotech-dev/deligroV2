"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  markSettlementPaidAction,
  voidSettlementAction,
} from "@/app/admin/settlements/actions";
import { formatINR } from "@/lib/utils/format";

/**
 * What to do next on an unfinished payment. No shop payment is made by one person
 * (0156): a payment nobody has asked for is sent for approval; one someone else
 * asked for is approved here with the payment reference, which marks it paid; one
 * this admin asked for waits for someone else.
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
  /** The one-admin switch is on (0152): this admin may approve their own request, with a reason. */
  mayApproveOwn?: boolean;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [paymentRef, setPaymentRef] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const owes = netPayable < 0;
  const mine = pendingRequest?.requestedBy === viewerId;
  const canApprove = !owes && pendingRequest !== null && (!mine || mayApproveOwn);
  const selfApproving = canApprove && mine;
  const canRequest = !owes && pendingRequest === null;

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
        setError(result.error);
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
  } else if (pendingRequest === null) {
    message = `Next, ask another admin or a manager to approve ${amount}.`;
  } else if (mine && mayApproveOwn) {
    message = `Send ${amount} from your bank or UPI app, then write down the payment reference here.`;
  } else if (mine) {
    message = "Waiting for someone else to approve this and send the money.";
  } else {
    message = `${pendingRequest.requestedByName} asked to pay this. Send ${amount} from your bank or UPI app, then write down the payment reference here.`;
  }

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <p className="text-[14px] leading-snug text-ink">{message}</p>

      {canApprove ? (
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-ink">Payment reference (UTR)</span>
          <input
            className="h-11 w-full rounded-xl border border-line bg-bg px-3 text-ink"
            value={paymentRef}
            onChange={(e) => setPaymentRef(e.target.value)}
            placeholder="From your bank or UPI app"
            disabled={pending}
          />
        </label>
      ) : null}

      {selfApproving ? (
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-ink">Why are you approving your own payment?</span>
          <input
            className="h-11 w-full rounded-xl border border-line bg-bg px-3 text-ink"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="For example, only admin on duty this week"
            disabled={pending}
            maxLength={500}
          />
        </label>
      ) : null}

      {error ? <p className="text-sm font-medium text-deal">{error}</p> : null}
      {notice ? <p className="text-sm text-muted">{notice}</p> : null}

      <div className="flex flex-wrap gap-2">
        {canRequest ? (
          <Button type="button" size="sm" disabled={pending} onClick={submit}>
            {pending ? "Sending…" : "Send for approval"}
          </Button>
        ) : null}
        {canApprove ? (
          <Button
            type="button"
            size="sm"
            disabled={pending || !paymentRef.trim() || (selfApproving && note.trim().length < 3)}
            onClick={submit}
          >
            {pending ? "Saving…" : "I have paid"}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={cancel}
        >
          Cancel payment
        </Button>
      </div>
    </div>
  );
}
