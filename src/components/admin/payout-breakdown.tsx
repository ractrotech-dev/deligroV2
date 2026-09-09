import { formatINR } from "@/lib/utils/format";
import type { SettlementLine } from "@/lib/data-access/admin-settlements";
import { itemsLabel, type SettlementTotals } from "@/lib/settlements/math";

/**
 * How a payout is shown — once, for every screen that shows one.
 *
 * The settlement preview, the saved statement and the order-payouts list were
 * always going to print the same subtraction, and three copies of it is three
 * chances for one screen to quietly omit a deduction and disagree with the
 * others about what a vendor is owed. So the subtraction is written here and
 * imported, in the same spirit as `pricing.ts` on the customer side.
 *
 * The wording is the plain-English version throughout: "What the customer paid",
 * not "GMV"; "Shop's share of the food", not "food gross".
 */

/** A row of the subtraction: label, amount, and whether it is taken away. */
function Line({
  label,
  amount,
  note,
  negative,
  positive,
  strong,
  rule,
}: {
  label: string;
  amount: number;
  note?: string;
  negative?: boolean;
  /** Added back rather than taken off — the one row that goes the other way. */
  positive?: boolean;
  strong?: boolean;
  /** Draw a divider above — marks a subtotal. */
  rule?: boolean;
}) {
  return (
    <div
      className={[
        "flex items-baseline justify-between gap-3 py-1.5",
        rule ? "mt-1 border-t border-line pt-2.5" : "",
      ].join(" ")}
    >
      <span
        className={
          strong
            ? "text-[13.5px] font-semibold text-ink"
            : "text-[13px] text-muted"
        }
      >
        {label}
        {note ? (
          <span className="ml-1.5 text-[11.5px] text-muted">{note}</span>
        ) : null}
      </span>
      <span
        className={[
          "text-data shrink-0 tabular-nums",
          strong ? "text-[15px] font-bold text-ink" : "text-[13px] text-ink",
          negative && amount !== 0 ? "text-deal" : "",
          positive && amount !== 0 ? "text-green" : "",
        ].join(" ")}
      >
        {negative && amount !== 0 ? "− " : ""}
        {positive && amount !== 0 ? "+ " : ""}
        {formatINR(Math.abs(amount))}
      </span>
    </div>
  );
}

/**
 * One order, from what the customer paid down to what the shop is owed.
 *
 * Every deduction is listed even when it is zero. A row that disappears when
 * it is nil is a row a vendor cannot check for, and "why is this ₹18 short"
 * is the question this component exists to pre-empt.
 */
export function OrderPayoutBreakdown({
  line,
  commissionPct,
  commissionGstPct,
}: {
  line: SettlementLine;
  commissionPct: number;
  commissionGstPct: number;
}) {
  const deductions =
    line.commission + line.commissionGst + line.otherCharges;

  return (
    <div className="space-y-0.5">
      <Line label="What the customer paid" amount={line.orderTotal} strong />
      <Line label="Delivery fee (platform)" amount={line.deliveryFee} negative />
      <Line label="GST / taxes (government)" amount={line.taxAmount} negative />
      <Line label="Tip (rider keeps all of it)" amount={line.tip} negative />
      {/* The one row that adds. Without it the statement does not reconcile:
          the shop's food share is deliberately more than what the customer
          paid, because Deligro paid the rest of it. */}
      {line.platformDiscount > 0 ? (
        <Line
          label="Deligro promo code — we funded this"
          amount={line.platformDiscount}
          positive
        />
      ) : null}
      <Line
        label="Shop's share of the food"
        amount={line.foodGross}
        strong
        rule
      />
      <Line
        label="Platform commission"
        note={`${commissionPct}%`}
        amount={line.commission}
        negative
      />
      <Line
        label="GST on commission"
        note={`${commissionGstPct}% of commission`}
        amount={line.commissionGst}
        negative
      />
      <Line label="Other charges" amount={line.otherCharges} negative />
      <Line label="You earn" amount={deductions} strong rule />
      {line.refundRecovered > 0 ? (
        <Line
          label="Refund recovered"
          amount={line.refundRecovered}
          negative
        />
      ) : null}
      <Line
        label={
          line.remitsVendor
            ? "Shop is paid"
            : "Shop already took the cash — platform collects"
        }
        amount={Math.abs(line.contribution)}
        strong
        rule
      />
      {!line.remitsVendor ? (
        <p className="pt-1 text-[11.5px] leading-snug text-muted">
          Cash order. The shop kept{" "}
          {formatINR(line.foodGross - line.platformDiscount)} at the door, so
          the {formatINR(deductions + line.refundRecovered)} above is taken off
          the next payout instead of being sent
          {line.platformDiscount > 0
            ? `, less the ${formatINR(line.platformDiscount)} promo code Deligro funded`
            : ""}
          .
        </p>
      ) : null}
    </div>
  );
}

/**
 * The footer of a settlement: the same subtraction, summed.
 *
 * `mismatch` is displayed rather than hidden. It is always 0 — the header is
 * written as the integer sum of the lines and re-verified on read — and saying
 * so out loud is what makes the claim checkable instead of merely asserted.
 */
