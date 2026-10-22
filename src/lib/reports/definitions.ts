/**
 * The report registry's definitions (§13) — pure and client-safe: kinds,
 * labels, filters, status options, who may run them, and the column set each
 * one prints. The builders live in `registry.ts` (server-only).
 *
 * Twelve reports from the client's document, plus `finance-daily` (§7.8
 * "date-wise financial reports") and the admin's `average-order`. The old
 * admin ids stay valid as aliases.
 *
 * English only on the manager side (owner).
 */

export type ReportKindId =
  | "sales"
  | "orders"
  | "vendor-performance"
  | "rider-performance"
  | "commission"
  | "vendor-settlement"
  | "rider-payout"
  | "cancellation"
  | "refunds-adjustments"
  | "marketing"
  | "support-tickets"
  | "cash-reconciliation"
  | "finance-daily"
  | "average-order";

export type ReportPermission = "reports" | "finance" | "finance_or_cash";
export type ReportFilter = "vendor" | "rider" | "status" | "zone" | "payment";
export type ColumnType = "text" | "int" | "money" | "money2" | "percent" | "date" | "datetime" | "minutes";

export interface ReportColumnDef {
  key: string;
  label: string;
  type: ColumnType;
  /** A finance figure: left out without manager.finance.view (the dashboard's rule). */
  finance?: boolean;
}

export interface ReportDefinitionMeta {
  kind: ReportKindId;
  label: string;
  blurb: string;
  filters: ReportFilter[];
  statusOptions: { value: string; label: string }[];
  permission: ReportPermission;
  /** One row per IST day (charts draw from the rows). */
  dayBased: boolean;
  columns: ReportColumnDef[];
}

const c = (key: string, label: string, type: ColumnType, finance = false): ReportColumnDef => ({ key, label, type, ...(finance ? { finance } : {}) });

