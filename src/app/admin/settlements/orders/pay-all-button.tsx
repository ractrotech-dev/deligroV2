"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatINR } from "@/lib/utils/format";
import { markShopsPaidAction } from "@/app/admin/settlements/actions";
import { MarkPaidDialog } from "../mark-paid-dialog";

/**
 * The page's main action: record that everything unpaid has been sent, as one
 * payment. The money goes by hand; nothing is sent from here.
 */
export function PayAllButton({
  restaurantId,
  shop,
  amount,
}: Readonly<{ restaurantId: string; shop: string; amount: number }>) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="c-btn c-btn-dark">
        Mark all as paid
      </button>
      {open ? (
        <MarkPaidDialog
          title="Mark all as paid"
          summary={`${shop}: ${formatINR(amount)}. Mark this only after the money has been sent.`}
          onClose={() => setOpen(false)}
          onSubmit={async (paymentRef, note) => {
            const res = await markShopsPaidAction([restaurantId], paymentRef, note);
            if (!res.ok) return res.error;
            if (res.failed.length) return res.failed[0].error;
            setOpen(false);
            router.refresh();
            return null;
          }}
        />
      ) : null}
    </>
  );
}
