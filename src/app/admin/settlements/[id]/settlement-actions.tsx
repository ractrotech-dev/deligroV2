"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  markSettlementPaidAction,
  voidSettlementAction,
} from "@/app/admin/settlements/actions";
import { formatINR } from "@/lib/utils/format";

export function SettlementActions({
  id,
  netPayable,
}: Readonly<{
  id: string;
  netPayable: number;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [paymentRef, setPaymentRef] = useState("");
  const [error, setError] = useState<string | null>(null);

  const owes = netPayable < 0;
  const canMarkPaid = netPayable >= 0;

  const markPaid = () =>
    startTransition(async () => {
      setError(null);
      const fd = new FormData();
      fd.set("id", id);
      fd.set("paymentRef", paymentRef);
      const result = await markSettlementPaidAction(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });

  const voidDraft = () =>
    startTransition(async () => {
      setError(null);
      if (
        !window.confirm(
          "Void this draft? Orders will become available to settle again."
        )
      ) {
        return;
      }
      const result = await voidSettlementAction(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <p className="text-sm font-semibold text-ink">Actions</p>
      {owes ? (
        <p className="text-sm leading-relaxed text-muted">
          Net is negative ({formatINR(Math.abs(netPayable))} owed by the
          vendor). Collect that off-platform; this screen will not mark a payout
          as paid.
        </p>
      ) : (
        <p className="text-sm leading-relaxed text-muted">
          Remit {formatINR(netPayable)} to the vendor&apos;s bank/UPI, then
          record the UTR here. Nothing moves through the app.
        </p>
      )}

      {canMarkPaid ? (
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

      <div className="flex flex-wrap gap-2">
        {canMarkPaid ? (
          <Button
            type="button"
            size="sm"
            disabled={pending || !paymentRef.trim()}
            onClick={markPaid}
          >
            {pending ? "Saving…" : "Mark paid"}
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
