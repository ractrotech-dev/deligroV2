"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatTile, StatTiles } from "@/components/admin/console-ui";
import { formatINR } from "@/lib/utils/format";
import {
  PayoutLinesTable,
  PayoutTotals,
  payWord,
} from "@/components/admin/payout-breakdown";
import { createSettlementAction } from "@/app/admin/settlements/actions";
import { downloadBrandedWorkbook } from "@/lib/reports/xlsx";
import { itemsLabel } from "@/lib/settlements/math";
import { MarkOrderPaid } from "./mark-order-paid";
import type { SettlementPreview } from "@/lib/data-access/admin-settlements";

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
  const [notes, setNotes] = useState("");

  const create = () =>
    startTransition(async () => {
      setError(null);
      const fd = new FormData();
      fd.set("restaurantId", preview.restaurantId);
      fd.set("fromDate", fromDate);
      fd.set("toDate", toDate);
      if (notes.trim()) fd.set("notes", notes.trim());

      const result = await createSettlementAction(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.id) router.push(`/admin/settlements/${result.id}`);
    });

  const owesPlatform = preview.netPayable < 0;

  // What the customers paid across the run. The panel below it is all
  // deductions, so without this line the screen never states the top of the
  // subtraction it is performing.
  const customersPaid = preview.lines.reduce((sum, l) => sum + l.orderTotal, 0);
  const cashOrders = preview.lines.filter((l) => l.paymentMethod === "cod");
  const collectedInCash = cashOrders.reduce((sum, l) => sum + l.orderTotal, 0);
  const avgOrder = preview.lines.length
    ? Math.round(customersPaid / preview.lines.length)
    : 0;

  /**
   * The statement, as the vendor's accountant would want it: every order with
   * what was in it, in rupees Excel can add up. Numbers go out as numbers —
   * a "₹1,234" string is a cell nobody can sum, which is the whole point of
   * exporting rather than screenshotting.
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
          owesPlatform ? "Vendor owes platform (₹)" : "Net payable (₹)",
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
      {/* The run in figures, before the subtraction that produces the payout. */}
      <StatTiles>
        <StatTile
          label="Orders"
          value={preview.lines.length}
          note={`Avg ${formatINR(avgOrder)} an order`}
        />
        <StatTile
          label="Customers paid"
          value={formatINR(customersPaid)}
          note="Everything collected across the run"
        />
        <StatTile
          label="Collected in cash"
          value={formatINR(collectedInCash)}
          note={`${cashOrders.length} of ${preview.lines.length} orders · already with the shop`}
        />
        <StatTile
          label="Platform commission"
          value={formatINR(preview.commission + preview.commissionGst)}
          note={`${preview.commissionPct}% + ${preview.commissionGstPct}% GST`}
        />
        <StatTile
          label={owesPlatform ? "Vendor owes platform" : "Net payable"}
          value={formatINR(Math.abs(preview.netPayable))}
          note={owesPlatform ? "Recover from the next payout" : "To send out"}
        />
      </StatTiles>

      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-lg font-semibold text-ink">
              {preview.restaurantName}
            </p>
            <p className="text-sm text-muted">
              {preview.periodLabel} · {preview.lines.length} orders · commission{" "}
              {preview.commissionPct}%
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              {owesPlatform ? "Vendor owes platform" : "Net payable"}
            </p>
            <p
              className={`text-2xl font-bold ${owesPlatform ? "text-deal" : "text-ink"}`}
            >
              {formatINR(Math.abs(preview.netPayable))}
            </p>
          </div>
        </div>

        <div className="mt-4 border-t border-line pt-3">
          <PayoutTotals
            totals={{
              foodGross: preview.foodGross,
              commission: preview.commission,
              commissionGst: preview.commissionGst,
              otherCharges: preview.otherCharges,
              refundsRecovered: preview.refundsRecovered,
              netPayable: preview.netPayable,
            }}
            commissionPct={preview.commissionPct}
            commissionGstPct={preview.commissionGstPct}
            orderCount={preview.lines.length}
          />
        </div>

        <p className="mt-3 border-t border-line pt-3 text-[12.5px] text-muted">
          Pay to:{" "}
          <span className="font-medium text-ink">
            {preview.payout.upiId ||
              (preview.payout.bankAccountNumber
                ? `${preview.payout.bankName ?? "Bank"} ···${preview.payout.bankAccountNumber.slice(-4)}`
                : "No payout account on file")}
          </span>
        </p>
      </div>

      {preview.lines.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface-2 px-3.5 py-3 text-sm text-muted">
          No unpaid delivered orders in this range.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] text-muted">
              Every order in this run. Already settled one of them by hand? Mark
              it paid and it leaves the batch.
            </p>
            <Button type="button" size="sm" variant="secondary" onClick={toExcel}>
              <Download className="size-4" /> Export to Excel
            </Button>
          </div>

          <PayoutLinesTable
            lines={preview.lines}
            rowAction={(line) => (
              <MarkOrderPaid
                orderId={line.orderId}
                code={line.code}
                amount={line.contribution}
              />
            )}
          />
        </div>
      )}

      {preview.lines.length > 0 ? (
        <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium text-ink">Notes (optional)</span>
            <textarea
              className="min-h-[72px] w-full rounded-xl border border-line bg-bg px-3 py-2 text-ink"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Week 32 cycle"
            />
          </label>
          {error ? (
            <p className="text-sm text-deal">{error}</p>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={create}
          >
            {pending ? "Creating…" : "Create draft"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