export const REPORTS: readonly ReportDefinitionMeta[] = [
  {
    kind: "sales", label: "Sales report", blurb: "What customers paid, day by day.",
    filters: ["vendor", "zone", "payment"], statusOptions: [], permission: "reports", dayBased: true,
    columns: [c("date", "Date", "date"), c("orders", "Orders", "int"), c("customerPaid", "Customer paid", "money"), c("grossSales", "Gross sales", "money"),
      c("discounts", "Discounts", "money", true), c("refunds", "Refunds", "money", true), c("netSales", "Net sales", "money", true),
      c("deliveryFees", "Delivery fees", "money", true), c("aov", "Average order", "money")],
  },
  {
    kind: "orders", label: "Order report", blurb: "Every order, one per line.",
    filters: ["vendor", "rider", "status", "zone", "payment"],
    statusOptions: [
      { value: "placed", label: "New" }, { value: "kitchen", label: "Preparing" }, { value: "ready", label: "Ready" },
      { value: "on_the_way", label: "On the way" }, { value: "delivered", label: "Delivered" }, { value: "cancelled", label: "Cancelled" },
    ],
    permission: "reports", dayBased: false,
    columns: [c("code", "Order", "text"), c("placedAt", "Placed", "datetime"), c("vendor", "Vendor", "text"), c("rider", "Rider", "text"),
      c("status", "Status", "text"), c("paymentMethod", "Payment", "text"), c("paymentStatus", "Payment status", "text"), c("items", "Items", "int"),
      c("total", "Total", "money"), c("discount", "Discount", "money", true), c("deliveryFee", "Delivery fee", "money", true),
      c("cancelledBy", "Cancelled by", "text"), c("cancellationReason", "Cancellation reason", "text")],
  },
  {
    kind: "vendor-performance", label: "Vendor performance report", blurb: "Each shop's orders, speed, cancellations and rating.",
    filters: ["vendor", "zone"], statusOptions: [], permission: "reports", dayBased: false,
    columns: [c("vendor", "Vendor", "text"), c("zone", "Zone", "text"), c("orders", "Orders", "int"), c("delivered", "Delivered", "int"),
      c("cancelled", "Cancelled", "int"), c("cancellationRate", "Cancellation rate", "percent"), c("rejectionRate", "Rejection rate", "percent"),
      c("avgAcceptMinutes", "Avg accept (min)", "minutes"), c("avgPrepMinutes", "Avg prep (min)", "minutes"), c("customerPaid", "Customer paid", "money"),
      c("netSales", "Net sales", "money", true), c("aov", "Average order", "money"), c("rating", "Rating", "text"), c("ratingCount", "Ratings", "int"),
      c("commission", "Commission", "money", true), c("payable", "Payable", "money", true)],
  },
  {
    kind: "rider-performance", label: "Rider performance report", blurb: "Each rider's deliveries, speed, acceptance and rating.",
    filters: ["rider", "zone"], statusOptions: [], permission: "reports", dayBased: false,
    columns: [c("rider", "Rider", "text"), c("code", "Rider ID", "text"), c("delivered", "Delivered", "int"), c("failed", "Failed", "int"),
      c("failedRate", "Failed rate", "percent"), c("acceptanceRate", "Acceptance rate", "percent"), c("avgDeliverMinutes", "Avg delivery (min)", "minutes"),
      c("onlineHours", "Online hours", "money2"), c("rating", "Rating", "text"), c("ratingCount", "Ratings", "int"), c("codCollected", "COD collected", "money")],
  },
  {
    kind: "commission", label: "Commission report", blurb: "What Deligro kept from each shop's sales.",
    filters: ["vendor", "zone"], statusOptions: [], permission: "finance", dayBased: false,
    columns: [c("vendor", "Vendor", "text"), c("orders", "Orders", "int"), c("foodGross", "Food value", "money"), c("commission", "Commission", "money"),
      c("commissionGst", "GST on commission", "money"), c("otherCharges", "Other charges", "money"), c("platformTotal", "Platform total", "money"),
      c("vendorNet", "Vendor net", "money")],
  },
  {
    kind: "vendor-settlement", label: "Vendor settlement report", blurb: "Payouts to shops, paid and pending.",
    filters: ["vendor", "status", "zone"],
    statusOptions: [{ value: "draft", label: "Draft" }, { value: "paid", label: "Paid" }, { value: "void", label: "Void" }],
    permission: "finance", dayBased: false,
    columns: [c("vendor", "Vendor", "text"), c("kind", "Kind", "text"), c("status", "Status", "text"), c("periodStart", "From", "date"),
      c("periodEnd", "To", "date"), c("orders", "Orders", "int"), c("foodGross", "Food value", "money"), c("commission", "Commission", "money"),
      c("refundsRecovered", "Refunds recovered", "money"), c("netPayable", "Net payable", "money"), c("paymentRef", "Reference", "text"),
      c("paidAt", "Paid", "datetime"), c("paidBy", "Paid by", "text")],
  },
  {
    kind: "rider-payout", label: "Rider payout report", blurb: "Salary payouts made to riders.",
    filters: ["rider", "zone"], statusOptions: [], permission: "finance", dayBased: false,
    columns: [c("rider", "Rider", "text"), c("code", "Rider ID", "text"), c("periodEnd", "Up to", "date"), c("amount", "Amount", "money2"),
      c("method", "Method", "text"), c("reference", "Reference", "text"), c("paidOn", "Paid on", "date"), c("approvedBy", "Approved by", "text"),
      c("requestedBy", "Requested by", "text")],
  },
  {
    kind: "cancellation", label: "Cancellation report", blurb: "Cancelled orders, who cancelled and why.",
    filters: ["vendor", "zone", "status"],
    statusOptions: [
      { value: "customer", label: "Customer" }, { value: "vendor", label: "Vendor" }, { value: "admin", label: "Admin" },
      { value: "manager", label: "Manager" }, { value: "system", label: "System" },
    ],
    permission: "reports", dayBased: false,
    columns: [c("code", "Order", "text"), c("placedAt", "Placed", "datetime"), c("cancelledAt", "Cancelled", "datetime"), c("vendor", "Vendor", "text"),
      c("cancelledBy", "Cancelled by", "text"), c("reason", "Reason", "text"), c("value", "Order value", "money"), c("refunded", "Refunded", "money", true)],
  },
  {
    kind: "refunds-adjustments", label: "Refund and adjustment report", blurb: "Refunds, and corrections recovered from shops.",
    filters: ["vendor", "zone", "status"],
    statusOptions: [{ value: "pending", label: "Pending" }, { value: "approved", label: "Approved" }, { value: "denied", label: "Denied" }],
    permission: "finance", dayBased: false,
    columns: [c("date", "Date", "datetime"), c("type", "Type", "text"), c("orderCode", "Order", "text"), c("vendor", "Vendor", "text"),
      c("amount", "Amount", "money"), c("status", "Status", "text"), c("origin", "Raised by", "text"), c("reason", "Reason", "text"),
      c("settlementEffect", "Settlement effect", "text"), c("decidedBy", "Decided by", "text")],
  },
  {
    kind: "marketing", label: "Marketing campaign report", blurb: "Banners and promo codes: reach, use and sales.",
    filters: ["vendor", "zone"], statusOptions: [], permission: "reports", dayBased: false,
    columns: [c("campaign", "Campaign", "text"), c("type", "Type", "text"), c("vendor", "Vendor", "text"), c("start", "Starts", "datetime"),
      c("end", "Ends", "datetime"), c("status", "Status", "text"), c("budget", "Budget", "money"), c("fundedBy", "Funded by", "text"),
      c("impressions", "Impressions", "int"), c("clicks", "Clicks", "int"), c("redemptions", "Redemptions", "int"),
      c("discountGiven", "Discount given", "money"), c("attributedOrders", "Attributed orders", "int"), c("attributedSales", "Attributed sales", "money")],
  },
  {
    kind: "support-tickets", label: "Support ticket report", blurb: "Tickets, response and resolution times.",
    filters: ["zone", "status"],
    statusOptions: [
      { value: "open", label: "Open" }, { value: "in_progress", label: "In progress" }, { value: "waiting_on_requester", label: "Waiting on requester" },
      { value: "escalated", label: "Escalated" }, { value: "resolved", label: "Resolved" }, { value: "closed", label: "Closed" },
    ],
    permission: "reports", dayBased: false,
    columns: [c("number", "Ticket", "int"), c("createdAt", "Opened", "datetime"), c("requesterRole", "From", "text"), c("category", "Category", "text"),
      c("priority", "Priority", "text"), c("status", "Status", "text"), c("escalationLevel", "Escalation", "int"), c("assignedTo", "Assigned to", "text"),
      c("firstResponseMinutes", "First response (min)", "minutes"), c("resolutionMinutes", "Resolution (min)", "minutes"),
      c("orderCode", "Order", "text"), c("vendor", "Vendor", "text")],
  },
  {
    kind: "cash-reconciliation", label: "Cash reconciliation report", blurb: "Cash riders collected against what they deposited.",
    filters: ["rider", "zone"], statusOptions: [], permission: "finance_or_cash", dayBased: false,
    columns: [c("date", "Date", "date"), c("rider", "Rider", "text"), c("code", "Rider ID", "text"), c("codOrders", "COD orders", "int"),
      c("collected", "Collected", "money"), c("deposited", "Deposited", "money"), c("pending", "Pending", "money"), c("status", "Status", "text")],
  },
  {
    kind: "finance-daily", label: "Daily finance report", blurb: "Every money figure, day by day.",
    filters: ["vendor", "zone"], statusOptions: [], permission: "finance", dayBased: true,
    columns: [c("date", "Date", "date"), c("customerPaid", "Customer paid", "money"), c("grossSales", "Gross sales", "money"),
      c("discountsVendor", "Vendor-funded discounts", "money"), c("discountsPlatform", "Deligro-funded discounts", "money"), c("refunds", "Refunds", "money"),
      c("netSales", "Net sales", "money"), c("deliveryFees", "Delivery fees", "money"), c("commission", "Commission", "money"),
      c("commissionGst", "GST on commission", "money"), c("vendorPaidOut", "Paid to vendors", "money"), c("riderPaidOut", "Paid to riders", "money2")],
  },
  {
    kind: "average-order", label: "Average order report", blurb: "Average value of an order, day by day.",
    filters: ["vendor", "zone", "payment"], statusOptions: [], permission: "reports", dayBased: true,
    columns: [c("date", "Date", "date"), c("orders", "Orders", "int"), c("aov", "Average order", "money")],
  },
];

