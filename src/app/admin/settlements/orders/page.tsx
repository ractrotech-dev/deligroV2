import { requireRole } from "@/lib/auth";
import Link from "next/link";
import {
  Empty,
  PageHeader,
  Section,
  Tabs,
} from "@/components/admin/console";
import { PayHero, PayToCard } from "@/components/admin/payout-breakdown";
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
import { OrderPayoutRowCard } from "./order-payout-row";
import { PayAllButton } from "./pay-all-button";
import { OrderDateFilter, OrderPayoutFilters } from "./payout-filters";

/**
 * Admin → Settlements → one shop.
 *
 * The screen answers one question: how much do I send this shop? That amount
 * comes first, worked out already, then where to send it and one button. The
 * orders behind it follow, one line each.
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
  filters: { fromDate: string; toDate: string; state?: "paid" | "unpaid" }
) {
  if (!restaurantId) return { error: null, page: null, owed: null };
  const [listed, owed] = await Promise.all([
    listOrderPayouts(restaurantId, {
      fromDate: filters.fromDate || undefined,
      toDate: filters.toDate || undefined,
      state: filters.state,
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

  const vendors = await listSettlementVendors().catch(() => []);
  const vendor = vendors.find((v) => v.id === restaurantId);

  const { error, page, owed } = await loadShop(restaurantId, {
    fromDate,
    toDate,
    state,
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
  const waiting = page?.openDrafts ?? [];

  return (
    <>
      <PageHeader
        back={{ href: "/admin/settlements", label: "Settlements" }}
        title="Pay a shop"
      />

      <OrderPayoutFilters
        vendors={vendors.map((v) => ({ id: v.id, name: v.name }))}
        restaurantId={restaurantId}
      />

      {error ? (
        <p className="rounded-[var(--c-r)] border border-deal/30 bg-deal-soft px-3.5 py-2.5 text-[13px] text-deal">
          {error}
        </p>
      ) : null}

      {!restaurantId ? <Empty>Choose a shop to see how much to send.</Empty> : null}

      {page && owed ? (
        <>
          <PayHero
            shop={page.restaurantName}
            amount={owed.netPayable}
            orderCount={owed.lines.length}
            note={
              cycle
                ? `Paid ${CYCLE_LABEL[cycle].toLowerCase()}. Next payment day is ${formatDayKey(nextPayoutDay(cycle))}.`
                : undefined
            }
          >
            {owed.netPayable > 0 ? (
              <>
                <PayToCard payout={page.payout} />
                <PayAllButton
                  restaurantId={page.restaurantId}
                  amount={owed.netPayable}
                />
                <Link
                  href={`/admin/settlements/new?restaurantId=${page.restaurantId}`}
                  className="press block text-[13px] font-medium text-muted"
                >
                  Pay only some dates instead
                </Link>
              </>
            ) : null}
            {owed.netPayable < 0 ? (
              <p className="text-[13px] leading-snug text-muted">
                This shop&apos;s refunds and charges came to more than its orders. It
                comes off their next payment, so there is nothing to do now.
              </p>
            ) : null}
          </PayHero>

          {waiting.map((draft) => (
            <Link
              key={draft.id}
              href={`/admin/settlements/${draft.id}`}
              className="press flex min-h-12 items-center justify-between gap-3 rounded-xl border border-pop/40 bg-[var(--c-tint-amber)] px-3.5 py-2.5 text-[13.5px] text-[color:var(--c-ink-amber)]"
            >
              <span>
                A payment of{" "}
                <span className="text-data font-semibold tabular-nums">
                  {formatINR(draft.netPayable)}
                </span>{" "}
                is waiting to be finished
              </span>
              <span className="shrink-0 font-semibold">Open</span>
            </Link>
          ))}

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
            <OrderDateFilter fromDate={fromDate} toDate={toDate} />
            {page.rows.length === 0 ? (
              <Empty>No orders here.</Empty>
            ) : (
              <ul className="space-y-2">
                {page.rows.map((row) => (
                  <OrderPayoutRowCard
                    key={row.orderId}
                    row={row}
                    commissionPct={page.terms.commissionPct}
                    commissionGstPct={page.terms.commissionGstPct}
                  />
                ))}
              </ul>
            )}
          </Section>
        </>
      ) : null}
    </>
  );
}
