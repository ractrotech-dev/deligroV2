"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field, fieldCls } from "@/components/ui/field";
import { Panel } from "@/components/admin/console";
import {
  DEFAULT_ADJUSTMENT_KIND,
  PAYOUT_METHODS,
  PAYOUT_METHOD_LABELS,
  RECORD_KIND_LABEL,
  formatDay,
  formatMoney,
  payoutItems,
  previewPayout,
  type ActionResult,
  type PendingItem,
} from "@/lib/rider/admin-money";
import { addAdjustmentAction, payRiderAction } from "./money-actions";

/**
 * The Salary tab's two steps: add what the rider is owed, then pay it.
 *
 * Submitted from an event handler rather than `<form action>`, on purpose: a
 * form action resets every uncontrolled field when it finishes, error or not,
 * so a refused payment would wipe the reference the operator had just typed.
 * Here a refusal leaves the form exactly as it was, and a success clears it.
 *
 * The fields under "More options" still submit while closed, so their defaults
 * (today) are what is sent unless someone opens them and changes them.
 */

const moreCls = "cursor-pointer text-[12.5px] font-semibold text-accent-ink";

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
}: Readonly<{ driverId: string; today: string }>) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, start] = useTransition();
  const ref = useRef<HTMLFormElement>(null);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    start(async () => {
      const r = await addAdjustmentAction({ ok: false }, data);
      setResult(r);
      if (r.ok) ref.current?.reset();
    });
  }

  return (
    <Panel title="1. Add salary" description="This adds to To pay. No money moves yet.">
      <form ref={ref} onSubmit={submit} className="space-y-3">
        <input type="hidden" name="driverId" value={driverId} />
        <input type="hidden" name="kind" value={DEFAULT_ADJUSTMENT_KIND} />
        <div className="grid gap-3 grid-cols-2">
          <Field label="Amount (₹)">
            <input
              name="amount"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              required
              className={`${fieldCls} text-data tabular-nums`}
              placeholder="15000"
            />
          </Field>
          <Field label="What is it for?" hint="The rider can read this in their app.">
            <input name="reason" maxLength={300} required autoComplete="off" placeholder="October salary" className={fieldCls} />
          </Field>
        </div>
        <details>
          <summary className={moreCls}>More options</summary>
          <div className="mt-3 grid gap-3 grid-cols-2">
            <Field label="Date" hint="Only matters when paying up to an earlier date.">
              <input name="effectiveOn" type="date" defaultValue={today} max={today} required className={fieldCls} />
            </Field>
          </div>
        </details>
        <Outcome result={result} />
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving..." : "Add salary"}
        </Button>
        <p className="text-[11.5px] leading-snug text-muted">Check the amount first. A saved salary can&apos;t be edited or removed.</p>
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

/** How many lines of what a payment is made of to list before summing up the rest. */
const LINES_SHOWN = 5;

export type PayItem = PendingItem & { note: string | null };

function Breakdown({ items, total }: Readonly<{ items: PayItem[]; total: number }>) {
  const shown = items.slice(0, LINES_SHOWN);
  const more = items.length - shown.length;
  return (
    <ul className="divide-y divide-line rounded-lg bg-surface-2 px-3 text-[13px]">
      {shown.map((r) => (
        <li key={`${r.kind}:${r.id}`} className="flex items-baseline justify-between gap-3 py-2">
          <span className="min-w-0 truncate">
            <span className="font-medium">{RECORD_KIND_LABEL[r.kind]}</span>
            {r.note ? <span className="text-muted"> · {r.note}</span> : null}
          </span>
          <span className={`text-data shrink-0 tabular-nums ${r.amount < 0 ? "text-deal" : ""}`}>{formatMoney(r.amount)}</span>
        </li>
      ))}
      {more > 0 ? <li className="py-2 text-muted">and {more} more</li> : null}
      <li className="flex items-baseline justify-between gap-3 py-2 font-semibold">
        <span>Total to pay</span>
        <span className="text-data tabular-nums">{formatMoney(total)}</span>
      </li>
    </ul>
  );
}

export function PayoutForm({
  driverId,
  today,
  pending,
  mayPayNow,
  waiting,
}: Readonly<{
  driverId: string;
  today: string;
  pending: PayItem[];
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
  const items = payoutItems(pending, periodEnd);
  // Nothing owed on any date: step 1 is the only thing to do, so show nothing else.
  const nothingOwed = payoutItems(pending, today).length === 0;
  const title = "2. Pay the rider";

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
      <Panel title={title} description="This records the payment; it doesn't send money.">
        <Outcome result={result} />
        <p className="mt-2 text-[13px] text-ink">
          {formatMoney(waiting.amount)} is waiting for approval, asked for by {waiting.askedBy}.{" "}
          <Link href="/admin/riders/payments" className="font-semibold text-accent-ink hover:underline">
            Open Rider salaries
          </Link>
        </p>
      </Panel>
    );
  }

  if (nothingOwed) {
    return (
      <Panel title={title} description="This records the payment; it doesn't send money.">
        <Outcome result={result} />
        <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px] font-medium text-muted">
          Nothing to pay yet. Add the salary in step 1 first.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title={title}
      description={
        mayPayNow
          ? "Send the money from your bank or UPI app first, then record it here."
          : "Someone else sends the money and approves it on Rider salaries."
      }
    >
      <form ref={ref} onSubmit={submit} className="space-y-3">
        <input type="hidden" name="driverId" value={driverId} />
        <input type="hidden" name="previewAmount" value={preview.amount} />

        {items.length > 0 ? (
          <Breakdown items={items} total={preview.amount} />
        ) : (
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] font-medium text-muted">Nothing to pay up to {formatDay(periodEnd)}.</p>
        )}
        {items.length > 0 && !preview.payable ? (
          <p aria-live="polite" className="text-[12.5px] text-muted">
            Deductions are more than the salary, so there is nothing to pay.
          </p>
        ) : null}

        <div className="grid gap-3 grid-cols-2">
          <Field label={mayPayNow ? "How was it paid?" : "How will it be paid?"}>
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
        <Field label={mayPayNow ? "What is it for?" : "Note for the approver (optional)"}>
          <input
            name="note"
            maxLength={300}
            required={mayPayNow}
            minLength={mayPayNow ? 3 : undefined}
            placeholder={mayPayNow ? "October salary" : undefined}
            autoComplete="off"
            className={fieldCls}
          />
        </Field>

        <details>
          <summary className={moreCls}>More options</summary>
          <div className="mt-3 grid gap-3 grid-cols-2">
            <Field label="Pay only up to" hint="Leave as today to pay everything owed.">
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
        </details>

        <Outcome result={result} />
        <Button type="submit" size="sm" disabled={busy || !preview.payable}>
          {busy
            ? "Saving..."
            : !preview.payable
              ? mayPayNow
                ? "I have paid"
                : "Send for approval"
              : mayPayNow
                ? `I have paid ${formatMoney(preview.amount)}`
                : `Send ${formatMoney(preview.amount)} for approval`}
        </Button>
      </form>
    </Panel>
  );
}
