import Link from "next/link";
import { ChartCard, Panel } from "@/components/admin/admin-ui";
import { ShareBar, type ShareSegment } from "@/components/admin/console-ui";
import { ConsoleOnly } from "@/components/admin/console-only";
import { TrendChart } from "@/components/admin/charts/lazy";
import type { AdminSeries } from "@/lib/data-access/admin-series";
import type { VendorEarningsSummary } from "@/lib/data-access/vendor-earnings";
import { formatINR } from "@/lib/utils/format";

const nf = new Intl.NumberFormat("en-IN");

/**
 * Console-width report for one shop: sales chart, mix, dishes, recent
 * orders, busy hours. Hidden in the phone frame via `@3xl` — the KPIs and
 * fact cards on the overview already cover a handset.
 */
export function VendorPerformance({
  days,
  series,
  segments,
  earnings,
  rangeTabs,
}: {
  days: number;
  series: AdminSeries;
  segments: ShareSegment[];
  earnings: VendorEarningsSummary | null;
  rangeTabs: React.ReactNode;
}) {
  const dishes = earnings?.topDishes ?? [];
  const dishMax = Math.max(0, ...dishes.map((d) => d.revenue));
  const hours = earnings?.hourly ?? [];
  const hourMax = Math.max(0, ...hours.map((h) => h.orders));
  const recent = earnings?.recentOrders ?? [];

  return (
    <>
      <div className="hidden flex-wrap items-stretch gap-4 @3xl:flex">
        <div className="min-w-0 grow-[1.55] basis-[420px]">
          <ChartCard
            title="Sales and orders"
            subtitle={`${days} days · bars are orders, area is revenue`}
            height={196}
            action={
              <div className="flex flex-wrap items-center justify-end gap-3">
                {rangeTabs}
                <div className="flex gap-5 text-right">
                  <div>
                    <p className="text-[19px] font-bold leading-none tracking-[-0.02em] tabular-nums">
                      {formatINR(series.totals.gmv)}
                    </p>
                    <p className="mt-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">
                      Sales
                    </p>
                  </div>
                  <div>
                    <p className="text-[19px] font-bold leading-none tracking-[-0.02em] tabular-nums">
                      {nf.format(series.totals.orders)}
                    </p>
                    <p className="mt-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">
                      Orders
                    </p>
                  </div>
                </div>
              </div>
            }
          >
            <ConsoleOnly
              tool="The sales chart"
              why="The figures above already cover this window."
              notice={false}
            >
              {/* Revenue, with order volume behind it. This panel does not
                  offer the dashboard's metric switch: the two totals beside
                  the heading are this screen's whole question, and a third
                  control on a shop's report page would be one more thing to
                  read before getting to the shop. */}
              <TrendChart days={series.days} metric="revenue" />
            </ConsoleOnly>
          </ChartCard>
        </div>
        <div className="flex min-w-0 grow basis-[300px] flex-col gap-4">
          <Panel title="Order mix" subtitle={`${days} days`} className="flex-1">
            <ShareBar segments={segments} />
          </Panel>
          <Panel title="Top dishes" subtitle="Last 30 days">
            {dishes.length === 0 ? (
              <p className="py-4 text-center text-[13px] text-muted">
                No dishes sold in this window.
              </p>
            ) : (
              <ul>
                {dishes.slice(0, 5).map((d) => (
                  <li key={d.name} className="relative py-1.5">
                    <span
                      className="absolute inset-y-1 left-0 rounded bg-accent/10"
                      style={{
                        width: dishMax ? `${(d.revenue / dishMax) * 100}%` : 0,
                      }}
                    />
                    <div className="relative flex items-center gap-2 px-1.5">
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        {d.name}
                      </span>
                      <span className="text-data text-xs text-muted">
                        {d.qty}
                      </span>
                      <span className="text-data w-[4.5rem] text-right text-[13px] font-semibold">
                        {formatINR(d.revenue)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <div className="hidden gap-4 @3xl:grid @3xl:grid-cols-2">
        <Panel title="Recent orders" subtitle="Last 30 days">
          {recent.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted">
              No orders in this window.
            </p>
          ) : (
            <ul>
              {recent.slice(0, 6).map((o) => (
                <li key={o.id}>
                  <Link
                    href={`/admin/orders/${o.id}`}
                    className="press flex items-center justify-between gap-3 border-b border-line py-2 last:border-b-0"
                  >
                    <span className="min-w-0">
                      <span className="text-data block text-xs font-semibold">
                        {o.code}
                      </span>
                      <span className="block text-[11px] text-muted">
                        {o.placedLabel}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="text-data block text-[13px] font-semibold">
                        {formatINR(o.total)}
                      </span>
                      <span className="block text-[11px] capitalize text-muted">
                        {o.status.replace(/_/g, " ")}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel
          title="Busy hours"
          subtitle={
            earnings?.bestBucketLabel
              ? `Peak ${earnings.bestBucketLabel}`
              : "Last 30 days"
          }
        >
          {hourMax === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted">
              No hourly pattern yet.
            </p>
          ) : (
            <div className="flex h-28 items-end gap-px">
              {hours.map((h) => (
                <div
                  key={h.hour}
                  className="flex min-w-0 flex-1 flex-col items-center justify-end"
                  title={`${h.label}: ${h.orders} orders`}
                >
                  <div
                    className="w-full rounded-sm bg-accent/70"
                    style={{
                      height: `${Math.max(4, (h.orders / hourMax) * 100)}%`,
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
