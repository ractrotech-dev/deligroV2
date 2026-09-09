import Link from "next/link";
import { Plus } from "lucide-react";
import { ConsoleOnly } from "@/components/admin/console-only";
import {
  Empty,
  Figure,
  FigureRow,
  FinancialBreakdown,
  PageHeader,
  Panel,
  Section,
  SectionCol,
  SectionRow,
  StatusBadge,
  StatusText,
  Tabs,
  type Tone,
} from "@/components/admin/console";
import {
  DataTable,
  TableFooter,
  type Column,
} from "@/components/admin/data-table";
import {
  getSettlementStats,
  listSettlements,
  listVendorSettlementQueue,
  type SettlementListItem,
  type SettlementStatus,
  type VendorSettlementQueue,
  type VendorSettlementQueueRow,
} from "@/lib/data-access/admin-settlements";
import { formatINR } from "@/lib/utils/format";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * Admin → Settlements. Two lists, in the order the work happens:
 *
 *   1. the queue  — one row per vendor, what is owed right now, unbatched.
 *   2. the ledger — the batches somebody has already built, and their status.
 *
 * The queue comes first because it is the only one that exists on day one: a
 * screen built solely from `vendor_settlements` shows an empty state while
 * twenty shops are owed money, which is the wrong answer to "who do I pay".
 *
 * Money still moves by bank or UPI outside the app. This screen records the
 * decision and the reference; it does not move funds, and the copy below says
 * so — a payout screen that reads as if it transfers is how a vendor gets told
 * they have been paid when nobody has sent anything.
 */
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<SettlementStatus, Tone> = {
  draft: "amber",
  paid: "green",
  void: "neutral",
};

const STATUS_LABEL: Record<SettlementStatus, string> = {
  draft: "Draft",
  paid: "Paid",
  void: "Void",
};

const STATUS_ORDER: SettlementStatus[] = ["draft", "paid", "void"];

const dayFmt = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  timeZone: "Asia/Kolkata",
});

function shortDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dayFmt.format(d);
}

function waitLabel(days: number): string {
  if (days <= 0) return "Today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

/** Rows per page. Both tables are scanned, not read, so a screenful is plenty. */
const QUEUE_PAGE_SIZE = 20;
const BATCH_PAGE_SIZE = 20;

function toPage(raw: string | undefined, totalPages: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, Math.trunc(n)), Math.max(1, totalPages));
}

