import { requireRole } from "@/lib/auth";
import Link from "next/link";
import {
  Empty,
  PageHeader,
  Section,
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
  listSettlementsPage,
  listVendorSettlementQueue,
  type SettlementListItem,
  type SettlementPage,
  type SettlementStatus,
  type VendorSettlementQueue,
  type VendorSettlementQueueRow,
} from "@/lib/data-access/admin-settlements";
import { settlementHeadline } from "@/lib/settlements/headline";
import { formatINR } from "@/lib/utils/format";
import { pageCountOf, toPage } from "@/lib/utils/paging";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * Admin → Settlements. Two questions, in the order the work happens:
 *
 *   1. Who do I pay, and how much? One row per shop.
 *   2. What have I paid already?
 *
 * Every shop's figure is the final amount to send, already worked out. Deligro
 * receives the customer's money (cash through the rider, or online) and pays the
 * shop from it, so a shop's row is money going out. The sums behind a figure are
 * on the shop's own page.
 *
 * Money moves by bank or UPI outside the app. This screen records the decision
 * and the reference; it does not move funds.
 */
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<SettlementStatus, Tone> = {
  draft: "amber",
  paid: "green",
  void: "neutral",
};

const STATUS_LABEL: Record<SettlementStatus, string> = {
  draft: "Not finished",
  paid: "Paid",
  void: "Cancelled",
};

const STATUS_ORDER: SettlementStatus[] = ["draft", "paid", "void"];

const SHOP_PAGE_SIZE = 20;
const PAYMENT_PAGE_SIZE = 20;

function waitingWords(r: VendorSettlementQueueRow): string {
  if (r.orderCount === 0) return "—";
  if (r.waitingDays <= 0) return "Today";
  return `${r.waitingDays} day${r.waitingDays === 1 ? "" : "s"}`;
}

/** The one thing to chase on a shop's row, if there is one. */
function shopFlag(r: VendorSettlementQueueRow): { tone: Tone; text: string } {
  if (r.netPayable > 0 && !r.hasPayoutDetails) {
    return { tone: "red", text: "No bank details" };
  }
  if (r.openDrafts > 0) return { tone: "amber", text: "Payment not finished" };
  if (r.netPayable < 0) return { tone: "red", text: "Owes you" };
  if (r.overdue) return { tone: "red", text: "Late" };
  return { tone: "neutral", text: "Ready" };
}