const ALIASES: Record<string, ReportKindId> = { earnings: "commission", settlement: "vendor-settlement" };

export function resolveKind(raw: string | null | undefined): ReportKindId | null {
  if (!raw) return null;
  if (ALIASES[raw]) return ALIASES[raw];
  return REPORTS.some((r) => r.kind === raw) ? (raw as ReportKindId) : null;
}

export function reportMeta(kind: ReportKindId): ReportDefinitionMeta {
  return REPORTS.find((r) => r.kind === kind)!;
}

/** May this caller run this kind? Admins run everything. */
export function mayRun(def: ReportDefinitionMeta, perms: Record<string, boolean>, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  if (perms["manager.reports.view"] !== true) return false;
  if (def.permission === "reports") return true;
  if (def.permission === "finance") return perms["manager.finance.view"] === true;
  return perms["manager.finance.view"] === true || perms["manager.cash"] === true;
}

export function permittedKinds(perms: Record<string, boolean>, isAdmin: boolean): ReportDefinitionMeta[] {
  return REPORTS.filter((r) => mayRun(r, perms, isAdmin));
}

/** The kind's columns as this viewer sees them (finance columns only with finance.view). */
export function visibleColumns(def: ReportDefinitionMeta, canSeeFinance: boolean): ReportColumnDef[] {
  return def.columns.filter((col) => canSeeFinance || !col.finance);
}
