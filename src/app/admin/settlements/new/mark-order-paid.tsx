"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { formatINR } from "@/lib/utils/format";
import { setOrderPaidAction } from "@/app/admin/settlements/actions";

/**
 * "We already paid this one" — settled on the spot, from the preview table.
 *
 * The case it exists for: an operator pays a shop for a single delivery in cash
 * or over UPI during the week, then builds the weekly batch and has to remember
 * to leave that order out. Marking it here records the payment as a one-order
 * settlement (`setOrderPaidAction`, migration 0034) — the same record the Order
 * payouts screen writes — and because `previewSettlement` skips any order that
 * already sits in a settlement, the row drops out of this list and out of the
 * batch total on the next render. The arithmetic is not adjusted by hand
 * anywhere; the order simply stops being unsettled.
 *
 * That is also why this is not a checkbox: it writes a payment record with a
 * reference, and it is undone by voiding that record, not by unticking a box.
 * The confirm names the amount for the same reason — this is money leaving.
 */
export function MarkOrderPaid({
  orderId,
  code,
  amount,
}: Readonly<{
  orderId: string;
  code: string;
  amount: number;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const mark = () => {
    const ref = window.prompt(
      `Record ${formatINR(Math.abs(amount))} as already paid for order ${code}?\n\n` +
        `It comes out of this settlement and is filed as its own payment. ` +
        `Enter the UPI / bank reference if you have one — you can add it later.`,
      ""
    );
    // Cancel returns null; an empty string is a deliberate "no reference yet".
    if (ref === null) return;

    setError(null);
    start(async () => {
      const result = await setOrderPaidAction(orderId, true, ref.trim() || undefined);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={mark}
        disabled={pending}
        className="press inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-muted hover:border-green/40 hover:text-green disabled:opacity-50"
      >
        {pending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Check className="size-3" />
        )}
        Mark paid
      </button>
      {error ? (
        <span className="max-w-[180px] text-right text-[10.5px] leading-snug text-deal">
          {error}
        </span>
      ) : null}
    </span>
  );
}
