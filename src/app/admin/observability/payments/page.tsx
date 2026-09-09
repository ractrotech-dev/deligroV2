import Link from "next/link";
import { AdminHero, Panel } from "@/components/admin/admin-ui";
import { FilterChips } from "@/components/admin/admin-filters";
import {
  Figure,
  FigureStrip,
  MetricTable,
  NotMigratedNotice,
} from "@/components/admin/obs-ui";
import { getMetricRows, getPaymentHealth } from "@/lib/obs/metrics";
import { OBS_RANGES, type ObsRange } from "@/lib/obs/read";
import { isRazorpayConfigured } from "@/lib/payments/razorpay";

/**
 * Observability → Payments.
 *
 * The page exists to answer one question quickly, because it is the first
 * question of every payment incident and answering it wrongly costs an
 * afternoon: **is this Razorpay or is it us?**
 *
 * Those are two different measurements and they are kept apart on purpose:
 *
 *   * **Their side** — the provider error rate, from `obs_events`: how many
 *     calls to Razorpay failed or timed out.
 *   * **Our side** — the reconciliation, from `payments` joined to `orders`:
 *     how many payments Razorpay says are paid that this platform never
 *     recorded against an order.
 *
 * The second is the one that matters most and the one that survives longest. It
 * is derived from the money rather than from a log, so it outlives the 14-day
 * telemetry window entirely — and every row in it is a customer who has been
 * charged and is looking at an order that says unpaid.
 */
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-IN");

export default async function PaymentsHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const sp = await searchParams;
  const range = OBS_RANGES.some((r) => r.value === sp.range)
    ? (sp.range as ObsRange)
    : "24h";

  const [health, providers, domain] = await Promise.all([
    getPaymentHealth(range),
    getMetricRows("provider", range),
    getMetricRows("domain", range),
  ]);

  const razorpay = providers.rows.find((r) => r.key === "razorpay");
  const paymentEvents = domain.rows.filter((r) => r.key.startsWith("payment."));

  // The verdict line. Both sides have to be known before one is offered — a
  // guess here sends somebody to the wrong dashboard for an hour.
  const theirs = razorpay ? razorpay.errorRate >= 15 : false;
  const ours = health.orphaned > 0;

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="Payments"
        subtitle="Money taken, money recorded, and which side of the boundary a failure is on."
        tag={
          health.notMigrated
            ? "Payments not migrated"
            : isRazorpayConfigured
              ? OBS_RANGES.find((r) => r.value === range)?.label
              : "Razorpay not configured"
        }
      />

      {health.unavailable ? <NotMigratedNotice /> : null}

      {health.notMigrated ? (
        <p className="rounded-xl border border-pop/40 bg-pop/10 px-3.5 py-2.5 text-[13px] font-medium text-ink">
          The payments table does not exist on this database — migration{" "}
          <code className="text-data">0025_payments_razorpay.sql</code> has not
          been applied. Online payment is refused rather than silently downgraded
          to cash, so this is an outage of a feature, not a data gap.
        </p>
      ) : null}

      <FilterChips
        label="Window"
        options={OBS_RANGES.map((r) => ({ value: r.value, label: r.label }))}
        active={range}
        hrefFor={(v) => `/admin/observability/payments${v ? `?range=${v}` : ""}`}
      />

      {/* ---------- the verdict ---------- */}
      <div
        className={
          ours
            ? "rounded-xl border border-deal/40 bg-deal-soft px-4 py-3.5"
            : theirs
              ? "rounded-xl border border-pop/40 bg-[var(--c-tint-amber)] px-4 py-3.5"
              : "rounded-xl border border-line bg-surface px-4 py-3.5"
        }
      >
        <p className="text-[13.5px] font-semibold text-ink">
          {ours
            ? "Deligro problem — money taken, order not updated"
            : theirs
              ? "Looks like a Razorpay problem"
              : "No payment problem detected on either side"}
        </p>
        <p className="mt-1 text-[12.5px] text-muted">
          {ours ? (
            <>
              {nf.format(health.orphaned)} payment
              {health.orphaned === 1 ? " is" : "s are"} marked paid at the provider
              while the order still reads unpaid. Every one of those is a customer
              who has been charged. This is the{" "}
              <code className="text-data">payment.settle</code> failure seen from
              the money&rsquo;s side.
            </>
          ) : theirs ? (
            <>
              {razorpay?.errorRate.toFixed(1)}% of calls to Razorpay failed in this
              window, and nothing is unreconciled on our side. Check their status
              page before changing anything here.
            </>
          ) : (
            <>
              Razorpay is answering normally and every payment recorded as paid has
              a matching order. Reconciliation is computed from the payments table,
              so it holds beyond the telemetry window.
            </>
          )}
        </p>
      </div>

      <FigureStrip>
        <Figure
          label="Success rate"
          value={
            health.successRate === null ? "—" : `${health.successRate.toFixed(1)}%`
          }
          note={
            health.successRate === null
              ? "No attempts in this window"
              : `${nf.format(health.paid)} of ${nf.format(health.attempts)} attempts`
          }
          tone={
            health.successRate !== null && health.successRate < 90 ? "bad" : "good"
          }
        />
        <Figure label="Failed" value={nf.format(health.failed)} note="Declined or errored" />
        <Figure
          label="Pending"
          value={nf.format(health.pending)}
          note="Created or authorised, not captured"
        />
        <Figure label="Refunded" value={nf.format(health.refunded)} note="In this window" />
        <Figure
          label="Unreconciled"
          value={nf.format(health.orphaned)}
          note="Paid at provider, unpaid on the order"
          tone={health.orphaned > 0 ? "bad" : "good"}
        />
      </FigureStrip>

      {/* Their failures beside ours: the whole point of this screen is
          telling the two apart, which is easier when they are adjacent. */}
      <div className="flex flex-col gap-4 @6xl:flex-row">
        <Panel
          className="min-w-0 flex-1"
          title="Razorpay, as we saw it"
          subtitle="Calls out to the provider. Their failures, not ours."
        >
          <MetricTable
            rows={razorpay ? [razorpay] : []}
            keyHeader="Provider"
            hrefFor={() =>
              `/admin/observability/logs?provider=razorpay&range=${range}&level=warn`
            }
            emptyNote={
              isRazorpayConfigured
                ? "No calls to Razorpay recorded in this window."
                : "Razorpay is not configured on this deployment, so nothing is attempted."
            }
          />
        </Panel>

        <Panel
          className="min-w-0 flex-1"
          title="Our payment path"
          subtitle="The checkpoints inside Deligro. A failure here is ours whatever Razorpay is doing."
        >
          <MetricTable
            rows={paymentEvents}
            keyHeader="Checkpoint"
            hrefFor={(key) =>
              `/admin/observability/logs?kind=domain&range=${range}&q=${encodeURIComponent(key)}`
            }
            emptyNote="No payment checkpoints recorded in this window."
          />
          <p className="mt-3 text-[11px] italic text-muted">
            <code className="text-data">payment.webhook</code> failures are usually a
            rotated <code className="text-data">RAZORPAY_WEBHOOK_SECRET</code> rather
            than forgery — but both mean real payments are being rejected, so treat
            either as urgent.{" "}
            <Link
              href="/admin/refunds"
              className="underline underline-offset-2"
            >
              Refund queue
            </Link>
          </p>
        </Panel>
      </div>

    </div>
  );
}
