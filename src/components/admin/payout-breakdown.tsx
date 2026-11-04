"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { formatINR } from "@/lib/utils/format";
import type { SettlementLine } from "@/lib/data-access/admin-settlements";
import type { SettlementTotals } from "@/lib/settlements/math";

/**
 * How a payout is shown — once, for every settlement screen.
 *
 * The rule for every word here: someone who has never seen an accounts screen
 * can read the amount and know what to do. Each screen leads with the one number
 * to send. How that number was reached stays one tap away, and never asks the
 * reader to do a sum.
 *
 * The figures come from `settlements/math` and are not recalculated here, so the
 * screens cannot disagree with each other or with the stored statement.
 */

/** The one sentence about a shop's balance, and whether money goes out. */
export function payoutWords(amount: number): {
  label: string;
  value: string;
  sends: boolean;
} {
  if (amount > 0) {
    return { label: "Send to the shop", value: formatINR(amount), sends: true };
  }
  if (amount < 0) {
    return {
      label: "Shop owes you",
      value: formatINR(Math.abs(amount)),
      sends: false,
    };
  }
  return { label: "Nothing to send", value: formatINR(0), sends: false };
}

function countOrders(count: number): string {
  return `${count} order${count === 1 ? "" : "s"}`;
}

/** The screen's one big number. Everything else on the page is secondary to it. */
export function PayHero({
  shop,
  amount,
  orderCount,
  note,
  title,
  children,
}: Readonly<{
  shop: string;
  amount: number;
  orderCount?: number;
  note?: ReactNode;
  /** Replaces the heading, for a payment that is already done or cancelled. */
  title?: string;
  children?: ReactNode;
}>) {
  const words = payoutWords(amount);
  let heading = `Nothing to send to ${shop}`;
  if (words.sends) heading = `Send to ${shop}`;
  else if (amount < 0) heading = `${shop} owes you`;
  if (title) heading = title;

  return (
    <section className="rounded-[var(--radius-sheet)] border border-line bg-surface p-4 @3xl:p-5">
      <h2 className="text-[14px] font-medium text-muted">{heading}</h2>
      <p
        className={`text-data mt-1 text-[38px] font-bold leading-none tracking-[-0.03em] tabular-nums ${
          amount < 0 ? "text-deal" : "text-ink"
        }`}
      >
        {words.value}
      </p>
      {orderCount !== undefined || note ? (
        <p className="mt-2 text-[13px] leading-snug text-muted">
          {orderCount !== undefined ? `For ${countOrders(orderCount)}. ` : ""}
          {note}
        </p>
      ) : null}
      {children ? <div className="mt-4 space-y-3">{children}</div> : null}
    </section>
  );
}

/** The screen's main action: full width on a phone, large enough to read at a glance. */
export function PayButton({
  onClick,
  disabled,
  children,
}: Readonly<{ onClick: () => void; disabled?: boolean; children: ReactNode }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="press flex min-h-12 w-full items-center justify-center rounded-xl bg-[var(--btn-bg)] px-8 text-[15px] font-semibold text-[color:var(--btn-ink)] hover:opacity-90 disabled:opacity-50 @3xl:w-auto"
    >
      {children}
    </button>
  );
}

