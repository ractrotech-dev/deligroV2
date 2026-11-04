"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PayButton,
  PayHero,
  PayoutOrderList,
  PayToCard,
  payWord,
} from "@/components/admin/payout-breakdown";
import { createSettlementAction } from "@/app/admin/settlements/actions";
import { downloadBrandedWorkbook } from "@/lib/reports/xlsx";
import { itemsLabel } from "@/lib/settlements/math";
import { MarkOrderPaid } from "./mark-order-paid";
import type {
  SettlementLine,
  SettlementPreview,
} from "@/lib/data-access/admin-settlements";

function markPaidAction(line: SettlementLine) {
  if (line.contribution <= 0) return null;
  return (
    <MarkOrderPaid
      orderId={line.orderId}
      code={line.code}
      amount={line.contribution}
    />
  );
}

/** One shop, for the dates chosen: the amount to send, and a button to pay it. */
export function SettlementPreviewPanel({
  preview,
  fromDate,
  toDate,
}: Readonly<{
  preview: SettlementPreview;
  fromDate: string;
  toDate: string;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const create = () =>
    startTransition(async () => {
      setError(null);
      const fd = new FormData();
      fd.set("restaurantId", preview.restaurantId);
      fd.set("fromDate", fromDate);
      fd.set("toDate", toDate);

      const result = await createSettlementAction(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.id) router.push(`/admin/settlements/${result.id}`);
    });

  const owesPlatform = preview.netPayable < 0;
  const customersPaid = preview.lines.reduce((sum, l) => sum + l.orderTotal, 0);

  /**
   * The full statement for the shop's accountant. Numbers go out as numbers, so
   * Excel can add them up. Every deduction stays itemised here, off the screen.
   */
  const toExcel = () =>
    downloadBrandedWorkbook({
      filename: `settlement-${preview.restaurantName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      sheetName: "Settlement",
      title: `Settlement statement — ${preview.restaurantName}`,
      subtitle: preview.periodLabel,
      meta: [
        ["Vendor", preview.restaurantName],
        ["Period", preview.periodLabel],
        ["Orders", preview.lines.length],
        ["Commission", `${preview.commissionPct}%`],
        ["GST on commission", `${preview.commissionGstPct}%`],
        [
          owesPlatform ? "Shop owes Deligro (₹)" : "Send to the shop (₹)",
          Math.abs(preview.netPayable),
        ],
      ],
      columns: [
        { key: "code", label: "Order" },
        { key: "items", label: "Ordered" },
        { key: "delivered", label: "Delivered" },
        { key: "paidBy", label: "Paid by" },
        { key: "customerPaid", label: "Customer paid (₹)" },
        { key: "food", label: "Food (₹)" },
        { key: "commission", label: "Commission (₹)" },
        { key: "gst", label: "GST (₹)" },
        { key: "other", label: "Other (₹)" },
        { key: "refund", label: "Refund (₹)" },
        { key: "shopGets", label: "Shop gets (₹)" },
      ],
      rows: preview.lines.map((l) => ({
        code: l.code,
        items: itemsLabel(l.items),
        delivered: new Date(l.deliveredAt).toLocaleDateString("en-IN"),
        paidBy: payWord(l),
        customerPaid: l.orderTotal,
        food: l.foodGross,
        commission: l.commission,
        gst: l.commissionGst,
        other: l.otherCharges,
        refund: l.refundRecovered,
        shopGets: l.contribution,
      })),
      totals: {
        code: "Total",
        customerPaid: customersPaid,
        food: preview.foodGross,
        commission: preview.commission,
        gst: preview.commissionGst,
        other: preview.otherCharges,
        refund: preview.refundsRecovered,
        shopGets: preview.netPayable,
      },
    });

  return (
    <div className="space-y-4">
      <PayHero
        shop={preview.restaurantName}
        amount={preview.netPayable}
        orderCount={preview.lines.length}
        note={preview.periodLabel}
      >
        {preview.netPayable > 0 ? (
          <>
            <PayToCard payout={preview.payout} />
            {error ? (
              <p className="text-[13px] font-medium text-deal">{error}</p>
            ) : null}
            <PayButton disabled={pending} onClick={create}>
              {pending ? "One moment…" : "Pay these orders"}
            </PayButton>
          </>
        ) : null}
      </PayHero>

      {preview.lines.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface-2 px-3.5 py-3 text-sm text-muted">
          No unpaid orders on these dates.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[14px] font-semibold text-ink">Orders</p>
            <Button type="button" size="sm" variant="secondary" onClick={toExcel}>
              <Download className="size-4" /> Save as Excel
            </Button>
          </div>
          <PayoutOrderList
            lines={preview.lines}
            commissionPct={preview.commissionPct}
            commissionGstPct={preview.commissionGstPct}
            rowAction={markPaidAction}
          />
        </div>
      )}
    </div>
  );
}
