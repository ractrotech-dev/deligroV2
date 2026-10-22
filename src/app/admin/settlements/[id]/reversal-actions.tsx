"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { approveReversalAction, requestReversalAction } from "@/app/admin/settlements/actions";

/**
 * A PAID settlement's one action. A paid record is never undone by one person
 * (0156): if the transfer did not reach the vendor, someone asks for a
 * reversal and someone else approves it, which voids the payout so its orders
 * can be paid again.
 */
export function ReversalActions({
  id,
  pendingRequest,
  viewerId,
  mayApproveOwn,
}: Readonly<{
  id: string;
  pendingRequest: { id: string; kind: string; requestedBy: string; requestedByName: string; note: string | null } | null;
  viewerId: string;
  mayApproveOwn: boolean;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reversal = pendingRequest?.kind === "settlement_reversal" ? pendingRequest : null;
  const mine = reversal?.requestedBy === viewerId;
  const canApprove = reversal !== null && (!mine || mayApproveOwn);

  const ask = () =>
    start(async () => {
      setError(null);
      const res = await requestReversalAction(id, reason);
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  const approve = () =>
    start(async () => {
      setError(null);
      if (mine && reason.trim().length < 3) {
        setError("You asked for this reversal: write a short reason to approve it yourself.");
        return;
      }
      const res = await approveReversalAction(id, reversal!.id, reason);
      if (!res.ok) setError(res.error);
      else router.refresh();
    });

  let message: string;
  if (!reversal) {
    message = "Paid. If the transfer didn't reach the vendor (it bounced), ask for a reversal. Someone else approves it, and then the orders can be paid again.";
  } else if (mine && !mayApproveOwn) {
    message = "You asked for this reversal. Someone else has to approve it.";
  } else {
    message = `${mine ? "You" : reversal.requestedByName} asked for this payout to be reversed${reversal.note ? `: “${reversal.note}”` : ""}. Approve only once you've confirmed with the bank that the money didn't arrive.`;
  }

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <p className="text-sm font-semibold text-ink">Reversal</p>
      <p className="text-sm leading-relaxed text-muted">{message}</p>
      {!reversal || canApprove ? (
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-ink">{reversal ? "Note" : "Why should it be reversed?"}</span>
          <input
            className="h-11 w-full rounded-xl border border-line bg-bg px-3 text-ink"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reversal ? "e.g. Bank confirmed the return" : "e.g. Bank returned UTR 1234"}
            disabled={pending}
            maxLength={500}
          />
        </label>
      ) : null}
      {error ? <p className="text-sm text-deal">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {!reversal ? (
          <Button type="button" size="sm" variant="outline" disabled={pending || reason.trim().length < 3} onClick={ask}>
            Ask for a reversal
          </Button>
        ) : null}
        {canApprove ? (
          <Button type="button" size="sm" disabled={pending} onClick={approve}>
            Approve reversal
          </Button>
        ) : null}
      </div>
    </div>
  );
}
