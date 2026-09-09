import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { AdminHero, EmptyState, Panel } from "@/components/admin/admin-ui";
import { FilterChips } from "@/components/admin/admin-filters";
import {
  Figure,
  FigureStrip,
  MetricTable,
  NotMigratedNotice,
} from "@/components/admin/obs-ui";
import { getMetricRows, getOrderHealth, type StuckOrder } from "@/lib/obs/metrics";
import { OBS_RANGES, type ObsRange } from "@/lib/obs/read";

/**
 * Observability → Orders. Where a bug becomes a customer waiting.
 *
 * The stuck-order tables are read from `orders` directly, using the lifecycle
 * timestamps migration 0026 added. Those are stamped by a database TRIGGER, not
 * by the app, so they are correct whichever path moved the order — the vendor
 * board, the cancel route, a manager, an admin override — and cannot be forged
 * by whoever happens to hold the row.
 *
 * That makes this the most trustworthy signal in the whole system, and it
 * needed no new instrumentation at all: the data was already there and nothing
 * was reading it.
 *
 * The thresholds are deliberately generous. A kitchen taking 40 minutes on a
 * Friday night is busy, not broken, and a page that flags busy is a page that
 * gets ignored before it ever flags broken.
 */
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-IN");

export default async function OrdersHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const sp = await searchParams;
  const range = OBS_RANGES.some((r) => r.value === sp.range)
    ? (sp.range as ObsRange)
    : "24h";

  const [health, domain] = await Promise.all([
    getOrderHealth(range),
    getMetricRows("domain", range),
  ]);

  const created = domain.rows.find((r) => r.key === "order.created");
  const refused = domain.rows.find((r) => r.key === "order.refused");
  const totalStuck =
    health.awaitingAcceptance.length +
    health.stuckInKitchen.length +
    health.readyNoRider.length;

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="Orders"
        subtitle="Orders that have stopped moving, read from the lifecycle timestamps the database stamps itself."
        tag={totalStuck > 0 ? `${totalStuck} not moving` : "Nothing stuck"}
      />

      {health.unavailable ? <NotMigratedNotice /> : null}

      <FilterChips
        label="Window"
        options={OBS_RANGES.map((r) => ({ value: r.value, label: r.label }))}
        active={range}
        hrefFor={(v) => `/admin/observability/orders${v ? `?range=${v}` : ""}`}
      />

      <FigureStrip>
        <Figure
          label="Orders created"
          value={nf.format(health.created)}
          note="Counted from the orders table, not sampled"
        />
        <Figure
          label="Creation failures"
          value={created ? nf.format(created.errorCount) : "—"}
          note={created ? `${created.errorRate.toFixed(1)}% of attempts` : "nothing recorded"}
          tone={created && created.errorCount > 0 ? "bad" : undefined}
        />
        <Figure
          label="Refused"
          value={refused ? nf.format(refused.count) : "—"}
          note="Closed shop, cash ceiling, out of area — the platform working"
        />
        <Figure
          label="Cancelled"
          value={nf.format(health.cancelled)}
          note="By either party"
        />
        <Figure
          label="Not moving now"
          value={nf.format(totalStuck)}
          note="Live orders past their stage threshold"
          tone={totalStuck > 0 ? "bad" : "good"}
        />
      </FigureStrip>

      {/* The three stuck queues, which during an incident are read together
          rather than scrolled through one at a time. Three columns only once
          the console is genuinely wide; the phone frame never sees this. */}
      <div className="grid gap-4 @5xl:grid-cols-3">
        <StuckPanel
          title="Awaiting acceptance"
          subtitle="Placed, and the kitchen has not accepted. Threshold: 10 minutes."
          why="The customer is watching a tracker that says nothing has happened. Either the vendor's board is not open, their alert sound is not working, or the shop is closed and still marked open."
          orders={health.awaitingAcceptance}
        />

        <StuckPanel
          title="Stuck in the kitchen"
          subtitle="Accepted, not yet marked ready. Threshold: 60 minutes."
          why="Usually a vendor who forgot to press Ready rather than food still cooking. Worth a phone call before the customer makes one."
          orders={health.stuckInKitchen}
        />

        <StuckPanel
          title="Ready, no rider"
          subtitle="Packed and waiting. Threshold: 20 minutes."
          why="Food going cold on the pass. Check the Delivery tab: if riders are online and nothing is assigned, dispatch is the problem, not the fleet."
          orders={health.readyNoRider}
        />
      </div>

      <Panel
        title="Order checkpoints"
        subtitle="The named events behind these numbers."
      >
        <MetricTable
          rows={domain.rows.filter((r) => r.key.startsWith("order."))}
          keyHeader="Checkpoint"
          hrefFor={(key) =>
            `/admin/observability/logs?kind=domain&range=${range}&q=${encodeURIComponent(key)}`
          }
          emptyNote="No order events recorded in this window."
        />
      </Panel>
    </div>
  );
}

function StuckPanel({
  title,
  subtitle,
  why,
  orders,
}: {
  title: string;
  subtitle: string;
  why: string;
  orders: StuckOrder[];
}) {
  return (
    <Panel title={title} subtitle={subtitle}>
      {orders.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="Nothing here"
          description="No live orders are past this threshold."
        />
      ) : (
        <>
          <p className="mb-3 rounded-lg border border-pop/30 bg-[var(--c-tint-amber)] px-3 py-2 text-[12.5px] text-ink">
            {why}
          </p>
          <ul className="flex flex-col">
            {orders.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/admin/orders/${o.id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 py-2 last:border-0 hover:bg-[var(--line)]/20"
                >
                  <span className="text-data w-[86px] shrink-0 text-[12px] font-semibold text-ink">
                    {o.id.slice(0, 8).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                    {o.restaurantName ?? "Unknown restaurant"}
                  </span>
                  {o.paymentStatus ? (
                    <span className="text-data shrink-0 text-[11.5px] text-muted">
                      {o.paymentStatus}
                    </span>
                  ) : null}
                  <span className="text-data shrink-0 text-[12px] font-semibold tabular-nums text-[color:var(--c-ink-amber)]">
                    {o.stuckMinutes} min
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
