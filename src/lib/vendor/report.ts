/**
 * The Partner app's sales report (requirements §5) over a shop's orders and
 * its settlement ledger. Pure; tested by scripts/qa/vendor-report.ts. Uses the
 * same words as the dashboard and payments (lib/vendor/money.ts):
 *
 *   sale        the order's food value (what a settlement calls foodGross)
 *   gross sales sale + the shop's own discount: the food before the shop's offer
 *   net sales   sale − refunds recovered from the shop (requirements §17)
 *   charges     commission + commission GST + per-order other charges
 *   earnings    vendorNet − refundRecovered, once delivered (the ledger)
 *   settled     the order is in a paid settlement
 */
import { kitchenStage } from "@/lib/orders/kitchen-stage";

export interface ReportSale {
  id: string;
  status: string;
  createdAt: string;
  total: number;
  sale: number;
  vendorDiscount: number;
  paymentMethod: string | null;
  paymentStatus: string | null;
}

export interface ReportLedgerLine {
  orderId: string;
  commission: number;
  commissionGst: number;
  otherCharges: number;
  vendorNet: number;
  refundRecovered: number;
  paid: boolean;
}

export const REPORT_STATUSES = ["all", "completed", "cancelled", "in_progress"] as const;
export const REPORT_PAYMENTS = ["all", "cod", "online"] as const;
export const REPORT_SETTLED = ["all", "settled", "unsettled"] as const;

export interface ReportFilters {
  status: (typeof REPORT_STATUSES)[number];
  payment: (typeof REPORT_PAYMENTS)[number];
  settled: (typeof REPORT_SETTLED)[number];
}

export interface ReportRow {
  orderId: string;
  createdAt: string;
  /** new / accepted / preparing / ready / completed / cancelled. */
  stage: string;
  paymentMethod: "cod" | "online";
  paymentStatus: string;
  total: number;
  sale: number;
  /** Food before the shop's own discount. */
  gross: number;
  vendorDiscount: number;
  /** Refunds Deligro recovered from the shop (0 until delivered). */
  refund: number;
  /** sale − refund. */
  net: number;
  /** Null until delivered: the ledger hasn't priced it yet. */
  charges: number | null;
  earnings: number | null;
  /** "settled" | "unsettled" for a delivered order, null otherwise. */
  settlement: "settled" | "unsettled" | null;
}

export interface ReportTotals {
  orders: number;
  completed: number;
  cancelled: number;
  inProgress: number;
  /** Over non-cancelled orders. */
  sales: number;
  grossSales: number;
  netSales: number;
  refunds: number;
  vendorDiscounts: number;
  charges: number;
  earnings: number;
  settled: number;
  unsettled: number;
  codOrders: number;
  onlineOrders: number;
  cancelledValue: number;
}

function choose<T extends readonly string[]>(values: T, raw: string | null): T[number] | null {
  if (raw === null || raw === "") return values[0];
  return (values as readonly string[]).includes(raw) ? (raw as T[number]) : null;
}

/** Query parameters → filters, or null when one is not a known value. */
export function parseReportFilters(q: URLSearchParams): ReportFilters | null {
  const status = choose(REPORT_STATUSES, q.get("status"));
  const payment = choose(REPORT_PAYMENTS, q.get("payment"));
  const settled = choose(REPORT_SETTLED, q.get("settled"));
  if (!status || !payment || !settled) return null;
  return { status, payment, settled };
}

export function buildReport(
  sales: ReportSale[],
  ledger: ReportLedgerLine[],
  filters: ReportFilters
): { rows: ReportRow[]; totals: ReportTotals } {
  const byId = new Map(ledger.map((l) => [l.orderId, l]));
  const rows: ReportRow[] = [];
  for (const s of sales) {
    const stage = kitchenStage({ status: s.status }) ?? s.status;
    const line = byId.get(s.id);
    const row: ReportRow = {
      orderId: s.id,
      createdAt: s.createdAt,
      stage,
      paymentMethod: s.paymentMethod === "online" ? "online" : "cod",
      paymentStatus: s.paymentStatus ?? "pending",
      total: s.total,
      sale: s.sale,
      gross: s.sale + s.vendorDiscount,
      vendorDiscount: s.vendorDiscount,
      refund: line?.refundRecovered ?? 0,
      net: s.sale - (line?.refundRecovered ?? 0),
      charges: line ? line.commission + line.commissionGst + line.otherCharges : null,
      earnings: line ? line.vendorNet - line.refundRecovered : null,
      settlement: line ? (line.paid ? "settled" : "unsettled") : null,
    };
    const inProgress = stage !== "completed" && stage !== "cancelled";
    if (filters.status === "completed" && stage !== "completed") continue;
    if (filters.status === "cancelled" && stage !== "cancelled") continue;
    if (filters.status === "in_progress" && !inProgress) continue;
    if (filters.payment !== "all" && row.paymentMethod !== filters.payment) continue;
    if (filters.settled !== "all" && row.settlement !== filters.settled) continue;
    rows.push(row);
  }

  const totals: ReportTotals = {
    orders: rows.length,
    completed: 0,
    cancelled: 0,
    inProgress: 0,
    sales: 0,
    grossSales: 0,
    netSales: 0,
    refunds: 0,
    vendorDiscounts: 0,
    charges: 0,
    earnings: 0,
    settled: 0,
    unsettled: 0,
    codOrders: 0,
    onlineOrders: 0,
    cancelledValue: 0,
  };
  for (const r of rows) {
    if (r.paymentMethod === "online") totals.onlineOrders++;
    else totals.codOrders++;
    if (r.stage === "cancelled") {
      totals.cancelled++;
      totals.cancelledValue += r.sale;
      continue;
    }
    if (r.stage === "completed") totals.completed++;
    else totals.inProgress++;
    totals.sales += r.sale;
    totals.grossSales += r.gross;
    totals.netSales += r.net;
    totals.refunds += r.refund;
    totals.vendorDiscounts += r.vendorDiscount;
    totals.charges += r.charges ?? 0;
    totals.earnings += r.earnings ?? 0;
    if (r.settlement === "settled") totals.settled += r.earnings ?? 0;
    if (r.settlement === "unsettled") totals.unsettled += r.earnings ?? 0;
  }
  return { rows, totals };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_MS = 5.5 * 60 * 60 * 1000;
/** A report covers at most a year and a day (leap years included). */
export const MAX_REPORT_DAYS = 366;

const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/**
 * `from`/`to` (IST calendar dates, both inclusive) → the instants
 * [IST midnight of from, IST midnight after to). Missing → this IST month so
 * far. Null when malformed, reversed, in the future or longer than a year.
 */
export function parseReportRange(
  fromRaw: string | null,
  toRaw: string | null,
  now: Date = new Date()
): { from: Date; to: Date; fromDay: string; toDay: string } | null {
  const today = new Date(now.getTime() + IST_MS).toISOString().slice(0, 10);
  const fromDay = fromRaw || `${today.slice(0, 8)}01`;
  const toDay = toRaw || today;
  if (!isDay(fromDay) || !isDay(toDay) || toDay < fromDay || fromDay > today) return null;
  const days = (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS + 1;
  if (days > MAX_REPORT_DAYS) return null;
  const from = new Date(Date.parse(`${fromDay}T00:00:00Z`) - IST_MS);
  const to = new Date(Date.parse(`${toDay}T00:00:00Z`) - IST_MS + DAY_MS);
  return { from, to, fromDay, toDay };
}
