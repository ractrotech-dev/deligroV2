import { AdminHero, Panel } from "@/components/admin/admin-ui";
import { Ago, NotMigratedNotice, StatusPill } from "@/components/admin/obs-ui";
import { getPipelineHealth } from "@/lib/obs/metrics";
import { HealthLine } from "@/components/admin/obs-ui";
import { listAlertFirings, listAlertRules } from "@/lib/obs/read";
import {
  acknowledgeFiring,
  setAlertEnabled,
  setAlertThreshold,
} from "../actions";

/**
 * Observability → Alerts.
 *
 * Three things on this page are deliberate and each is the answer to a way
 * alerting normally fails:
 *
 *   1. **Rules ship disabled.** A threshold nobody has checked against a real
 *      baseline fires in week one, gets muted in week two, and is ignored on the
 *      day it is right. The first week is for watching; enabling is a decision.
 *   2. **Every rule has a sample floor.** "Payment failure rate above 10%"
 *      firing on one failure out of three at 4am is how an alert channel becomes
 *      noise. Below the floor a rule cannot fire — and the console says
 *      "insufficient data", never "healthy".
 *   3. **Evaluation is monitored.** An alerting system that stops silently is
 *      worse than none: the console goes green and stays green. The pipeline
 *      panel at the foot of this page is the alert about the alerts.
 *
 * Delivery is in-app only for now — a badge and this page. Nobody is woken up.
 * That is a recorded scope decision (docs/OBSERVABILITY_PLAN.md §12, Q5), not an
 * oversight, and `obs_alert_firings` already stores everything a sender would
 * need when that changes.
 */
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-IN");

export default async function AlertsPage() {
  const [rules, firings, pipeline] = await Promise.all([
    listAlertRules(),
    listAlertFirings(false, 25),
    getPipelineHealth("production"),
  ]);

  const enabled = rules.data.filter((r) => r.enabled).length;
  const active = firings.data.filter((f) => !f.resolvedAt);

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="Alerts"
        subtitle="Thresholds, and what has crossed them. Evaluated on a schedule against the rollups, not on a request."
        tag={`${enabled} of ${rules.data.length} enabled`}
      />

      {rules.notMigrated ? <NotMigratedNotice /> : null}

      {enabled === 0 && rules.data.length > 0 ? (
        <p className="rounded-xl border border-pop/40 bg-pop/10 px-3.5 py-2.5 text-[13px] font-medium text-ink">
          <strong>No rule is enabled</strong>, so nothing can fire. That is the
          shipped state on purpose — the thresholds below are starting points, not
          measurements. Watch a week of real traffic, adjust them against what you
          see, then switch on the ones you trust.
        </p>
      ) : null}

      {active.length ? (
        <Panel title="Firing now">
          <ul className="flex flex-col gap-2">
            {active.map((f) => (
              <li
                key={f.id}
                className="rounded-lg border border-deal/30 bg-deal-soft px-3 py-2"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[13px] font-semibold text-ink">
                    {f.ruleName}
                  </span>
                  <Ago iso={f.firedAt} />
                </div>
                <p className="mt-0.5 text-[12px] text-muted">{f.message}</p>
                <p className="mt-1 text-[11px] text-muted">
                  Observed {f.observed} against a threshold of {f.threshold}, over{" "}
                  {nf.format(f.sampleCount)} samples.
                </p>
                {f.acknowledgedAt ? (
                  <p className="mt-1 text-[11px] italic text-muted">Acknowledged.</p>
                ) : (
                  <form action={acknowledgeFiring} className="mt-2">
                    <input type="hidden" name="id" value={f.id} />
                    <button
                      type="submit"
                      className="press rounded border border-line px-2 py-1 text-[11px] font-semibold text-ink"
                    >
                      Acknowledge
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel
        title="Rules"
        subtitle="A rule cannot fire below its sample floor — that is what stops a rate rule firing on a handful of overnight requests."
      >
        {rules.data.length === 0 ? (
          <p className="py-2 text-[13px] text-muted">
            No rules. Migration 0046 seeds eight; if none are here, it has not been
            applied.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rules.data.map((rule) => (
              <li
                key={rule.id}
                className="rounded-lg border border-line bg-surface px-3 py-2.5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[13.5px] font-semibold text-ink">
                    {rule.name}
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusPill status={rule.enabled ? "open" : "ignored"} />
                    <form action={setAlertEnabled}>
                      <input type="hidden" name="id" value={rule.id} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={rule.enabled ? "false" : "true"}
                      />
                      <button
                        type="submit"
                        className="press rounded border border-line px-2 py-1 text-[11px] font-semibold text-ink"
                      >
                        {rule.enabled ? "Disable" : "Enable"}
                      </button>
                    </form>
                  </span>
                </div>
                {rule.description ? (
                  <p className="mt-1 text-[12px] text-muted">{rule.description}</p>
                ) : null}
                <p className="text-data mt-1.5 text-[11.5px] text-muted">
                  {rule.metric}
                  {rule.key ? ` · ${rule.key}` : ""} {rule.comparator}{" "}
                  {rule.threshold} over {rule.windowMin} min, min{" "}
                  {rule.minSamples} samples, {rule.cooldownMin} min cooldown
                </p>

                <form
                  action={setAlertThreshold}
                  className="mt-2 flex flex-wrap items-end gap-2"
                >
                  <input type="hidden" name="id" value={rule.id} />
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted">
                      Threshold
                    </span>
                    <input
                      name="threshold"
                      type="number"
                      step="any"
                      defaultValue={rule.threshold}
                      className="text-data h-8 w-[92px] rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted">
                      Window (min)
                    </span>
                    <input
                      name="windowMin"
                      type="number"
                      min={1}
                      max={1440}
                      defaultValue={rule.windowMin}
                      className="text-data h-8 w-[92px] rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted">
                      Min samples
                    </span>
                    <input
                      name="minSamples"
                      type="number"
                      min={1}
                      defaultValue={rule.minSamples}
                      className="text-data h-8 w-[92px] rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink"
                    />
                  </label>
                  <button
                    type="submit"
                    className="press h-8 rounded-lg border border-line px-3 text-[11.5px] font-semibold text-ink"
                  >
                    Save
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Whether evaluation is even running, beside what it last did.
          Both are short lists; stacked, they left a wide console mostly
          empty. */}
      <div className="flex flex-col gap-4 @5xl:flex-row">
        <Panel
          className="min-w-0 flex-1"
          title="The pipeline itself"
          subtitle="If evaluation stops, nothing fires and everything looks fine. This is how you find out."
        >
          <ul className="-mt-1">
            {pipeline.map((row) => (
              <HealthLine key={row.label} {...row} />
            ))}
          </ul>
        </Panel>

        {firings.data.length > active.length ? (
          <Panel className="min-w-0 flex-1" title="Recently fired">
            <ul className="flex flex-col">
              {firings.data
                .filter((f) => f.resolvedAt)
                .map((f) => (
                  <li
                    key={f.id}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line/60 py-2 last:border-0"
                  >
                    <span className="text-[13px] font-medium text-ink">
                      {f.ruleName}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                      {f.message}
                    </span>
                    <Ago iso={f.firedAt} />
                  </li>
                ))}
            </ul>
          </Panel>
        ) : null}
      </div>

    </div>
  );
}
