"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  markPaymentUnpaidAction,
  markSettlementPaidAction,
} from "@/app/admin/settlements/actions";
import type { SettlementStatus } from "@/lib/data-access/admin-settlements";
import { formatINR } from "@/lib/utils/format";
import { MarkPaidDialog } from "./mark-paid-dialog";

/**
 * A past payment's buttons: Open, plus the one change it can take. An unfinished
 * payment can be marked paid (unless the shop owes money, when there is nothing to
 * send); a paid one can be marked unpaid, which is a reversal with a reason.
 */
export function PaymentRowActions({
  id,
  status,
  netPayable,
}: Readonly<{
  id: string;
  status: SettlementStatus;
  netPayable: number;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [marking, setMarking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const markUnpaid = () => {
    const reason = window.prompt(
      `Mark this ${formatINR(netPayable)} payment as unpaid? Its orders go back to unpaid.\n\nWhy? For example, the bank returned it.`,
      ""
    );
    if (reason === null) return;
    if (reason.trim().length < 3) {
      setMessage("Say why this should be unpaid.");
      return;
    }
    setMessage(null);
    start(async () => {
      const res = await markPaymentUnpaidAction(id, reason);
      if (!res.ok) setMessage(res.error);
      else if (res.waiting) setMessage("Asked. It stays paid until someone else approves it.");
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
        <Link href={`/admin/settlements/${id}`} className="c-btn-quiet">
          Open
        </Link>
        {status === "draft" && netPayable > 0 ? (
          <button type="button" onClick={() => setMarking(true)} className="c-btn-affirm">
            Mark as paid
          </button>
        ) : null}
        {status === "paid" ? (
          <button
            type="button"
            onClick={markUnpaid}
            disabled={pending}
            className="c-btn-quiet disabled:opacity-50"
          >
            Mark as unpaid
          </button>
        ) : null}
      </span>
      {message ? (
        <p className="max-w-[210px] text-right text-[11.5px] font-medium text-deal">{message}</p>
      ) : null}

      {marking ? (
        <MarkPaidDialog
          title="Mark as paid"
          summary={`${formatINR(netPayable)}. Mark this only after the money has been sent.`}
          onClose={() => setMarking(false)}
          onSubmit={async (paymentRef, note) => {
            const fd = new FormData();
            fd.set("id", id);
            fd.set("paymentRef", paymentRef);
            fd.set("note", note);
            const res = await markSettlementPaidAction(fd);
            if (!res.ok) {
              // Rebuilt under a new id after an adjustment: check the new amount there.
              if (res.movedTo) {
                router.push(`/admin/settlements/${res.movedTo}?changed=1`);
                return null;
              }
              return res.error;
            }
            if (res.requested) setMessage("Sent for approval.");
            setMarking(false);
            router.refresh();
            return null;
          }}
        />
      ) : null}
    </div>
  );
}
