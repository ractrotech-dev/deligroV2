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
 * A draft's actions. No vendor payment is made by one person (0156): a draft
 * nobody has asked for is sent for approval; a draft someone else asked for
 * is approved here with the UTR, which marks it paid; a draft this admin asked
 * for waits for someone else.
 */
export function SettlementActions({
  id,
  netPayable,
  pendingRequest,
  viewerId,
}: Readonly<{
  id: string;
  netPayable: number;
  pendingRequest: { id: string; requestedBy: string; requestedByName: string } | null;
  viewerId: string;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [paymentRef, setPaymentRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const owes = netPayable < 0;
  const mine = pendingRequest?.requestedBy === viewerId;
  const canApprove = !owes && pendingRequest !== null && !mine;
  const canRequest = !owes && pendingRequest === null;

  const submit = () =>
    startTransition(async () => {
      setError(null);
      setNotice(null);
      const fd = new FormData();
      fd.set("id", id);
      fd.set("paymentRef", paymentRef);
      const result = await markSettlementPaidAction(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.requested) setNotice("Sent for approval. Another admin, or a manager who can approve payments, marks it paid.");
      router.refresh();
    });

  const voidDraft = () =>
    startTransition(async () => {
      setError(null);
      const reason = window.prompt("Void this draft? Its orders become available to settle again.\n\nWhy is it being voided?", "");
      if (reason === null) return;
      if (reason.trim().length < 3) {
        setError("Say why the draft is being voided.");
        return;
      }
      const result = await voidSettlementAction(id, reason.trim());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });

  let message: string;
  if (owes) {
    message = `Net is negative (${formatINR(Math.abs(netPayable))} owed by the vendor). Collect that off-platform; this screen will not mark a payout as paid.`;
  } else if (pendingRequest === null) {
    message = `Send ${formatINR(netPayable)} for approval. Someone else — another admin, or a manager who can approve payments — remits it to the vendor's bank/UPI and records the UTR.`;
  } else if (mine) {
    message = "You sent this for approval. Someone else has to approve it and record the UTR.";
  } else {
    message = `${pendingRequest.requestedByName} sent ${formatINR(netPayable)} for approval. Remit it to the vendor's bank/UPI, then record the UTR here. Nothing moves through the app.`;
  }

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <p className="text-sm font-semibold text-ink">Actions</p>
      <p className="text-sm leading-relaxed text-muted">{message}</p>

      {canApprove ? (
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-ink">UTR / payment reference</span>
          <input
            className="h-11 w-full rounded-xl border border-line bg-bg px-3 text-ink"
            value={paymentRef}
            onChange={(e) => setPaymentRef(e.target.value)}
            placeholder="Bank UTR or UPI ref"
            disabled={pending}
          />
        </label>
      ) : null}

      {error ? <p className="text-sm text-deal">{error}</p> : null}
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
            disabled={pending || !paymentRef.trim()}
            onClick={submit}
          >
            {pending ? "Saving…" : "Approve and mark paid"}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={voidDraft}
        >
          Void draft
        </Button>
      </div>
    </div>
  );
}