const shopColumns: Column<VendorSettlementQueueRow>[] = [
  {
    key: "shop",
    header: "Shop",
    cell: (r) => (
      <span className="text-[13px] font-semibold text-ink">{r.restaurantName}</span>
    ),
  },
  {
    key: "orders",
    header: "Orders",
    width: "w-[90px]",
    cell: (r) => (
      <span className="text-data text-[12.5px] tabular-nums text-muted">
        {r.orderCount}
      </span>
    ),
  },
  {
    key: "waiting",
    header: "Waiting",
    width: "w-[100px]",
    cell: (r) => (
      <span className="text-data text-[12.5px] tabular-nums text-muted">
        {waitingWords(r)}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    width: "w-[170px]",
    cell: (r) => {
      const flag = shopFlag(r);
      return <StatusText tone={flag.tone}>{flag.text}</StatusText>;
    },
  },
  {
    key: "amount",
    header: "Send",
    align: "right",
    width: "w-[120px]",
    cell: (r) => (
      <span
        className={`text-data text-[14px] font-bold tabular-nums ${
          r.netPayable < 0 ? "text-deal" : "text-ink"
        }`}
      >
        {formatINR(Math.abs(r.netPayable))}
      </span>
    ),
  },
  {
    key: "pay",
    header: "",
    align: "right",
    width: "w-[90px]",
    cell: (r) => (
      <Link
        href={`/admin/settlements/orders?vendor=${r.restaurantId}&state=unpaid`}
        className="c-btn-affirm"
      >
        {r.netPayable > 0 ? "Pay" : "Open"}
      </Link>
    ),
  },
];

const paymentColumns: Column<SettlementListItem>[] = [
  {
    key: "shop",
    header: "Shop",
    cell: (r) => (
      <span className="text-[13px] font-semibold text-ink">{r.restaurantName}</span>
    ),
  },
  {
    key: "dates",
    header: "Dates",
    cell: (r) => (
      <span className="text-data text-[12.5px] text-muted">{r.periodLabel}</span>
    ),
  },
  {
    key: "orders",
    header: "Orders",
    width: "w-[90px]",
    cell: (r) => (
      <span className="text-data text-[12.5px] tabular-nums text-muted">
        {r.orderCount}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    width: "w-[140px]",
    cell: (r) => (
      <StatusText tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusText>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    width: "w-[120px]",
    cell: (r) => (
      <span className="text-data text-[13px] font-semibold tabular-nums text-ink">
        {formatINR(Math.abs(r.netPayable))}
      </span>
    ),
  },
];

export default async function AdminSettlementsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ status?: string; page?: string; batch?: string }>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  if (!isSupabaseConfigured) {
    return (
      <PageHeader
        title="Settlements"
        description="Connect Supabase to pay shops."
      />
    );
  }

  const sp = await searchParams;
  const status = STATUS_ORDER.includes(sp.status as SettlementStatus)
    ? (sp.status as SettlementStatus)
    : null;

  let payments: SettlementPage = {
    rows: [],
    counts: { draft: 0, paid: 0, void: 0 },
  };
  let queue: VendorSettlementQueue = {
    rows: [],
    scanned: 0,
    truncated: false,
  };
  let loadError: string | null = null;

  try {
    [payments, queue] = await Promise.all([
      listSettlementsPage({
        status,
        page: toPage(sp.batch),
        pageSize: PAYMENT_PAGE_SIZE,
      }),
      listVendorSettlementQueue(),
    ]);
  } catch {
    loadError = "Could not load settlements. Refresh to try again.";
  }

  // The longest wait comes first.
  const shops = [...queue.rows].sort((a, b) => b.waitingDays - a.waitingDays);
  const toPay = shops.filter((r) => r.netPayable > 0);
  const owingBack = shops.filter((r) => r.netPayable < 0);

  // The whole truth about money still owed: what is in no payment yet, and what
  // is in a payment nobody has finished. Either one means not every shop is paid.
  const headline = settlementHeadline({
    toSend: toPay.reduce((sum, r) => sum + r.netPayable, 0),
    toSendShops: toPay.length,
    unfinishedAmount: shops.reduce((sum, r) => sum + Math.max(0, r.openDraftAmount), 0),
    unfinishedCount: shops.reduce((sum, r) => sum + r.openDrafts, 0),
    owedBack: owingBack.reduce((sum, r) => sum - r.netPayable, 0),
    owedBackShops: owingBack.length,
    truncated: queue.truncated,
  });

  const allPayments = STATUS_ORDER.reduce((sum, s) => sum + payments.counts[s], 0);
  const shownTotal = status ? payments.counts[status] : allPayments;
  const counts = STATUS_ORDER.map((s) => ({
    value: s,
    label: STATUS_LABEL[s],
    count: payments.counts[s],
  })).filter((s) => s.count > 0);

  // Paging lives in the URL because this page is a server component: the two
  // lists page independently, and each link carries the other's position.
  const shopPages = pageCountOf(shops.length, SHOP_PAGE_SIZE);
  const paymentPages = pageCountOf(shownTotal, PAYMENT_PAGE_SIZE);
  const shopPage = Math.min(toPage(sp.page), shopPages);
  const paymentPage = Math.min(toPage(sp.batch), paymentPages);

  const linkTo = (next: {
    status?: string | null;
    page?: number;
    batch?: number;
  }) => {
    const params = new URLSearchParams();
    const s = next.status === undefined ? status : next.status;
    const p = next.page ?? shopPage;
    const b = next.batch ?? paymentPage;
    if (s) params.set("status", s);
    if (p > 1) params.set("page", String(p));
    if (b > 1) params.set("batch", String(b));
    const qs = params.toString();
    return qs ? `/admin/settlements?${qs}` : "/admin/settlements";
  };

  // A status filter re-cuts the payment list, so it starts that list at page 1.
  const href = (v: string | null) => linkTo({ status: v, batch: 1 });

  return (
    <>
      <PageHeader title="Settlements" />

      {loadError ? (
        <p className="text-[13px] font-medium text-deal">{loadError}</p>
      ) : null}

      {!loadError ? (
        <div>
          <h2 className="text-[13px] font-medium text-muted">{headline.title}</h2>
          {headline.amount !== null ? (
            <p className="text-data mt-1 text-[34px] font-bold leading-none tracking-[-0.03em] tabular-nums text-ink">
              {formatINR(headline.amount)}
            </p>
          ) : null}
          {headline.notes.map((note) => (
            <p key={note} className="mt-1.5 text-[12.5px] text-muted">
              {note}
            </p>
          ))}
        </div>
      ) : null}

      {queue.truncated ? (
        <p className="text-[12.5px] font-medium text-[color:var(--c-ink-amber)]">
          There are too many orders to add up at once, so the real amount is higher
          than this. Pay the oldest shops first and the rest will appear.
        </p>
      ) : null}

      {shops.length > 0 ? (
        <Section title="Shops to pay">
          <DataTable
            columns={shopColumns}
            rows={shops.slice(
              (shopPage - 1) * SHOP_PAGE_SIZE,
              shopPage * SHOP_PAGE_SIZE
            )}
            rowKey={(r) => r.restaurantId}
            caption="Shops to pay"
            rowTone={(r) =>
              r.overdue || (r.netPayable > 0 && !r.hasPayoutDetails)
                ? "alert"
                : null
            }
            footer={
              shopPages > 1 ? (
                <TableFooter
                  page={shopPage}
                  totalPages={shopPages}
                  hrefFor={(p) => linkTo({ page: p })}
                  summary={`${shops.length} shops`}
                />
              ) : undefined
            }
          />
        </Section>
      ) : null}

      {allPayments > 0 ? (
        <Section
          title="Past payments"
          actions={
            counts.length > 1 ? (
              <Tabs
                label="Payment status"
                active={href(status)}
                items={[
                  { href: href(null), label: "All", count: allPayments },
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
            columns={paymentColumns}
            rows={payments.rows}
            rowKey={(r) => r.id}
            rowHref={(r) => `/admin/settlements/${r.id}`}
            caption="Past payments"
            empty={
              <Empty action={{ href: "/admin/settlements", label: "Show all" }}>
                No payments here.
              </Empty>
            }
            footer={
              paymentPages > 1 ? (
                <TableFooter
                  page={paymentPage}
                  totalPages={paymentPages}
                  hrefFor={(p) => linkTo({ batch: p })}
                  summary={`${shownTotal} payments`}
                />
              ) : undefined
            }
          />
        </Section>
      ) : null}
    </>
  );
}
