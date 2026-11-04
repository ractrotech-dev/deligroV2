"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PayButton } from "@/components/admin/payout-breakdown";
import { formatINR } from "@/lib/utils/format";
import { payAllUnpaidAction } from "@/app/admin/settlements/actions";

/**
 * The page's main action. It builds one payment covering everything unpaid and
 * opens it, where the money is approved, sent and recorded. Nothing is sent here.
 */
export function PayAllButton({
  restaurantId,
  amount,
}: Readonly<{ restaurantId: string; amount: number }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const pay = () => {
    setError(null);
    start(async () => {
      const res = await payAllUnpaidAction(restaurantId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.id) router.push(`/admin/settlements/${res.id}`);
    });
  };

  return (
    <div className="space-y-2">
      <PayButton onClick={pay} disabled={pending}>
        {pending ? "One moment…" : `Pay ${formatINR(amount)}`}
      </PayButton>
      {error ? <p className="text-[13px] font-medium text-deal">{error}</p> : null}
    </div>
  );
}