export default async function AdminSettlementsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; batch?: string }>;
}) {
  if (!isSupabaseConfigured) {
    return (
      <PageHeader
        title="Settlements"
        description="Connect Supabase to settle vendors."
      />
    );
  }

  const sp = await searchParams;
  const status = STATUS_ORDER.includes(sp.status as SettlementStatus)
    ? (sp.status as SettlementStatus)
    : null;

  let rows: SettlementListItem[] = [];
  let queue: VendorSettlementQueue = {
    rows: [],
    scanned: 0,
    truncated: false,
  };
  let stats = {
    draftCount: 0,
    paidThisWeek: 0,
    paidThisWeekAmount: 0,
    unsettledOnlineVolume: 0,
    unsettledOrderCount: 0,
  };
  let loadError: string | null = null;

  try {
    [rows, stats, queue] = await Promise.all([
      listSettlements(),
      getSettlementStats(),
      listVendorSettlementQueue(),
    ]);
  } catch {
    loadError =
      "Could not load settlements. Apply migration 0028_vendor_settlements.sql if you have not yet.";
  }

  const shown = status ? rows.filter((r) => r.status === status) : rows;

  const counts = STATUS_ORDER.map((s) => ({
    value: s,
    label: STATUS_LABEL[s],
    count: rows.filter((r) => r.status === s).length,
  })).filter((s) => s.count > 0);

  const drafts = rows.filter((r) => r.status === "draft");
  const draftTotal = drafts.reduce((sum, r) => sum + r.netPayable, 0);
  const commission = rows.reduce((sum, r) => sum + r.commission, 0);
  const recovered = rows.reduce((sum, r) => sum + r.refundsRecovered, 0);

  // Queue roll-ups. Payable and recoverable are kept apart on purpose: netting
  // them would hide "₹40k to send out" behind "₹6k owed back" and make the
  // number nobody can act on the only one on screen.
  const queuePayable = queue.rows
    .filter((r) => r.netPayable > 0)
    .reduce((sum, r) => sum + r.netPayable, 0);
  const queueRecoverable = queue.rows
    .filter((r) => r.netPayable < 0)
    .reduce((sum, r) => sum - r.netPayable, 0);
  const queueOrders = queue.rows.reduce((sum, r) => sum + r.orderCount, 0);
  const queueCommission = queue.rows.reduce(
    (sum, r) => sum + r.commission + r.commissionGst,
    0
  );
  const queueFoodGross = queue.rows.reduce((sum, r) => sum + r.foodGross, 0);
  const queueDeductions = queue.rows.reduce(
    (sum, r) => sum + r.commission + r.commissionGst + r.otherCharges,
    0
  );
  // The same deductions again, itemised — the breakdown panel states how the
  // net is arrived at, and a lump sum cannot do that.
  const queueCommissionOnly = queue.rows.reduce((sum, r) => sum + r.commission, 0);
  const queueGst = queue.rows.reduce((sum, r) => sum + r.commissionGst, 0);
  const queueOtherCharges = queue.rows.reduce((sum, r) => sum + r.otherCharges, 0);
  const queueRefunds = queue.rows.reduce((sum, r) => sum + r.refundsRecovered, 0);
  const overdue = queue.rows.filter((r) => r.overdue).length;
  const noPayoutDetails = queue.rows.filter((r) => !r.hasPayoutDetails).length;

  // Paging lives in the URL because this page is a server component: the two
  // tables page independently, and each link carries the other's position so
  // turning one page does not silently reset the other.
  const queueTotalPages = Math.max(
    1,
    Math.ceil(queue.rows.length / QUEUE_PAGE_SIZE)
  );
  const batchTotalPages = Math.max(1, Math.ceil(shown.length / BATCH_PAGE_SIZE));
  const queuePage = toPage(sp.page, queueTotalPages);
  const batchPage = toPage(sp.batch, batchTotalPages);

  const linkTo = (next: {
    status?: string | null;
    page?: number;
    batch?: number;
  }) => {
    const params = new URLSearchParams();
    const s = next.status === undefined ? status : next.status;
    const p = next.page ?? queuePage;
    const b = next.batch ?? batchPage;
    if (s) params.set("status", s);
    if (p > 1) params.set("page", String(p));
    if (b > 1) params.set("batch", String(b));
    const qs = params.toString();
    return qs ? `/admin/settlements?${qs}` : "/admin/settlements";
  };

  // A status filter re-cuts the batch list, so it starts that table at page 1.
  const href = (v: string | null) => linkTo({ status: v, batch: 1 });

  const queueRows = queue.rows.slice(
    (queuePage - 1) * QUEUE_PAGE_SIZE,
    queuePage * QUEUE_PAGE_SIZE
  );
  const batchRows = shown.slice(
    (batchPage - 1) * BATCH_PAGE_SIZE,
    batchPage * BATCH_PAGE_SIZE
  );

  const queueColumns: Column<VendorSettlementQueueRow>[] = [
    {
      key: "vendor",
      header: "Vendor",
      role: "title",
      width: "w-[200px]",
      cell: (r) => (
        // Capped rather than left to fill: a shop name is an identifier here,
        // not the content, and letting it take a third of the table pushes the
        // figures somebody actually came to compare off the right edge.
        <div className="min-w-0 max-w-[190px]">
          <p className="truncate text-[12.5px] font-semibold leading-tight text-ink">
            {r.restaurantName}
          </p>
          <p className="truncate text-[11px] leading-tight text-muted">
            {r.commissionPct}% ·{" "}
            {r.settlementCycle === "monthly" ? "Monthly" : "Weekly"}
            {r.vendorStatus !== "active" ? ` · ${r.vendorStatus}` : ""}
          </p>
        </div>
      ),
    },
    {
      key: "orders",
      header: "Unsettled",
      width: "w-[124px]",
      cell: (r) => (
        <div className="min-w-0">
          <p className="text-data whitespace-nowrap text-[12.5px] leading-tight tabular-nums text-ink">
            {r.orderCount}
            {r.orderCount ? (
              <span className="text-muted"> · {formatINR(r.foodGross)}</span>
            ) : null}
          </p>
          <p className="truncate text-[11px] leading-tight text-muted">
            {r.orderCount
              ? `${r.onlineOrders} online · ${r.cashOrders} cash`
              : "Nothing to batch"}
          </p>
        </div>
      ),
    },
    {
      key: "waiting",
      header: "Waiting",
      width: "w-[100px]",
      cell: (r) => (
        <div className="min-w-0">
          <p
            className={
              r.overdue
                ? "text-data whitespace-nowrap text-[12.5px] font-semibold leading-tight tabular-nums text-deal"
                : "text-data whitespace-nowrap text-[12.5px] leading-tight tabular-nums text-ink"
            }
          >
            {r.orderCount ? waitLabel(r.waitingDays) : "—"}
          </p>
          <p className="truncate text-[11px] leading-tight text-muted">
            {r.orderCount
              ? `Since ${shortDay(r.oldestUnsettledAt)}`
              : r.lastPaidAt
                ? `Paid ${shortDay(r.lastPaidAt)}`
                : "Never paid"}
          </p>
        </div>
      ),
    },
    {
      key: "deductions",
      header: "Platform keeps",
      align: "right",
      width: "w-[116px]",
      role: "meta",
      cell: (r) => (
        <div className="min-w-0">
          <p className="text-data whitespace-nowrap text-[12.5px] leading-tight tabular-nums text-ink">
            {formatINR(r.commission + r.commissionGst + r.otherCharges)}
          </p>
          <p className="truncate text-[11px] leading-tight text-muted">
            {r.refundsRecovered
              ? `${formatINR(r.refundsRecovered)} refunds`
              : "Commission + GST"}
          </p>
        </div>
      ),
    },
    {
      key: "flags",
      header: "Status",
      role: "trailing",
      align: "right",
      width: "w-[118px]",
      // A shop with no payout details cannot be paid at all, so that outranks
      // everything else this column could say about it — including "overdue",
      // which is advice about timing on a payment that cannot be made.
      cell: (r) => (
        <div className="flex flex-wrap items-center justify-end gap-1">
          {!r.hasPayoutDetails ? (
            <StatusBadge tone="red">No payout details</StatusBadge>
          ) : r.openDrafts > 0 ? (
            <StatusBadge tone="amber">
              {r.openDrafts === 1 ? "Draft open" : `${r.openDrafts} drafts`}
            </StatusBadge>
          ) : (
            <StatusText tone={r.overdue ? "red" : "neutral"}>
              {r.overdue ? "Overdue" : "Ready"}
            </StatusText>
          )}
        </div>
      ),
    },
    {
      key: "net",
      header: "Net payable",
      align: "right",
      width: "w-[124px]",
      cell: (r) => (
        <div className="min-w-0">
          <p
            className={
              r.netPayable < 0
                ? "text-data whitespace-nowrap text-[13px] font-semibold leading-tight tabular-nums text-deal"
                : "text-data whitespace-nowrap text-[13px] font-semibold leading-tight tabular-nums text-ink"
            }
          >
            {formatINR(Math.abs(r.netPayable))}
          </p>
          <p className="truncate text-[11px] leading-tight text-muted">
            {r.netPayable < 0 ? "Owed back" : "To send out"}
          </p>
        </div>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      role: "actions",
      align: "right",
      width: "w-[168px]",
      cell: (r) => (
        <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
          <Link
            href={`/admin/settlements/orders?vendor=${r.restaurantId}&state=unpaid`}
            className="c-btn press whitespace-nowrap"
          >
            View Orders
          </Link>
        </div>
      ),
    },
  ];

  // Column-aligned, so each figure sits under the column it totals — and it is
  // the WHOLE queue, not the page being viewed. A total that changes when you
  // turn the page is worse than no total.
  const queueTotals = {
    label: `All ${queue.rows.length} vendor${queue.rows.length === 1 ? "" : "s"}`,
    cells: {
      orders: (
        <span className="whitespace-nowrap">
          {queueOrders} · {formatINR(queueFoodGross)}
        </span>
      ),
      deductions: formatINR(queueDeductions),
      net: (
        <span className="whitespace-nowrap">
          {formatINR(queuePayable)}
          {queueRecoverable ? (
            <span className="ml-1 font-normal text-muted">
              / {formatINR(queueRecoverable)} back
            </span>
          ) : null}
        </span>
      ),
    },
  };

  const columns: Column<SettlementListItem>[] = [
    {
      key: "vendor",
      header: "Vendor",
      role: "title",
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-ink">
            {r.restaurantName}
          </p>
          <p className="text-data truncate text-[11.5px] text-muted">
            {r.periodLabel}
          </p>
        </div>
      ),
    },
    {
      key: "orders",
      header: "Orders",
      width: "w-[96px]",
      cell: (r) => (
        <div className="min-w-0">
          <p className="text-data text-[12.5px] tabular-nums text-ink">
            {r.orderCount}
          </p>
          <p className="text-data truncate text-[11.5px] text-muted">
            {formatINR(r.foodGross)} gross
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      role: "trailing",
      width: "w-[118px]",
      cell: (r) => (
        <StatusText tone={STATUS_TONE[r.status]}>
          {STATUS_LABEL[r.status]}
        </StatusText>
      ),
    },
    {
      key: "commission",
      header: "Commission",
      align: "right",
      width: "w-[110px]",
      cell: (r) => (
        <span className="text-data text-[12.5px] tabular-nums text-muted">
          {formatINR(r.commission)}
        </span>
      ),
    },
    {
      key: "net",
      header: "Net payable",
      align: "right",
      width: "w-[118px]",
      cell: (r) => (
        <span
          className={
            r.netPayable < 0
              ? "text-data text-[13px] font-semibold tabular-nums text-deal"
              : "text-data text-[13px] font-semibold tabular-nums text-ink"
          }
        >
          {formatINR(r.netPayable)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      role: "actions",
      align: "right",
      width: "w-[100px]",
      cell: (r) => (
        <Link href={`/admin/settlements/${r.id}`} className="c-btn-affirm press">
          Statement
        </Link>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Settlements"
        description="What each vendor is owed right now, and the batches already built. Money moves by bank or UPI outside the app — this screen records the decision and the reference."
        status={
          queue.rows.length > 0 ? (
            <StatusBadge tone={overdue > 0 ? "red" : "amber"}>
              {queue.rows.length} vendor{queue.rows.length === 1 ? "" : "s"} to pay
            </StatusBadge>
          ) : stats.draftCount > 0 ? (
            <StatusBadge tone="amber">{stats.draftCount} draft</StatusBadge>
          ) : (
            <StatusBadge tone="green">All settled</StatusBadge>
          )
        }
        actions={
          <>
            <Link href="/admin/settlements/orders" className="c-btn c-btn-outline press">
              Order payouts
            </Link>
            {/* Reading a payout is phone work; composing a batch is not, so
                only the second one drops out. `notice={false}` — the header has
                no room for the explanation, and it is given once in the body. */}
            <ConsoleOnly tool="Building a settlement" notice={false}>
              <Link href="/admin/settlements/new" className="c-btn c-btn-dark press">
                <Plus className="size-3.5" strokeWidth={2.4} />
                New settlement
              </Link>
            </ConsoleOnly>
          </>
        }
      />

      {loadError ? (
        <p className="rounded-[var(--c-r)] border border-deal/30 bg-deal-soft px-3.5 py-2.5 text-[12.5px] text-deal">
          {loadError}
        </p>
      ) : null}

      {/* Reading payouts works on a phone; composing a batch is console work,
          so the New settlement button drops out of the header and says why
          here — once, rather than at each of its call sites. */}
      <ConsoleOnly
        tool="Building a settlement"
        why="Reading a statement and tracking a payout already raised both work on a phone — only composing a new batch needs the desk."
      />

      {/* ---------- the position, before the list of who it is owed to ----------
          A derivation rather than eight tiles. Eight figures side by side state
          what each number is; they do not state how the last one comes from the
          first, which on a payout screen is the whole question a vendor rings up
          to ask. The arithmetic here is the same arithmetic `settlements/math`
          performs per batch — this is its sum over everything unbatched. */}
      <SectionRow>
        <SectionCol basis={300}>
          <Panel title="Unsettled position" meta="not in any batch yet">
            <FinancialBreakdown
              lines={[
                {
                  label: "Food sales",
                  value: formatINR(queueFoodGross),
                  note: `${queueOrders} delivered order${queueOrders === 1 ? "" : "s"} across ${queue.rows.length} vendor${queue.rows.length === 1 ? "" : "s"}`,
                },
                {
                  label: "Platform commission",
                  value: `− ${formatINR(queueCommissionOnly)}`,
                  negative: true,
                },
                {
                  label: "GST on commission",
                  value: `− ${formatINR(queueGst)}`,
                  negative: true,
                },
                {
                  label: "Other charges",
                  value: `− ${formatINR(queueOtherCharges)}`,
                  negative: true,
                },
                {
                  label: "Refunds recovered",
                  value: `− ${formatINR(queueRefunds)}`,
                  note: "Already refunded to customers, taken back from the payout",
                  negative: true,
                },
              ]}
              total={{
                label: "Net across the queue",
                value: formatINR(queuePayable - queueRecoverable),
                note: "Positive means the platform owes shops on balance",
              }}
            />
          </Panel>
        </SectionCol>

        <SectionCol grow={1.5} basis={340}>
          <Section flush title="Position" meta="the two halves, kept apart">
            {/* Payable and recoverable are deliberately never netted in the
                figures an operator acts on: one number reading "₹34k" hides
                "₹40k to send out" behind "₹6k owed back", and nobody can act on
                the difference. */}
            <FigureRow>
              <Figure
                label="To send out"
                value={formatINR(queuePayable)}
                note="Online food money the platform is holding"
              />
              <Figure
                label="Recoverable from cash"
                value={formatINR(queueRecoverable)}
                note="Deductions on COD orders, off the next payout"
              />
              <Figure
                label="Commission pending"
                value={formatINR(queueCommission)}
                note="Including GST, on orders not yet batched"
              />
              <Figure
                label="Drafts outstanding"
                value={formatINR(draftTotal)}
                note={`${stats.draftCount} batch${stats.draftCount === 1 ? "" : "es"} built, not yet paid`}
              />
              <Figure
                label="Paid this week"
                value={formatINR(stats.paidThisWeekAmount)}
                note={`${stats.paidThisWeek} batch${stats.paidThisWeek === 1 ? "" : "es"} since Monday`}
              />
              <Figure
                label="Commission earned"
                value={formatINR(commission)}
                note="Across every batch on this screen"
              />
              <Figure
                label="Recovered from refunds"
                value={formatINR(recovered)}
                note="Deducted from vendor payouts"
              />
              <Figure
                label="Unsettled online food"
                value={formatINR(stats.unsettledOnlineVolume)}
                note={`${stats.unsettledOrderCount} order${stats.unsettledOrderCount === 1 ? "" : "s"} not batched`}
              />
            </FigureRow>
          </Section>
        </SectionCol>
      </SectionRow>

      {/* ---------- the queue: who is owed what, before any batch exists ---------- */}
      <Section
        title="Needs settlement"
        meta="delivered orders not in any batch, priced at each vendor's own rate"
        actions={
          queue.rows.length ? (
            <span className="text-[11.5px] text-muted">
              {overdue > 0 ? (
                <span className="font-semibold text-deal">{overdue} overdue</span>
              ) : null}
              {overdue > 0 && noPayoutDetails > 0 ? " · " : ""}
              {noPayoutDetails > 0 ? (
                <span className="font-semibold text-[color:var(--c-ink-amber)]">
                  {noPayoutDetails} without payout details
                </span>
              ) : null}
              {overdue > 0 || noPayoutDetails > 0 ? " · " : ""}
              {formatINR(queuePayable)} to send out
            </span>
          ) : null
        }
      >
        {queue.truncated ? (
          <p className="rounded-[var(--c-r)] border border-pop/40 bg-[var(--c-tint-amber)] px-3 py-2 text-[12px] text-[color:var(--c-ink-amber)]">
            Only the oldest {queue.scanned.toLocaleString("en-IN")} delivered
            orders were scanned, so these figures are a floor. Settle the backlog
            and the rest will appear.
          </p>
        ) : null}

        <DataTable
          columns={queueColumns}
          rows={queueRows}
          rowKey={(r) => r.restaurantId}
          caption="Vendors needing settlement"
          minWidth={960}
          dense
          totals={queueTotals}
          rowTone={(r) => (r.overdue || !r.hasPayoutDetails ? "alert" : null)}
          empty={
            <Empty
              action={{ href: "/admin/settlements/new", label: "New settlement" }}
            >
              Every vendor is settled. Delivered orders appear here as soon as
              there are any no batch covers.
            </Empty>
          }
          footer={
            <TableFooter
              page={queuePage}
              totalPages={queueTotalPages}
              hrefFor={(p) => linkTo({ page: p })}
              summary={`Showing ${(queuePage - 1) * QUEUE_PAGE_SIZE + 1}–${Math.min(queuePage * QUEUE_PAGE_SIZE, queue.rows.length)} of ${queue.rows.length} vendors`}
            />
          }
        />
      </Section>

      {/* ---------- the ledger: batches already built ---------- */}
      {rows.length > 0 ? (
        <Section
          title="Settlement batches"
          meta="transfers are made by bank or UPI outside the app"
          actions={
            counts.length > 1 ? (
              <Tabs
                label="Settlement status"
                active={href(status)}
                items={[
                  { href: href(null), label: "All", count: rows.length },
                  ...counts.map((c) => ({
                    href: href(c.value),
                    label: c.label,
                    count: c.count,
                  })),
                ]}
              />
            ) : null
          }
        >
          <DataTable
            columns={columns}
            rows={batchRows}
            rowKey={(r) => r.id}
            rowHref={(r) => `/admin/settlements/${r.id}`}
            caption="Vendor settlements"
            dense
            totals={{
              label: status
                ? `All ${shown.length} ${STATUS_LABEL[status].toLowerCase()}`
                : `All ${rows.length} batch${rows.length === 1 ? "" : "es"}`,
              cells: {
                orders: `${shown.reduce((s, r) => s + r.orderCount, 0)}`,
                commission: formatINR(
                  shown.reduce((s, r) => s + r.commission, 0)
                ),
                net: formatINR(shown.reduce((s, r) => s + r.netPayable, 0)),
              },
            }}
            empty={
              <Empty action={{ href: "/admin/settlements", label: "Clear filter" }}>
                No batches with that status.
              </Empty>
            }
            footer={
              <TableFooter
                page={batchPage}
                totalPages={batchTotalPages}
                hrefFor={(p) => linkTo({ batch: p })}
                summary={`Showing ${(batchPage - 1) * BATCH_PAGE_SIZE + 1}–${Math.min(batchPage * BATCH_PAGE_SIZE, shown.length)} of ${shown.length}${status ? ` ${STATUS_LABEL[status].toLowerCase()} of ${rows.length}` : ""} batch${shown.length === 1 ? "" : "es"}`}
              />
            }
          />
        </Section>
      ) : null}

      <p className="rounded-[var(--c-r)] border border-line bg-surface px-3.5 py-2.5 text-[12px] leading-relaxed text-muted">
        Orders paid online put the food money on the platform, so that money is
        sent to the shop. Cash orders already left the money with the shop, so
        the commission, its GST and any other charges are{" "}
        <strong className="text-ink">taken off</strong> the next payout instead —
        which is why a vendor&apos;s net can read as owed back. Money still moves
        by bank or UPI outside the app; Mark paid records the reference. To pay a
        single order early, use{" "}
        <Link
          href="/admin/settlements/orders"
          className="font-medium text-accent-ink"
        >
          Order payouts
        </Link>
        .
      </p>
    </>
  );
}
