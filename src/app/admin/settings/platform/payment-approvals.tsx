"use client";

import { useState, useTransition } from "react";
import { Section } from "@/components/admin/console";
import { setSingleAdminPaymentsAction } from "./payment-approvals-actions";

/**
 * One-admin payments (0152 section 5). Every payment out of Deligro needs two
 * people: one requests it, a different one approves it with the transaction
 * reference. A business with a single admin can switch that off for admins
 * only — never for managers — and each self-approval then needs a reason and
 * is marked "Self-approved by admin" on the request and in the audit log.
 */
export function PaymentApprovals({ enabled }: Readonly<{ enabled: boolean | null }>) {
  const [on, setOn] = useState(enabled === true);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (enabled === null) {
    return (
      <Section title="Payment approvals" description="Apply migration 0152 to manage this.">
        <p className="text-sm text-muted">Two people approve every payment.</p>
      </Section>
    );
  }

  const next = !on;
  const submit = () => {
    setError(null);
    start(async () => {
      const r = await setSingleAdminPaymentsAction({ enabled: next, reason });
      if (!r.ok) {
        setError(r.error ?? "Couldn't save. Try again.");
        return;
      }
      setOn(next);
      setReason("");
    });
  };

  return (
    <Section
      title="Payment approvals"
      description="Every rider payout and vendor settlement is requested by one person and approved by a different one, with the transaction reference."
    >
      <div className="admin-measure space-y-3">
        <p className="text-sm text-ink">
          One-admin payments are <strong>{on ? "on" : "off"}</strong>.{" "}
          {on
            ? "An admin may approve their own payment request, with a reason. Managers still need a second person."
            : "Nobody can approve a payment they requested — admins included."}
        </p>
        <p className="text-xs text-muted">
          Turn this on only if there is no second person to approve. Each self-approval is marked
          &ldquo;Self-approved by admin&rdquo; on the request and in the audit log.
        </p>
        <label className="block text-sm">
          <span className="text-label">Reason for turning it {next ? "on" : "off"}</span>
          <input
            className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-ink"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            placeholder={next ? "Only one admin this month" : "A second admin has joined"}
          />
        </label>
        {error ? (
          <p role="alert" className="rounded-xl border border-deal/30 bg-deal-soft px-3.5 py-3 text-sm font-semibold text-deal">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          disabled={pending || reason.trim().length < 3}
          onClick={submit}
          className="press rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
        >
          {pending ? "Saving…" : next ? "Turn on one-admin payments" : "Turn off one-admin payments"}
        </button>
      </div>
    </Section>
  );
}
