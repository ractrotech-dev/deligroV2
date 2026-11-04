"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Fact, FactList, FinancialBreakdown } from "@/components/admin/console";
import { DataTable, type Column } from "@/components/admin/data-table";
import { formatINR } from "@/lib/utils/format";
import type { SettlementLine } from "@/lib/data-access/admin-settlements";
import type { SettlementTotals } from "@/lib/settlements/math";

/**
 * How a payout is shown — once, for every settlement screen.
 *
 * The rule for every word here: someone who has never seen an accounts screen can
 * read the amount and know what to do. Each screen leads with the one number to
 * send, and each order's sum reads straight across its table row, so nobody needs
 * a calculator.
 *
 * The figures come from `settlements/math` and are not recalculated here, so the
 * screens cannot disagree with each other or with the stored statement.
 */

/** The screen's one big number. */
export function PayFigure({
  shop,
  amount,
  title,
  note,
}: Readonly<{
  shop: string;
  amount: number;
  /** Replaces the heading, for a payment that is already done or cancelled. */
  title?: string;
  note?: ReactNode;
}>) {
  let heading = `Nothing to send to ${shop}`;
  if (amount > 0) heading = `Send to ${shop}`;
  if (amount < 0) heading = `${shop} owes you`;

  return (
    <div>
      <h2 className="text-[13px] font-medium text-muted">{title ?? heading}</h2>
      <p
        className={`text-data mt-1 text-[34px] font-bold leading-none tracking-[-0.03em] tabular-nums ${
          amount < 0 ? "text-deal" : "text-ink"
        }`}
      >
        {formatINR(Math.abs(amount))}
      </p>
      {note ? <p className="mt-2 text-[12.5px] text-muted">{note}</p> : null}
    </div>
  );
}

function CopyValue({ label, value }: Readonly<{ label: string; value: string }>) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard refused (no permission, or not https): the value is on screen.
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-data break-all font-medium">{value}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        className="shrink-0 text-muted hover:text-ink"
      >
        {copied ? (
          <Check className="size-3.5 text-green" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </span>
  );
}

export interface PayToDetails {
  upiId: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
}

/** Where the money goes, ready to copy into a bank or UPI app. */
export function PayToList({ payout }: Readonly<{ payout: PayToDetails }>) {
  const lines: { label: string; value: string }[] = [];
  if (payout.upiId) lines.push({ label: "UPI", value: payout.upiId });
  if (payout.bankAccountNumber) {
    lines.push({ label: "Account number", value: payout.bankAccountNumber });
  }
  if (payout.bankIfsc) lines.push({ label: "IFSC", value: payout.bankIfsc });
  if (payout.bankAccountName) {
    lines.push({ label: "Account name", value: payout.bankAccountName });
  }
  if (payout.bankName) lines.push({ label: "Bank", value: payout.bankName });

  if (lines.length === 0) {
    return (
      <p className="text-[13px] font-medium text-deal">
        This shop has no bank or UPI details yet. Add them on the shop&apos;s page
        before paying.
      </p>
    );
  }

  return (
    <FactList>
      {lines.map((line) => (
        <Fact key={line.label} label={line.label}>
          <CopyValue label={line.label} value={line.value} />
        </Fact>
      ))}
    </FactList>
  );
}

/** Words for Deligro's share, with the rate when there is one to state. */
function cutLabel(commissionPct: number, commissionGstPct: number): string {
  const gst = commissionGstPct > 0 ? " + GST" : "";
  return `Deligro's cut (${commissionPct}%${gst})`;
}

/**
 * Many orders, added up: food sold, less Deligro's share, gives the amount.
 *
 * `mismatch` stays visible. It is always 0 unless a statement's stored rows and
 * its total have stopped agreeing, and then nobody should pay from it.
 */
