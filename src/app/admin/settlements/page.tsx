import { requireRole } from "@/lib/auth";
import {
  Empty,
  PageHeader,
  Section,
  Tabs,
} from "@/components/admin/console";
import { TableFooter } from "@/components/admin/data-table";
import {
  listSettlements,
  listVendorSettlementQueue,
  type SettlementListItem,
  type SettlementStatus,
  type VendorSettlementQueue,
} from "@/lib/data-access/admin-settlements";
import { formatINR } from "@/lib/utils/format";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { PaymentRow, ShopRow, STATUS_LABEL } from "./settlement-rows";

/**
 * Admin → Settlements. Two questions, in the order the work happens:
 *
 *   1. Who do I pay, and how much? One line per shop.
 *   2. What have I paid already?
 *
 * Every shop's figure is the final amount to send, already worked out. Deligro
 * receives the customer's money (cash through the rider, or online) and pays the
 * shop from it, so a shop line is money going out. The sums behind a figure live
 * one tap away, on the shop's own page.
 *
 * Money moves by bank or UPI outside the app. This screen records the decision
 * and the reference; it does not move funds.
 */
export const dynamic = "force-dynamic";

const STATUS_ORDER: SettlementStatus[] = ["draft", "paid", "void"];

/** Rows per page, for each list. */
const SHOP_PAGE_SIZE = 20;
const PAYMENT_PAGE_SIZE = 20;

function toPage(raw: string | undefined, totalPages: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, Math.trunc(n)), Math.max(1, totalPages));
}

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

  let rows: SettlementListItem[] = [];
  let queue: VendorSettlementQueue = {
    rows: [],
    scanned: 0,
    truncated: false,
  };
  let loadError: string | null = null;

  try {
    [rows, queue] = await Promise.all([
      listSettlements(),
      listVendorSettlementQueue(),
    ]);
  } catch {
    loadError = "Could not load settlements. Refresh to try again.";
  }

  // Shops owed the most urgently come first: the longest wait is the top line.
  const shops = [...queue.rows].sort((a, b) => b.waitingDays - a.waitingDays);
  const toPay = shops.filter((r) => r.netPayable > 0);
  const totalToSend = toPay.reduce((sum, r) => sum + r.netPayable, 0);

  const shown = status ? rows.filter((r) => r.status === status) : rows;
  const counts = STATUS_ORDER.map((s) => ({
    value: s,
    label: STATUS_LABEL[s],
    count: rows.filter((r) => r.status === s).length,
  })).filter((s) => s.count > 0);

  // Paging lives in the URL because this page is a server component: the two
  // lists page independently, and each link carries the other's position.
  const shopPages = Math.max(1, Math.ceil(shops.length / SHOP_PAGE_SIZE));
  const paymentPages = Math.max(1, Math.ceil(shown.length / PAYMENT_PAGE_SIZE));
  const shopPage = toPage(sp.page, shopPages);
  const paymentPage = toPage(sp.batch, paymentPages);

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

  const shopRows = shops.slice(
    (shopPage - 1) * SHOP_PAGE_SIZE,
    shopPage * SHOP_PAGE_SIZE
  );
  const paymentRows = shown.slice(
    (paymentPage - 1) * PAYMENT_PAGE_SIZE,
    paymentPage * PAYMENT_PAGE_SIZE
  );

  return (
    <>
      <PageHeader title="Settlements" />

      {loadError ? (
        <p className="rounded-[var(--c-r)] border border-deal/30 bg-deal-soft px-3.5 py-2.5 text-[13px] text-deal">
          {loadError}
        </p>
      ) : null}

      {!loadError ? (
        <section className="rounded-[var(--radius-sheet)] border border-line bg-surface p-4 @3xl:p-5">
          <h2 className="text-[14px] font-medium text-muted">
            {totalToSend > 0
              ? `Send to ${toPay.length} shop${toPay.length === 1 ? "" : "s"}`
              : "Every shop is paid"}
          </h2>
          {totalToSend > 0 ? (
            <p className="text-data mt-1 text-[38px] font-bold leading-none tracking-[-0.03em] tabular-nums text-ink">
              {formatINR(totalToSend)}
            </p>
          ) : null}
        </section>
      ) : null}

      {queue.truncated ? (
        <p className="rounded-[var(--c-r)] border border-pop/40 bg-[var(--c-tint-amber)] px-3 py-2 text-[12.5px] text-[color:var(--c-ink-amber)]">
          There are too many orders to add up at once, so the real amount is higher
          than this. Pay the oldest shops first and the rest will appear.
        </p>
      ) : null}

      {shops.length > 0 ? (
        <Section title="Shops to pay">
          <ul className="space-y-2">
            {shopRows.map((r) => (
              <ShopRow key={r.restaurantId} row={r} />
            ))}
          </ul>
          {shopPages > 1 ? (
            <TableFooter
              page={shopPage}
              totalPages={shopPages}
              hrefFor={(p) => linkTo({ page: p })}
              summary={`${shops.length} shops`}
            />
          ) : null}
        </Section>
      ) : null}

      {rows.length > 0 ? (
        <Section
          title="Past payments"
          actions={
            counts.length > 1 ? (
              <Tabs
                label="Payment status"
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
          {paymentRows.length === 0 ? (
            <Empty action={{ href: "/admin/settlements", label: "Show all" }}>
              No payments here.
            </Empty>
          ) : (
            <ul className="space-y-2">
              {paymentRows.map((r) => (
                <PaymentRow key={r.id} row={r} />
              ))}
            </ul>
          )}
          {paymentPages > 1 ? (
            <TableFooter
              page={paymentPage}
              totalPages={paymentPages}
              hrefFor={(p) => linkTo({ batch: p })}
              summary={`${shown.length} payments`}
            />
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
