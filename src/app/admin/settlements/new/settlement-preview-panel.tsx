"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import {
  Empty,
  Section,
  SectionCol,
  SectionRow,
} from "@/components/admin/console";
import type { Column } from "@/components/admin/data-table";
import {
  PayFigure,
  PayoutLinesTable,
  PayToList,
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

const PAY_ONE_COLUMN: Column<SettlementLine>[] = [
  {
    key: "payOne",
    header: "",
    align: "right",
    cell: (line) =>
      line.contribution > 0 ? (
        <MarkOrderPaid
          orderId={line.orderId}
          code={line.code}
          amount={line.contribution}
        />
      ) : null,
  },
];

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
    <>
      <SectionRow>
        <SectionCol basis={340}>
          <PayFigure
            shop={preview.restaurantName}
            amount={preview.netPayable}
            note={`For ${preview.lines.length} order${preview.lines.length === 1 ? "" : "s"}, ${preview.periodLabel}.`}
          />
          {preview.netPayable > 0 ? (
            <button
              type="button"
              disabled={pending}
              onClick={create}
              className="c-btn c-btn-dark mt-4 disabled:opacity-50"
            >
              {pending ? "One moment…" : "Pay these orders"}
            </button>
          ) : null}
          {error ? (
            <p className="mt-2 text-[12.5px] font-medium text-deal">{error}</p>
          ) : null}
        </SectionCol>
        {preview.netPayable > 0 ? (
          <SectionCol basis={340}>
            <Section flush title="Send it to">
              <PayToList payout={preview.payout} />
            </Section>
          </SectionCol>
        ) : null}
      </SectionRow>

      <Section
        title="Orders"
        actions={
          preview.lines.length > 0 ? (
            <button
              type="button"
              onClick={toExcel}
              className="c-btn c-btn-outline"
            >
              <Download className="size-3.5" /> Save as Excel
            </button>
          ) : null
        }
      >
        <PayoutLinesTable
          lines={preview.lines}
          commissionPct={preview.commissionPct}
          commissionGstPct={preview.commissionGstPct}
          extraColumns={PAY_ONE_COLUMN}
          empty={<Empty>No unpaid orders on these dates.</Empty>}
        />
      </Section>
    </>
  );
}
