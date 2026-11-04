import { requireRole } from "@/lib/auth";
import Link from "next/link";
import {
  Empty,
  PageHeader,
  Section,
  SectionCol,
  SectionRow,
  Tabs,
} from "@/components/admin/console";
import { TableFooter } from "@/components/admin/data-table";
import { PayFigure, PayToList } from "@/components/admin/payout-breakdown";
import { pageCountOf, toPage } from "@/lib/utils/paging";
import {
  listOrderPayouts,
  listSettlementVendors,
  previewAllUnpaid,
} from "@/lib/data-access/admin-settlements";
import {
  CYCLE_LABEL,
  formatDayKey,
  nextPayoutDay,
} from "@/lib/settlements/cycle";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formatINR } from "@/lib/utils/format";
import { OrderPayoutsTable } from "./order-payout-row";
import { PayAllButton } from "./pay-all-button";
import { OrderPayoutFilters } from "./payout-filters";

/**
 * Admin → Settlements → one shop.
 *
 * The screen answers one question: how much do I send this shop? That amount
 * comes first, worked out already, with where to send it and one button beside it.
 * The orders behind it follow in a table, each row reading as its own sum.
 *
 * Paid is not a column on the order — it is membership of a settlement. That is
 * why this screen and the shop list can never disagree about what is owed.
 */
export const dynamic = "force-dynamic";

type Search = { [key: string]: string | string[] | undefined };

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const LOAD_ERROR = "Could not load this shop's orders. Refresh to try again.";

/** Called only after the page's `requireRole("admin")`. */
async function loadShop(
  restaurantId: string,
  filters: { fromDate: string; toDate: string; state?: "paid" | "unpaid"; page: number }
) {
  if (!restaurantId) return { error: null, page: null, owed: null };
  const [listed, owed] = await Promise.all([
    listOrderPayouts(restaurantId, {
      fromDate: filters.fromDate || undefined,
      toDate: filters.toDate || undefined,
      state: filters.state,
      page: filters.page,
    }).catch(() => ({ error: LOAD_ERROR })),
    previewAllUnpaid(restaurantId).catch(() => ({ error: LOAD_ERROR })),
  ]);
  if ("error" in listed) return { error: listed.error, page: null, owed: null };
  if ("error" in owed) return { error: owed.error, page: null, owed: null };
  return { error: null, page: listed, owed };
}

export default async function OrderPayoutsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Search>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  if (!isSupabaseConfigured) {
    return (
      <PageHeader
        back={{ href: "/admin/settlements", label: "Settlements" }}
        title="Pay a shop"
        description="Connect Supabase to pay shops."
      />
    );
  }

  const sp = await searchParams;
  const restaurantId = one(sp.vendor) ?? "";
  const stateParam = one(sp.state);
  const state =
    stateParam === "paid" || stateParam === "unpaid" ? stateParam : undefined;
  const fromDate = one(sp.from) ?? "";
  const toDate = one(sp.to) ?? "";
  const pageParam = toPage(one(sp.page));

  const vendors = await listSettlementVendors().catch(() => []);
  const vendor = vendors.find((v) => v.id === restaurantId);

  const { error, page, owed } = await loadShop(restaurantId, {
    fromDate,
    toDate,
    state,
    page: pageParam,
  });

  const href = (next: Record<string, string | undefined>) => {
    const usp = new URLSearchParams();
    const merged = {
      vendor: restaurantId,
      state,
      from: fromDate,
      to: toDate,
      ...next,
    };
    for (const [k, v] of Object.entries(merged)) if (v) usp.set(k, v);
    const qs = usp.toString();
    return qs ? `/admin/settlements/orders?${qs}` : "/admin/settlements/orders";
  };

  const cycle = vendor?.settlementCycle;

  let note: string | undefined;
  if (owed) {
    const orders = `For ${owed.lines.length} order${owed.lines.length === 1 ? "" : "s"}.`;
    note = cycle
      ? `${orders} Paid ${CYCLE_LABEL[cycle].toLowerCase()}. Next payment day is ${formatDayKey(nextPayoutDay(cycle))}.`
      : orders;
  }

  return (
    <>
      <PageHeader
        back={{ href: "/admin/settlements", label: "Settlements" }}
        title="Pay a shop"
      />

      <OrderPayoutFilters
        vendors={vendors.map((v) => ({ id: v.id, name: v.name }))}
        restaurantId={restaurantId}
        fromDate={fromDate}
        toDate={toDate}
      />

      {error ? <p className="text-[13px] font-medium text-deal">{error}</p> : null}

      {!restaurantId ? <Empty>Choose a shop to see how much to send.</Empty> : null}

      {page && owed ? (
        <>
          <SectionRow>
            <SectionCol basis={340}>
              <PayFigure
                shop={page.restaurantName}
                amount={owed.netPayable}
                note={note}
              />
              {owed.netPayable > 0 ? (
                <div className="mt-4 flex items-center gap-3">
                  <PayAllButton
                    restaurantId={page.restaurantId}
                    amount={owed.netPayable}
                  />
                  <Link
                    href={`/admin/settlements/new?restaurantId=${page.restaurantId}`}
                    className="text-[12.5px] font-medium text-muted hover:text-ink"
                  >
                    Pay only some dates instead
                  </Link>
                </div>
              ) : null}
              {owed.netPayable < 0 ? (
                <p className="mt-3 text-[12.5px] text-muted">
                  This shop&apos;s refunds and charges came to more than its orders.
                  It comes off their next payment, so there is nothing to do now.
                </p>
              ) : null}
              {page.openDrafts.map((draft) => (
                <p key={draft.id} className="mt-3 text-[12.5px] text-muted">
                  A payment of{" "}
                  <span className="text-data font-semibold tabular-nums text-ink">
                    {formatINR(draft.netPayable)}
                  </span>{" "}
                  is not finished.{" "}
                  <Link
                    href={`/admin/settlements/${draft.id}`}
                    className="font-semibold text-accent-ink"
                  >
                    Open it
                  </Link>
                </p>
              ))}
            </SectionCol>

            {owed.netPayable > 0 ? (
              <SectionCol basis={340}>
                <Section flush title="Send it to">
                  <PayToList payout={page.payout} />
                </Section>
              </SectionCol>
            ) : null}
          </SectionRow>

          <Section
            title="Orders"
            actions={
              <Tabs
                label="Payment status"
                active={href({ state })}
                items={[
                  {
                    href: href({ state: undefined }),
                    label: "All",
                    count: page.unpaidCount + page.paidCount,
                  },
                  {
                    href: href({ state: "unpaid" }),
                    label: "Unpaid",
                    count: page.unpaidCount,
                  },
                  {
                    href: href({ state: "paid" }),
                    label: "Paid",
                    count: page.paidCount,
                  },
                ]}
              />
            }
          >
            <OrderPayoutsTable
              rows={page.rows}
              commissionPct={page.terms.commissionPct}
              commissionGstPct={page.terms.commissionGstPct}
              empty={<Empty>No orders here.</Empty>}
            />
            {page.shownTotal > page.pageSize ? (
              <TableFooter
                page={page.page}
                totalPages={pageCountOf(page.shownTotal, page.pageSize)}
                hrefFor={(p) => href({ state, page: p > 1 ? String(p) : undefined })}
                summary={`${page.shownTotal} orders, newest first`}
              />
            ) : null}
          </Section>
        </>
      ) : null}
    </>
  );
}