export function PayoutTotals({
  totals,
  commissionPct,
  commissionGstPct,
  orderCount,
  mismatch = 0,
}: {
  totals: SettlementTotals;
  commissionPct: number;
  commissionGstPct: number;
  orderCount: number;
  mismatch?: number;
}) {
  const owesPlatform = totals.netPayable < 0;
  const platformEarnings =
    totals.commission + totals.commissionGst + totals.otherCharges;

  return (
    <div className="space-y-0.5">
      <Line
        label={`Shop's share of the food · ${orderCount} order${orderCount === 1 ? "" : "s"}`}
        amount={totals.foodGross}
        strong
      />
      <Line
        label="Platform commission"
        note={`${commissionPct}%`}
        amount={totals.commission}
        negative
      />
      <Line
        label="GST on commission"
        note={`${commissionGstPct}%`}
        amount={totals.commissionGst}
        negative
      />
      <Line label="Other charges" amount={totals.otherCharges} negative />
      <Line label="You earn" amount={platformEarnings} strong rule />
      <Line
        label="Refunds recovered"
        amount={totals.refundsRecovered}
        negative
      />
      <Line
        label={owesPlatform ? "Shop owes the platform" : "Total to pay the shop"}
        amount={totals.netPayable}
        strong
        rule
      />
      {mismatch !== 0 ? (
        <p className="mt-2 rounded-lg border border-deal/30 bg-deal/10 px-3 py-2 text-[12px] font-medium text-deal">
          These rows do not add up to the stored total — a difference of{" "}
          {formatINR(mismatch)}. Do not pay from this statement; report it.
        </p>
      ) : (
        <p className="pt-1.5 text-[11.5px] text-muted">
          Every order above is added up to the rupee — no rounding is applied to
          this total.
        </p>
      )}
    </div>
  );
}

/** How an order was paid, as a word rather than a code. */
export function payWord(line: SettlementLine): string {
  if (line.remitsVendor) return "Paid online";
  if (line.paymentMethod === "cod") return "Cash";
  if (line.paymentMethod === "online") return "Online, unpaid";
  return "Unknown";
}

/**
 * The per-order table shared by the preview and the saved statement.
 *
 * Scrolls sideways rather than dropping columns on a narrow screen: a payout
 * table that hides the commission column on a phone is a payout table an
 * operator cannot check on a phone.
 */
/**
 * Every order in the payout, one per row.
 *
 * The "Ordered" column is the one that makes a disputed line resolvable: an
 * order code and an amount are not something a vendor can check against their
 * own kitchen records, and "Chicken Biryani ×2" is. Names are the snapshot
 * taken when the order was sold, so a later menu rename cannot rewrite a
 * statement.
 *
 * `rowAction` is how the settlement preview puts a Mark paid control on each
 * line without this table — shared with the saved statement, which must stay
 * read-only — learning what paying is.
 */
export function PayoutLinesTable({
  lines,
  rowAction,
}: {
  lines: SettlementLine[];
  rowAction?: (line: SettlementLine) => React.ReactNode;
}) {
  if (lines.length === 0) {
    return <p className="c-empty">No orders in this range.</p>;
  }

  const showItems = lines.some((l) => l.items.length > 0);

  const th =
    "whitespace-nowrap px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.07em] text-muted";
  const thRight = `${th} text-right`;
  const td = "px-3 py-[var(--c-row-y-dense)] text-[12px]";
  const tdNum = `text-data ${td} text-right tabular-nums`;

  return (
    // A sticky header (`c-thead`) on a statement of a hundred orders: the
    // columns here are eight money figures that differ only by heading, and a
    // reader who has scrolled past the header is comparing numbers they can no
    // longer name.
    <div className="overflow-x-auto rounded-[var(--c-r)] border border-line bg-surface">
      <table className="w-full min-w-[940px] border-collapse text-left text-sm">
        <caption className="sr-only">Payout for each order</caption>
        <thead className="c-thead">
          <tr>
            <th className={th}>Order</th>
            {showItems ? <th className={th}>Ordered</th> : null}
            <th className={th}>Paid by</th>
            <th className={thRight}>Customer paid</th>
            <th className={thRight}>Food</th>
            <th className={thRight}>Commission</th>
            <th className={thRight}>GST</th>
            <th className={thRight}>Other</th>
            <th className={thRight}>You earn</th>
            <th className={thRight}>Refund</th>
            <th className={thRight}>Shop gets</th>
            {rowAction ? <th className={thRight}>Settle</th> : null}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr
              key={l.orderId}
              className="border-t border-[color:var(--c-divider-2)] transition-colors hover:bg-[var(--c-hover)]"
            >
              <td className="text-data px-3 py-[var(--c-row-y-dense)] text-[11.5px] font-medium text-ink">
                {l.code}
              </td>
              {showItems ? (
                <td className="max-w-[240px] px-3 py-[var(--c-row-y-dense)] text-[12px] text-muted">
                  <span className="line-clamp-2" title={itemsLabel(l.items)}>
                    {l.items.length ? itemsLabel(l.items) : "—"}
                  </span>
                </td>
              ) : null}
              <td className={`${td} text-muted`}>{payWord(l)}</td>
              <td className={`${tdNum} text-muted`}>
                {l.orderTotal ? formatINR(l.orderTotal) : "—"}
              </td>
              <td className={tdNum}>{formatINR(l.foodGross)}</td>
              <td className={tdNum}>{formatINR(l.commission)}</td>
              <td className={tdNum}>
                {l.commissionGst ? formatINR(l.commissionGst) : "—"}
              </td>
              <td className={tdNum}>
                {l.otherCharges ? formatINR(l.otherCharges) : "—"}
              </td>
              <td className={`${tdNum} font-semibold text-ink`}>
                {formatINR(l.commission + l.commissionGst + l.otherCharges)}
              </td>
              <td className={tdNum}>
                {l.refundRecovered ? formatINR(l.refundRecovered) : "—"}
              </td>
              <td
                className={`${tdNum} font-semibold ${
                  l.contribution < 0 ? "text-deal" : "text-ink"
                }`}
              >
                {l.contribution < 0 ? "− " : ""}
                {formatINR(Math.abs(l.contribution))}
              </td>
              {rowAction ? (
                <td className={`${td} text-right`}>{rowAction(l)}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
