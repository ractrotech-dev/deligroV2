import { AdminHero, Panel } from "@/components/admin/admin-ui";
import { FilterChips } from "@/components/admin/admin-filters";
import {
  Figure,
  FigureStrip,
  HealthLine,
  MetricTable,
  NotMigratedNotice,
} from "@/components/admin/obs-ui";
import { getMetricRows } from "@/lib/obs/metrics";
import { OBS_RANGES, type ObsRange } from "@/lib/obs/read";
import { isPushConfigured } from "@/lib/notifications/onesignal";
import { smsConfigured } from "@/lib/sms/renflair";

/**
 * Observability → Notifications.
 *
 * The half of the platform that used to be completely invisible. `sendPush`
 * returned `false` on any failure and `pushToPlayer` discarded even that, so
 * "customers stopped being told their order was on its way" produced no signal
 * at all — not a log line, not a counter, nothing.
 *
 * What this page does NOT show, because it cannot: delivery. OneSignal accepting
 * a notification is not a handset displaying one, and Renflair accepting an SMS
 * is not a phone receiving one. Both would need a webhook back from the provider
 * that this platform does not have. "Accepted" is the honest word, and the page
 * uses it.
 */
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-IN");

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const sp = await searchParams;
  const range = OBS_RANGES.some((r) => r.value === sp.range)
    ? (sp.range as ObsRange)
    : "24h";

  const providers = await getMetricRows("provider", range);
  const push = providers.rows.find((r) => r.key === "onesignal");
  const sms = providers.rows.find((r) => r.key === "renflair");
  const notify = providers.rows.filter((r) =>
    ["onesignal", "renflair"].includes(r.key)
  );

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="Notifications"
        subtitle="Push and SMS, by whether the provider accepted them. Delivery to a handset is not observable from here."
        tag={OBS_RANGES.find((r) => r.value === range)?.label}
      />

      {providers.unavailable ? <NotMigratedNotice /> : null}

      <FilterChips
        label="Window"
        options={OBS_RANGES.map((r) => ({ value: r.value, label: r.label }))}
        active={range}
        hrefFor={(v) => `/admin/observability/notifications${v ? `?range=${v}` : ""}`}
      />

      <FigureStrip>
        <Figure
          label="Push attempted"
          value={push ? nf.format(push.count) : "—"}
          note={isPushConfigured ? "OneSignal" : "OneSignal not configured"}
        />
        <Figure
          label="Push rejected"
          value={push ? nf.format(push.errorCount) : "—"}
          note={push ? `${push.errorRate.toFixed(1)}% of attempts` : "nothing recorded"}
          tone={push && push.errorRate >= 10 ? "bad" : undefined}
        />
        <Figure
          label="OTP SMS attempted"
          value={sms ? nf.format(sms.count) : "—"}
          note={smsConfigured ? "Renflair" : "Renflair not configured — dev mode"}
        />
        <Figure
          label="OTP SMS rejected"
          value={sms ? nf.format(sms.errorCount) : "—"}
          note={sms ? `${sms.errorRate.toFixed(1)}% of attempts` : "nothing recorded"}
          tone={sms && sms.errorCount > 0 ? "bad" : undefined}
        />
      </FigureStrip>

      {sms && sms.errorCount > 0 ? (
        <p className="rounded-xl border border-deal/40 bg-deal-soft px-3.5 py-2.5 text-[13px] font-medium text-ink">
          {nf.format(sms.errorCount)} OTP messages were rejected in this window.
          Every one of those is a customer who could not sign in — this is the
          only way into the app for a customer account.
        </p>
      ) : null}

      {/* What was attempted, next to what cannot be known. The caveats are
          the reading instructions for the table, not a footnote. */}
      <div className="flex flex-col gap-4 @6xl:flex-row">
        <Panel className="min-w-0 flex-1" title="By provider">
          <MetricTable
            rows={notify}
            keyHeader="Provider"
            hrefFor={(key) =>
              `/admin/observability/logs?provider=${key}&range=${range}&level=warn`
            }
            emptyNote={
              providers.unavailable
                ? "Observability is not installed on this database."
                : "No notification attempts recorded in this window."
            }
          />
        </Panel>

        <Panel className="min-w-0 flex-1" title="What this page cannot tell you">
          <ul className="-mt-1">
            <HealthLine
              label="Handset delivery"
              state="unknown"
              detail="Not observable"
              note="OneSignal accepting a notification is not a phone showing one. Confirming that would need a delivery webhook this platform does not receive."
            />
            <HealthLine
              label="SMS delivery"
              state="unknown"
              detail="Not observable"
              note="Renflair returns an accept/reject on the send. Whether the message arrived is between the operator and the network."
            />
            <HealthLine
              label="Customers with no push subscription"
              state="unknown"
              detail="Counted as skipped, not failed"
              note="A customer who never granted notification permission has no player id, so nothing is attempted — correctly, and invisibly."
            />
          </ul>
        </Panel>
      </div>

    </div>
  );
}
