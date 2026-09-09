import Link from "next/link";
import {
  Empty,
  PageHeader,
  Panel,
  Section,
  Tabs,
} from "@/components/admin/console";
import { PayoutTotals } from "@/components/admin/payout-breakdown";
import {
  listOrderPayouts,
  listSettlementVendors,
} from "@/lib/data-access/admin-settlements";
import {
  CYCLE_LABEL,
  currentPeriod,
  formatDayKey,
  nextPayoutDay,
} from "@/lib/settlements/cycle";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formatINR } from "@/lib/utils/format";
import { OrderPayoutRowCard } from "./order-payout-row";
import { OrderPayoutFilters } from "./payout-filters";

/**
 * Admin → Settlements → Order payouts.
 *
 * One shop's delivered orders, each with what it is worth and a Paid / Unpaid
 * dropdown. This is the "pay me now" screen: a shop with a single order that
 * does not want to wait for its cycle gets paid from here, and the order drops
 * out of the next batch by itself.
 *
 * Paid is not a column on the order — it is membership of a settlement. That is
 * why this screen and the batch builder can never disagree about which orders
 * are still owed: they are reading the same fact.
 */
export const dynamic = "force-dynamic";

type Search = { [key: string]: string | string[] | undefined };

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function OrderPayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  if (!isSupabaseConfigured) {
    return (
      <PageHeader
        back={{ href: "/admin/settlements", label: "Settlements" }}
        title="Order payouts"
        description="Connect Supabase to pay orders."
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

  const result = restaurantId
    ? await listOrderPayouts(restaurantId, {
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        state,
      }).catch(() => ({
        error:
          "Could not load orders. Apply migrations 0028 and 0034 if you have not yet.",
      }))
    : null;

  const error = result && "error" in result ? result.error : null;
  const page = result && !("error" in result) ? result : null;

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
  const period = cycle ? currentPeriod(cycle) : null;

  return (
    <>
      <PageHeader
        back={{ href: "/admin/settlements", label: "Settlements" }}
        title="Order payouts"
        description="Pay a single order early, or check what is still owed. Money moves by bank or UPI outside the app — marking an order paid records that you sent it and takes it out of the next settlement."
        actions={
          restaurantId ? (
            <Link
              href={`/admin/settlements/new?restaurantId=${restaurantId}`}
              className="c-btn c-btn-dark press"
            >
              Pay the whole period
            </Link>
          ) : null
        }
      />

      <OrderPayoutFilters
        vendors={vendors.map((v) => ({ id: v.id, name: v.name }))}
        restaurantId={restaurantId}
        fromDate={fromDate}
        toDate={toDate}
      />

      {error ? (
        <p className="rounded-[var(--c-r)] border border-deal/30 bg-deal-soft px-3.5 py-2.5 text-[12.5px] text-deal">
          {error}
        </p>
      ) : null}

      {!restaurantId ? (
        <Empty>
          Pick a shop above to see every delivered order, what it is worth, and
          whether it has been paid.
        </Empty>
      ) : null}

      {page && vendor && cycle && period ? (
        <p className="rounded-[var(--c-r)] border border-line bg-surface-2 px-3.5 py-2.5 text-[12px] leading-relaxed text-muted">
          <span className="font-medium text-ink">{page.restaurantName}</span> is
          paid {CYCLE_LABEL[cycle].toLowerCase()}. The period running now is{" "}
          {formatDayKey(period.from)} – {formatDayKey(period.to)}, so the next
          full payout can be built on{" "}
          <span className="font-medium text-ink">
            {formatDayKey(nextPayoutDay(cycle))}
          </span>
          . Anything marked Paid here is left out of it.
        </p>
      ) : null}

      {page ? (
        <>
          <Panel
            title={`Still to pay ${page.restaurantName}`}
            meta={`${page.unpaidCount} unpaid order${page.unpaidCount === 1 ? "" : "s"}`}
            className="admin-measure"
          >
            <PayoutTotals
              totals={page.unpaidTotals}
              commissionPct={page.terms.commissionPct}
              commissionGstPct={page.terms.commissionGstPct}
              orderCount={page.unpaidCount}
            />
            {page.terms.otherChargesPerOrder > 0 ? (
              <p className="mt-2 text-[11px] text-muted">
                Other charges are{" "}
                {formatINR(page.terms.otherChargesPerOrder)} per order for this
                shop.
              </p>
            ) : null}
          </Panel>

          <Section
            title="Delivered orders"
            meta={`${page.rows.length} shown`}
            actions={
              <Tabs
                label="Payout status"
                active={href({ state })}
                items={[
                  {
                    href: href({ state: undefined }),
                    label: "All",
                    count: page.rows.length,
                  },
                  {
                    href: href({ state: "unpaid" }),
                    label: "Unpaid",
                    count: page.unpaidCount,
                  },
                  {
                    href: href({ state: "paid" }),
                    label: "Paid",
                    count: page.rows.filter((r) => r.paid).length,
                  },
                ]}
              />
            }
          >
            {page.rows.length === 0 ? (
              <Empty
                action={{
                  href: href({ state: undefined }),
                  label: "Clear status filter",
                }}
              >
                No delivered orders match these filters.
              </Empty>
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
