"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field, fieldCls } from "@/components/ui/field";
import { Panel } from "@/components/admin/console";
import {
  ADJUSTMENT_KINDS,
  ADJUSTMENT_LABELS,
  PAYOUT_METHODS,
  PAYOUT_METHOD_LABELS,
  formatDay,
  formatMoney,
  previewPayout,
  type ActionResult,
  type PendingItem,
} from "@/lib/rider/admin-money";
import type { AdjustmentKind } from "@/lib/rider/earnings-math";
import { addAdjustmentAction, recordPayoutAction } from "./money-actions";

/**
 * The Money tab's two forms.
 *
 * Submitted from an event handler rather than `<form action>`, on purpose: a
 * form action resets every uncontrolled field when it finishes, error or not,
 * so a refused payout would wipe the reference the operator had just typed.
 * Here a refusal leaves the form exactly as it was, and a success clears it.
 */

const HINT: Record<AdjustmentKind, string> = {
  bonus: "Added to what the rider is owed. Enter a positive amount.",
  adjustment: "Plus or minus, never zero. Use a minus to take money away.",
  deduction: "Enter a positive amount - it is subtracted from what the rider is owed.",
  salary: "Salary owed to the rider. Enter a positive amount.",
};

function Outcome({ result }: Readonly<{ result: ActionResult | null }>) {
  if (!result) return null;
  return result.ok ? (
    <p role="status" className="rounded-lg border border-green/30 bg-green-soft px-3 py-2 text-[12.5px] font-medium text-green">
      {result.message ?? "Saved."}
    </p>
  ) : (
    <p role="alert" className="rounded-lg border border-deal/30 bg-deal-soft px-3 py-2 text-[12.5px] font-medium text-deal">
      {result.error ?? "That didn't save."}
    </p>
  );
}

// ---------------------------------------------------------------------------

export function AdjustmentForm({
  driverId,
  today,
  orderCodes,
}: Readonly<{ driverId: string; today: string; orderCodes: string[] }>) {
  const [kind, setKind] = useState<AdjustmentKind>("bonus");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, start] = useTransition();
  const ref = useRef<HTMLFormElement>(null);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    start(async () => {
      const r = await addAdjustmentAction({ ok: false }, data);
      setResult(r);
      if (r.ok) {
        ref.current?.reset();
        setKind("bonus");
      }
    });
  }

  return (
    <Panel
      title="Add an entry"
      description="Bonuses, deductions, salary and corrections. Entries can't be edited afterwards - a mistake is fixed with another entry."
    >
      <form ref={ref} onSubmit={submit} className="space-y-3">
        <input type="hidden" name="driverId" value={driverId} />
        <div className="grid gap-3 @lg:grid-cols-2">
          <Field label="Type">
            <select
              name="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as AdjustmentKind)}
              className={fieldCls}
            >
              {ADJUSTMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ADJUSTMENT_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount (₹)" hint={HINT[kind]}>
            <input
              name="amount"
              type="number"
              inputMode="decimal"
              step="0.01"
              required
              className={`${fieldCls} text-data tabular-nums`}
              placeholder={kind === "adjustment" ? "-50 or 50" : "250"}
            />
          </Field>
        </div>
        <Field label="Reason" hint="The rider can read this in their app.">
          <textarea name="reason" rows={2} maxLength={300} required className={fieldCls} />
        </Field>
        <div className="grid gap-3 @lg:grid-cols-2">
          <Field label="Belongs to date" hint="Counted in a payout once its period reaches this day.">
            <input name="effectiveOn" type="date" defaultValue={today} max={today} required className={fieldCls} />
          </Field>
          <Field label="Order (optional)" hint="One of this rider's orders, e.g. for a deduction.">
            <input name="orderCode" list={`orders-${driverId}`} placeholder="#A1B2C3D4" autoComplete="off" className={`${fieldCls} text-data`} />
            <datalist id={`orders-${driverId}`}>
              {orderCodes.map((c) => (
                <option key={c} value={`#${c}`} />
              ))}
            </datalist>
          </Field>
        </div>
        <Outcome result={result} />
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving..." : "Add entry"}
        </Button>
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

export function PayoutForm({
  driverId,
  today,
  pending,
}: Readonly<{ driverId: string; today: string; pending: PendingItem[] }>) {
  const [periodEnd, setPeriodEnd] = useState(today);
  const [paidOn, setPaidOn] = useState(today);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, start] = useTransition();
  const ref = useRef<HTMLFormElement>(null);

  const preview = previewPayout(pending, periodEnd);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    start(async () => {
      const r = await recordPayoutAction({ ok: false }, data);
      setResult(r);
      if (r.ok) {
        ref.current?.reset();
        setPeriodEnd(today);
        setPaidOn(today);
      }
    });
  }

  return (
    <Panel
      title="Record a payout"
      description="Settles what the rider is owed up to a date, after you have paid them. This records the payment; it doesn't send money."
    >
      <form ref={ref} onSubmit={submit} className="space-y-3">
        <input type="hidden" name="driverId" value={driverId} />
        <input type="hidden" name="previewAmount" value={preview.amount} />
        <div className="grid gap-3 @lg:grid-cols-2">
          <Field label="Settle everything up to">
            <input
              name="periodEnd"
              type="date"
              value={periodEnd}
              max={today}
              required
              onChange={(e) => {
                setPeriodEnd(e.target.value);
                if (e.target.value && paidOn < e.target.value) setPaidOn(e.target.value);
              }}
              className={fieldCls}
            />
          </Field>
          <Field label="Paid on">
            <input
              name="paidOn"
              type="date"
              value={paidOn}
              min={periodEnd || undefined}
              max={today}
              required
              onChange={(e) => setPaidOn(e.target.value)}
              className={fieldCls}
            />
          </Field>
        </div>

        <p
          aria-live="polite"
          className={
            preview.payable
              ? "rounded-lg bg-surface-2 px-3 py-2 text-[13px] font-semibold text-ink"
              : "rounded-lg bg-surface-2 px-3 py-2 text-[13px] font-medium text-muted"
          }
        >
          {preview.payable
            ? `This will settle ${formatMoney(preview.amount)} (${preview.items} ${preview.items === 1 ? "item" : "items"} up to ${formatDay(periodEnd)}).`
            : preview.items === 0
              ? `Nothing to pay up to ${formatDay(periodEnd)}.`
              : `Nothing to pay: the ${preview.items} ${preview.items === 1 ? "item" : "items"} up to ${formatDay(periodEnd)} net ${formatMoney(preview.amount)}.`}
        </p>

        <div className="grid gap-3 @lg:grid-cols-2">
          <Field label="How was it paid">
            <select name="method" defaultValue="upi" className={fieldCls}>
              {PAYOUT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYOUT_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reference (optional)" hint="UTR, UPI id or receipt number.">
            <input name="reference" maxLength={120} autoComplete="off" className={`${fieldCls} text-data`} />
          </Field>
        </div>
        <Field label="Note (optional)">
          <input name="note" maxLength={300} autoComplete="off" className={fieldCls} />
        </Field>

        <Outcome result={result} />
        <Button type="submit" size="sm" disabled={busy || !preview.payable}>
          {busy ? "Recording..." : preview.payable ? `Record payout of ${formatMoney(preview.amount)}` : "Record payout"}
        </Button>
        <p className="text-[11.5px] leading-snug text-muted">
          The amount shown is a preview. The payout is worked out when you submit, and the confirmation shows what was
          actually recorded.
        </p>
      </form>
    </Panel>
  );
}
