"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field, fieldCls } from "@/components/ui/field";
import { Panel } from "@/components/admin/console";
import { formatDay, type ActionResult } from "@/lib/rider/admin-money";
import type { IncentiveRule } from "@/lib/rider/earnings-math";
import { saveIncentiveRuleAction, toggleIncentiveRuleAction } from "./actions";

/**
 * The incentive rules page's two interactive pieces: the on/off switch in a
 * row, and the create/edit form. Both call server actions from an event
 * handler (not `<form action>`) so a refusal leaves the form as typed.
 */

export function RuleToggle({ id, active }: Readonly<{ id: string; active: boolean }>) {
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          start(async () => {
            const r = await toggleIncentiveRuleAction(id, !active);
            setError(r.ok ? null : (r.error ?? "That didn't save."));
          })
        }
        className={active ? "c-btn-deny press" : "c-btn-affirm press"}
      >
        {busy ? "Saving..." : active ? "Switch off" : "Switch on"}
      </button>
      {error ? (
        <span role="alert" className="max-w-[220px] text-right text-[11px] leading-snug text-deal">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function RuleForm({ rule, today }: Readonly<{ rule?: IncentiveRule; today: string }>) {
  const editing = Boolean(rule);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, start] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    start(async () => {
      // Success redirects to the list, so a result only ever comes back as a refusal.
      setResult(await saveIncentiveRuleAction({ ok: false }, data));
    });
  }

  return (
    <Panel
      title={editing ? "Edit rule" : "New rule"}
      description="Riders see the name and the target in their app. A rule pays once per rider per day or week, when the target is reached."
    >
      <form onSubmit={submit} className="space-y-3">
        {rule ? <input type="hidden" name="id" value={rule.id} /> : null}

        <Field label="Name" hint="English only. For example: Ten a day, or Lunch rush.">
          <input name="name" defaultValue={rule?.name} maxLength={80} required className={fieldCls} />
        </Field>

        {rule ? (
          <div className="space-y-1 rounded-lg bg-surface-2 px-3 py-2.5">
            <p className="text-[12.5px] text-ink">
              <span className="font-semibold">Counted per:</span> {rule.period === "daily" ? "day" : "week (from Monday)"}
              <span className="px-2 text-muted" aria-hidden="true">
                |
              </span>
              <span className="font-semibold">First day:</span> {formatDay(rule.startsOn)}
            </p>
            <p className="text-[11.5px] leading-snug text-muted">
              To change the period or start date, switch this rule off and create a new one.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 @lg:grid-cols-2">
            <Field label="Counted per">
              <select name="period" defaultValue="daily" className={fieldCls}>
                <option value="daily">Day</option>
                <option value="weekly">Week (from Monday)</option>
              </select>
            </Field>
            <Field label="First day in force" hint="Fixed once the rule exists.">
              <input name="startsOn" type="date" defaultValue={today} required className={fieldCls} />
            </Field>
          </div>
        )}

        <div className="grid gap-3 @lg:grid-cols-2">
          <Field label="Target (deliveries)" hint="Deliveries needed in the period.">
            <input
              name="targetDeliveries"
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              step={1}
              defaultValue={rule?.targetDeliveries}
              required
              className={`${fieldCls} text-data tabular-nums`}
            />
          </Field>
          <Field label="Bonus (₹)" hint="Paid once when the target is reached.">
            <input
              name="bonusAmount"
              type="number"
              inputMode="decimal"
              min={0.01}
              step="0.01"
              defaultValue={rule?.bonusAmount}
              required
              className={`${fieldCls} text-data tabular-nums`}
            />
          </Field>
        </div>

        <div className="grid gap-3 @lg:grid-cols-2">
          <Field label="Window starts (optional)" hint="Only deliveries inside the window count (IST).">
            <input name="windowStart" type="time" defaultValue={rule?.windowStart?.slice(0, 5) ?? ""} className={fieldCls} />
          </Field>
          <Field label="Window ends" hint="Leave both empty for all day.">
            <input name="windowEnd" type="time" defaultValue={rule?.windowEnd?.slice(0, 5) ?? ""} className={fieldCls} />
          </Field>
        </div>

        <Field label="Last day (optional)" hint="Leave empty to keep the rule running.">
          <input name="endsOn" type="date" defaultValue={rule?.endsOn ?? ""} className={fieldCls} />
        </Field>

        <label className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
          <input name="active" type="checkbox" defaultChecked={rule ? rule.active : true} className="size-4 accent-[var(--accent)]" />{" "}
          Active - riders can earn it
        </label>

        {result && !result.ok ? (
          <p role="alert" className="rounded-lg border border-deal/30 bg-deal-soft px-3 py-2 text-[12.5px] font-medium text-deal">
            {result.error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Saving..." : editing ? "Save changes" : "Create rule"}
          </Button>
          <Link href="/admin/riders/incentives" className="c-btn c-btn-outline press">
            Cancel
          </Link>
        </div>
      </form>
    </Panel>
  );
}
