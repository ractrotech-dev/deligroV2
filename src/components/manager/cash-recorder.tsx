"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, fieldCls, Section } from "@/components/ui/field";
import { cn } from "@/lib/utils/cn";
import type { ManagerRider } from "@/lib/data-access/manager-orders";
import {
  EXPENSE_CATEGORY_LABEL,
  EXPENSE_PAYMENT_METHOD_LABEL,
  type CashHandoverLeg,
  type ExpenseCategory,
  type ExpensePaymentMethod,
} from "@/lib/cash-ledger-types";
import { recordExpenseAction, recordHandoverAction } from "@/app/manager/cash/actions";

const EXPENSE_CATEGORIES = Object.keys(EXPENSE_CATEGORY_LABEL) as ExpenseCategory[];
const PAYMENT_METHODS = Object.keys(
  EXPENSE_PAYMENT_METHOD_LABEL
) as ExpensePaymentMethod[];

/**
 * Two small forms: a cash handover leg, and an operational expense. Both post
 * straight to a server action and reset on success — there is no draft state
 * worth keeping, and a cleared form is the clearest sign the entry saved.
 */
export interface ZoneChoice {
  id: string;
  label: string;
}

/**
 * Each record belongs to a zone (migration 0141). With one zone there is
 * nothing to ask; with several the manager picks, and the server refuses a
 * record without one rather than guessing.
 */
export function CashRecorder({
  riders,
  zones,
}: Readonly<{ riders: ManagerRider[]; zones: ZoneChoice[] }>) {
  const [zoneId, setZoneId] = useState("");
  return (
    <div className="space-y-4">
      {zones.length > 1 ? (
        <Field label="Zone" hint="Which zone this cash or spend belongs to.">
          <select
            value={zoneId}
            onChange={(e) => setZoneId(e.target.value)}
            className={cn(fieldCls, "appearance-none")}
          >
            <option value="">Choose a zone</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <HandoverForm riders={riders} zoneId={zoneId || null} />
      <ExpenseForm riders={riders} zoneId={zoneId || null} />
    </div>
  );
}

function HandoverForm({
  riders,
  zoneId,
}: Readonly<{ riders: ManagerRider[]; zoneId: string | null }>) {
  const [leg, setLeg] = useState<CashHandoverLeg>("rider_to_manager");
  const [riderId, setRiderId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = () => {
    const value = Number(amount);
    if (!Number.isInteger(value) || value <= 0) {
      setError("Enter a valid amount in whole rupees.");
      return;
    }
    setError(null);
    setSaved(false);
    start(async () => {
      const result = await recordHandoverAction({
        leg,
        fromUserId: leg === "rider_to_manager" ? riderId || null : null,
        toUserId: null,
        amount: value,
        note: note.trim() || undefined,
        zoneId,
      });
      if (!result.ok) {
        setError(result.error ?? "That didn't save. Try again.");
        return;
      }
      setAmount("");
      setNote("");
      setRiderId("");
      setSaved(true);
    });
  };

  return (
    <Section
      title="Record a handover"
      description="The cash can change hands offline. Write down that it did."
    >
      <div className="flex gap-2">
        <LegButton
          active={leg === "rider_to_manager"}
          onClick={() => setLeg("rider_to_manager")}
        >
          Rider → me
        </LegButton>
        <LegButton
          active={leg === "manager_to_owner"}
          onClick={() => setLeg("manager_to_owner")}
        >
          Me → owner
        </LegButton>
      </div>

      {leg === "rider_to_manager" ? (
        <Field label="Rider" hint="Optional, if you know who handed it over.">
          <select
            value={riderId}
            onChange={(e) => setRiderId(e.target.value)}
            className={cn(fieldCls, "appearance-none")}
          >
            <option value="">Not specified</option>
            {riders.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <Field label="Amount (₹)" required>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          className={fieldCls}
        />
      </Field>

      <Field label="Note" hint="Optional.">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. end of shift"
          className={fieldCls}
        />
      </Field>

      {error ? <p className="text-xs font-medium text-deal">{error}</p> : null}
      {saved && !error ? (
        <p className="flex items-center gap-1.5 text-xs font-medium text-accent">
          <Check className="size-3.5" /> Saved
        </p>
      ) : null}

      <Button type="button" onClick={submit} disabled={pending} className="w-full">
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Record handover
      </Button>
    </Section>
  );
}

function ExpenseForm({
  riders,
  zoneId,
}: Readonly<{ riders: ManagerRider[]; zoneId: string | null }>) {
  const [category, setCategory] = useState<ExpenseCategory>("ev_bike_maintenance");
  const [riderId, setRiderId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<ExpensePaymentMethod>(
    "offline_cash"
  );
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = () => {
    const value = Number(amount);
    if (!Number.isInteger(value) || value <= 0) {
      setError("Enter a valid amount in whole rupees.");
      return;
    }
    setError(null);
    setSaved(false);
    start(async () => {
      const result = await recordExpenseAction({
        category,
        amount: value,
        riderId: riderId || null,
        paymentMethod,
        note: note.trim() || undefined,
        zoneId,
      });
      if (!result.ok) {
        setError(result.error ?? "That didn't save. Try again.");
        return;
      }
      setAmount("");
      setNote("");
      setSaved(true);
    });
  };

  return (
    <Section
      title="Record an expense"
      description="EV bike costs, rider salary, or any other small spend. Not a payment, just the record."
    >
      <Field label="What was it for" required>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
          className={cn(fieldCls, "appearance-none")}
        >
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {EXPENSE_CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Rider" hint="Only if this expense is tied to one rider.">
        <select
          value={riderId}
          onChange={(e) => setRiderId(e.target.value)}
          className={cn(fieldCls, "appearance-none")}
        >
          <option value="">Not rider-specific</option>
          {riders.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Amount (₹)" required>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          className={fieldCls}
        />
      </Field>

      <Field label="How it was paid" required>
        <select
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value as ExpensePaymentMethod)}
          className={cn(fieldCls, "appearance-none")}
        >
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {EXPENSE_PAYMENT_METHOD_LABEL[m]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Note" hint="Optional.">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. battery swap, Sharma Motors"
          className={fieldCls}
        />
      </Field>

      {error ? <p className="text-xs font-medium text-deal">{error}</p> : null}
      {saved && !error ? (
        <p className="flex items-center gap-1.5 text-xs font-medium text-accent">
          <Check className="size-3.5" /> Saved
        </p>
      ) : null}

      <Button type="button" onClick={submit} disabled={pending} className="w-full">
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Record expense
      </Button>
    </Section>
  );
}

function LegButton({
  active,
  onClick,
  children,
}: Readonly<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "press flex-1 rounded-xl border px-3 py-2.5 text-sm font-semibold",
        active
          ? "border-accent bg-accent/12 text-accent"
          : "border-line bg-surface-2 text-muted"
      )}
    >
      {children}
    </button>
  );
}