export function PayoutTotals({
  totals,
  commissionPct,
  commissionGstPct,
  corrections = 0,
  mismatch = 0,
}: Readonly<{
  totals: SettlementTotals;
  commissionPct: number;
  commissionGstPct: number;
  /** Refunds on already-paid orders, being taken back in this payment. */
  corrections?: number;
  mismatch?: number;
}>) {
  const cut = totals.commission + totals.commissionGst + totals.otherCharges;
  const minus = (value: number) => `− ${formatINR(value)}`;
  const lines = [
    { label: "Food sold", value: formatINR(totals.foodGross) },
    {
      label: cutLabel(commissionPct, commissionGstPct),
      value: minus(cut),
      negative: true,
    },
  ];
  if (totals.refundsRecovered > 0) {
    lines.push({
      label: "Old refunds",
      value: minus(totals.refundsRecovered),
      negative: true,
    });
  }
  if (corrections > 0) {
    lines.push({
      label: "Old refunds on orders already paid",
      value: minus(corrections),
      negative: true,
    });
  }

  return (
    <div>
      <FinancialBreakdown
        lines={lines}
        total={{
          label: totals.netPayable < 0 ? "Shop owes you" : "Send to the shop",
          value: formatINR(Math.abs(totals.netPayable)),
        }}
      />
      {mismatch !== 0 ? (
        <p className="mt-2 text-[12.5px] font-medium text-deal">
          These rows do not add up to the total. The difference is{" "}
          {formatINR(mismatch)}. Do not pay from this statement.
        </p>
      ) : null}
    </div>
  );
}

/** How an order was paid, as a word rather than a code. */
export function payWord(
  line: Pick<SettlementLine, "paymentMethod" | "remitsVendor">
): string {
  if (line.paymentMethod === "cod") return "Cash";
  if (line.paymentMethod === "online") {
    return line.remitsVendor ? "Online" : "Online, not received";
  }
  return "Unknown";
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}

const money = (value: number, sign = "") => (
  <span className="text-data text-[12.5px] tabular-nums text-muted">
    {sign}
    {formatINR(value)}
  </span>
);

/**
 * Every order in a payment, one row each. The row is the sum, left to right:
 * customer paid, less delivery, tax and tip, less Deligro's cut, gives what the
 * shop gets. A column appears only when an order on the page needs it.
 */
export function PayoutLinesTable<T extends SettlementLine>({
  lines,
  commissionPct,
  commissionGstPct,
  extraColumns = [],
  empty,
}: Readonly<{
  lines: T[];
  commissionPct: number;
  commissionGstPct: number;
  extraColumns?: Column<T>[];
  empty?: ReactNode;
}>) {
  const columns: Column<T>[] = [
    {
      key: "order",
      header: "Order",
      cell: (l) => (
        <span className="text-data text-[12.5px] font-semibold text-ink">
          {l.code}
        </span>
      ),
    },
    {
      key: "date",
      header: "Date",
      cell: (l) => (
        <span className="text-[12.5px] text-muted">{shortDate(l.deliveredAt)}</span>
      ),
    },
    {
      key: "paidBy",
      header: "Paid by",
      cell: (l) => <span className="text-[12.5px] text-muted">{payWord(l)}</span>,
    },
    {
      key: "customer",
      header: "Customer paid",
      align: "right",
      cell: (l) => money(l.orderTotal),
    },
    {
      key: "notShops",
      header: "Delivery, tax, tip",
      align: "right",
      cell: (l) => money(l.deliveryFee + l.taxAmount + l.tip, "− "),
    },
  ];
  if (lines.some((l) => l.platformDiscount > 0)) {
    columns.push({
      key: "discount",
      header: "Discount we paid",
      align: "right",
      cell: (l) => money(l.platformDiscount, "+ "),
    });
  }
  columns.push({
    key: "cut",
    header: cutLabel(commissionPct, commissionGstPct),
    align: "right",
    cell: (l) => money(l.commission + l.commissionGst + l.otherCharges, "− "),
  });
  if (lines.some((l) => l.refundRecovered > 0)) {
    columns.push({
      key: "refund",
      header: "Old refund",
      align: "right",
      cell: (l) => money(l.refundRecovered, "− "),
    });
  }
  columns.push(
    {
      key: "shopGets",
      header: "Shop gets",
      align: "right",
      cell: (l) => (
        <span
          className={`text-data text-[13.5px] font-bold tabular-nums ${
            l.contribution < 0 ? "text-deal" : "text-ink"
          }`}
        >
          {l.contribution < 0 ? "− " : ""}
          {formatINR(Math.abs(l.contribution))}
        </span>
      ),
    },
    ...extraColumns
  );

  return (
    <DataTable
      columns={columns}
      rows={lines}
      rowKey={(l) => l.orderId}
      caption="Orders in this payment"
      empty={empty}
    />
  );
}