/** A value on the "where to send it" card, copied with one tap. */
function CopyLine({ label, value }: Readonly<{ label: string; value: string }>) {
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
    <div className="flex min-h-11 items-center justify-between gap-3 py-1">
      <p className="min-w-0">
        <span className="block text-[11.5px] text-muted">{label}</span>
        <span className="text-data block break-all text-[14px] font-medium text-ink">
          {value}
        </span>
      </p>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className="press flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-muted"
      >
        {copied ? (
          <Check className="size-4 text-green" />
        ) : (
          <Copy className="size-4" />
        )}
      </button>
    </div>
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
export function PayToCard({ payout }: Readonly<{ payout: PayToDetails }>) {
  const lines: { label: string; value: string }[] = [];
  if (payout.upiId) lines.push({ label: "UPI", value: payout.upiId });
  if (payout.bankAccountNumber) {
    lines.push({ label: "Account number", value: payout.bankAccountNumber });
  }
  if (payout.bankIfsc) lines.push({ label: "IFSC", value: payout.bankIfsc });
  if (payout.bankAccountName) {
    lines.push({ label: "Account name", value: payout.bankAccountName });
  }

  if (lines.length === 0) {
    return (
      <p className="rounded-lg border border-deal/30 bg-deal-soft px-3 py-2.5 text-[13px] font-medium text-deal">
        This shop has no bank or UPI details yet. Add them on the shop&apos;s page
        before paying.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-line px-3 py-1.5">
      {lines.map((line) => (
        <CopyLine key={line.label} label={line.label} value={line.value} />
      ))}
      {payout.bankName ? (
        <p className="pb-1 text-[11.5px] text-muted">{payout.bankName}</p>
      ) : null}
    </div>
  );
}

/** A row of the "how we got this" sum. */
function SumLine({
  label,
  amount,
  sign,
  strong,
}: Readonly<{
  label: string;
  amount: number;
  sign?: "minus" | "plus";
  strong?: boolean;
}>) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 py-1 ${
        strong ? "mt-1 border-t border-line pt-2" : ""
      }`}
    >
      <span
        className={
          strong ? "text-[14px] font-semibold text-ink" : "text-[13px] text-muted"
        }
      >
        {label}
      </span>
      <span
        className={`text-data shrink-0 tabular-nums ${
          strong ? "text-[15px] font-bold text-ink" : "text-[13px] text-ink"
        }`}
      >
        {sign === "minus" ? "− " : ""}
        {sign === "plus" ? "+ " : ""}
        {formatINR(Math.abs(amount))}
      </span>
    </div>
  );
}

/** Words for Deligro's share, with the rate when there is one to state. */
function cutLabel(commissionPct: number, commissionGstPct: number): string {
  const gst = commissionGstPct > 0 ? " + GST" : "";
  return `Deligro's cut (${commissionPct}%${gst})`;
}

/** One order, from what the customer paid down to what the shop gets. */
export function OrderPayoutBreakdown({
  line,
  commissionPct,
  commissionGstPct,
}: Readonly<{
  line: SettlementLine;
  commissionPct: number;
  commissionGstPct: number;
}>) {
  const notTheShops = line.deliveryFee + line.taxAmount + line.tip;
  const cut = line.commission + line.commissionGst + line.otherCharges;

  return (
    <div>
      <SumLine label="Customer paid" amount={line.orderTotal} />
      <SumLine
        label="Delivery, tax and tip"
        amount={notTheShops}
        sign="minus"
      />
      {line.platformDiscount > 0 ? (
        <SumLine
          label="Discount Deligro paid for"
          amount={line.platformDiscount}
          sign="plus"
        />
      ) : null}
      <SumLine
        label={cutLabel(commissionPct, commissionGstPct)}
        amount={cut}
        sign="minus"
      />
      {line.refundRecovered > 0 ? (
        <SumLine label="Refund" amount={line.refundRecovered} sign="minus" />
      ) : null}
      <SumLine
        label={line.contribution < 0 ? "Shop owes you" : "Shop gets"}
        amount={line.contribution}
        strong
      />
    </div>
  );
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
  return (
    <div>
      <SumLine label="Food sold" amount={totals.foodGross} />
      <SumLine
        label={cutLabel(commissionPct, commissionGstPct)}
        amount={cut}
        sign="minus"
      />
      {totals.refundsRecovered > 0 ? (
        <SumLine label="Refunds" amount={totals.refundsRecovered} sign="minus" />
      ) : null}
      {corrections > 0 ? (
        <SumLine
          label="Refunds on orders already paid"
          amount={corrections}
          sign="minus"
        />
      ) : null}
      <SumLine
        label={totals.netPayable < 0 ? "Shop owes you" : "Send to the shop"}
        amount={totals.netPayable}
        strong
      />
      {mismatch !== 0 ? (
        <p className="mt-2 rounded-lg border border-deal/30 bg-deal/10 px-3 py-2 text-[12.5px] font-medium text-deal">
          These rows do not add up to the total. The difference is{" "}
          {formatINR(mismatch)}. Do not pay from this statement.
        </p>
      ) : null}
    </div>
  );
}

/** How an order was paid, as a word rather than a code. */
export function payWord(line: Pick<SettlementLine, "paymentMethod" | "remitsVendor">): string {
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

export type PayoutRowStatus = "unpaid" | "waiting" | "paid";

const STATUS_WORD: Record<PayoutRowStatus, string> = {
  unpaid: "Unpaid",
  waiting: "Waiting",
  paid: "Paid",
};

const STATUS_TINT: Record<PayoutRowStatus, string> = {
  unpaid: "text-muted",
  waiting: "text-[color:var(--c-ink-amber)]",
  paid: "text-green",
};

/**
 * One order as a single line a phone can show whole: which order, how much, and
 * whether it is paid. Tapping opens the sum and anything else there is to do.
 */
export function PayoutOrderRow({
  line,
  status,
  commissionPct,
  commissionGstPct,
  children,
}: Readonly<{
  line: SettlementLine;
  /** Left out inside a statement, where every order shares one status. */
  status?: PayoutRowStatus;
  commissionPct: number;
  commissionGstPct: number;
  children?: ReactNode;
}>) {
  const [open, setOpen] = useState(false);
  const owes = line.contribution < 0;

  return (
    <li className="rounded-xl border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="press flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="text-data block truncate text-[14px] font-semibold text-ink">
            {line.code}
          </span>
          <span className="block truncate text-[12px] text-muted">
            {shortDate(line.deliveredAt)}, {payWord(line).toLowerCase()}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span
            className={`text-data block text-[15px] font-bold tabular-nums ${
              owes ? "text-deal" : "text-ink"
            }`}
          >
            {owes ? "− " : ""}
            {formatINR(Math.abs(line.contribution))}
          </span>
          {status ? (
            <span
              className={`block text-[12px] font-medium ${STATUS_TINT[status]}`}
            >
              {STATUS_WORD[status]}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={`size-4 shrink-0 text-muted transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open ? (
        <div className="space-y-3 border-t border-line p-3">
          <OrderPayoutBreakdown
            line={line}
            commissionPct={commissionPct}
            commissionGstPct={commissionGstPct}
          />
          {children}
        </div>
      ) : null}
    </li>
  );
}

/** The orders inside one payment, using the same row as everywhere else. */
export function PayoutOrderList({
  lines,
  commissionPct,
  commissionGstPct,
  rowAction,
}: Readonly<{
  lines: SettlementLine[];
  commissionPct: number;
  commissionGstPct: number;
  rowAction?: (line: SettlementLine) => ReactNode;
}>) {
  return (
    <ul className="space-y-2">
      {lines.map((line) => (
        <PayoutOrderRow
          key={line.orderId}
          line={line}
          commissionPct={commissionPct}
          commissionGstPct={commissionGstPct}
        >
          {rowAction?.(line)}
        </PayoutOrderRow>
      ))}
    </ul>
  );
}
