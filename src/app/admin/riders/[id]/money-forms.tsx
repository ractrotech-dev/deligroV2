"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field, fieldCls } from "@/components/ui/field";
import { Panel } from "@/components/admin/console";
import {
  ADJUSTMENT_KINDS,
  ADJUSTMENT_LABELS,
  DEFAULT_ADJUSTMENT_KIND,
  PAYOUT_METHODS,
  PAYOUT_METHOD_LABELS,
  formatDay,
  formatMoney,
  previewPayout,
  type ActionResult,
  type PendingItem,
} from "@/lib/rider/admin-money";
import type { AdjustmentKind } from "@/lib/rider/earnings-math";
import { addAdjustmentAction, payRiderAction } from "./money-actions";

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
  salary: "The rider's salary for the period. Enter a positive amount.",
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
  const [kind, setKind] = useState<AdjustmentKind>(DEFAULT_ADJUSTMENT_KIND);
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
        setKind(DEFAULT_ADJUSTMENT_KIND);
      }
    });
  }

  return (
    <Panel
      title="Add an entry"
      description="Salary, bonuses, deductions and corrections. Entries can't be edited afterwards - a mistake is fixed with another entry."
    >
      <form ref={ref} onSubmit={submit} className="space-y-3">
        <input type="hidden" name="driverId" value={driverId} />
        <div className="grid gap-3 grid-cols-2">
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
        <div className="grid gap-3 grid-cols-2">
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
  mayPayNow,
  waiting,
}: Readonly<{
  driverId: string;
  today: string;
  pending: PendingItem[];
  /** The one-admin rule is on: this admin finishes the payment here, in one step. */
  mayPayNow: boolean;
  /** A payment already waiting for this rider. One at a time. */
  waiting: { amount: number; askedBy: string } | null;
}>) {
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
      const r = await payRiderAction({ ok: false }, data);
      setResult(r);
      if (r.ok) {
        ref.current?.reset();
        setPeriodEnd(today);
        setPaidOn(today);
      }
    });
  }

  if (waiting) {
    return (
      <Panel title="Pay this rider" description="This records the payment; it doesn't send money.">
        <Outcome result={result} />
        <p className="mt-2 text-[13px] text-ink">
          {formatMoney(waiting.amount)} is waiting, asked for by {waiting.askedBy}.{" "}
          <Link href="/admin/riders/payments" className="font-semibold text-accent-ink hover:underline">
            Open Rider payments
          </Link>
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Pay this rider"
      description={
        mayPayNow
          ? "Send the money from your bank or UPI app, then record it here."
          : "Asks for this payment. Someone else approves it on Rider payments, once they have sent the money."
      }
    >
      <form ref={ref} onSubmit={submit} className="space-y-3">
        <input type="hidden" name="driverId" value={driverId} />
        <input type="hidden" name="previewAmount" value={preview.amount} />
        <div className="grid gap-3 grid-cols-2">
          <Field label="Pay everything up to">
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
          {mayPayNow ? (
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
          ) : (
            <input type="hidden" name="paidOn" value={paidOn} />
          )}
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
            ? `This comes to ${formatMoney(preview.amount)} (${preview.items} ${preview.items === 1 ? "item" : "items"} up to ${formatDay(periodEnd)}).`
            : preview.items === 0
              ? `Nothing to pay up to ${formatDay(periodEnd)}.`
              : `Nothing to pay: the ${preview.items} ${preview.items === 1 ? "item" : "items"} up to ${formatDay(periodEnd)} come to ${formatMoney(preview.amount)}.`}
        </p>

        <div className="grid gap-3 grid-cols-2">
          <Field label="How">
            <select name="method" defaultValue="upi" className={fieldCls}>
              {PAYOUT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYOUT_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </Field>
          {mayPayNow ? (
            <Field label="Payment reference" hint="From your bank or UPI app. For cash, a receipt number.">
              <input name="reference" maxLength={80} required autoComplete="off" className={`${fieldCls} text-data`} />
            </Field>
          ) : null}
        </div>
        <Field label={mayPayNow ? "Reason for paying" : "Note (optional)"} hint={mayPayNow ? "Saved with your name on the record." : undefined}>
          <input
            name="note"
            maxLength={300}
            required={mayPayNow}
            minLength={mayPayNow ? 3 : undefined}
            placeholder={mayPayNow ? "For example, October salary" : undefined}
            autoComplete="off"
            className={fieldCls}
          />
        </Field>

        <Outcome result={result} />
        <Button type="submit" size="sm" disabled={busy || !preview.payable}>
          {busy
            ? "Saving..."
            : !mayPayNow
              ? "Send for approval"
              : preview.payable
                ? `I have paid ${formatMoney(preview.amount)}`
                : "I have paid"}
        </Button>
        <p className="text-[11.5px] leading-snug text-muted">
          The amount is worked out again when you submit, and the confirmation shows what was recorded.
        </p>
      </form>
    </Panel>
  );
}
