"use client";

import { useState, useTransition } from "react";
import { Section } from "@/components/admin/console";
import { setSingleAdminPaymentsAction } from "./payment-approvals-actions";

/**
 * One-admin payments (0152 section 5, on by default since 0186: the owner alone
 * approves payments). An admin may approve their own payment; never a manager.
 * Each self-approval needs a reason and is marked "Self-approved by admin" on the
 * request and in the audit log. Turned off, every payment needs two people.
 */
export function PaymentApprovals({ enabled }: Readonly<{ enabled: boolean | null }>) {
  const [on, setOn] = useState(enabled === true);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (enabled === null) {
    return (
      <Section title="Payment approvals">
        <p className="text-sm text-muted">Payment approvals aren&apos;t set up on this database yet.</p>
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
      description="Who can finish a payment to a shop or rider."
    >
      <div className="admin-measure space-y-3">
        <p className="text-sm text-ink">
          One-admin payments are <strong>{on ? "on" : "off"}</strong>.{" "}
          {on
            ? "An admin can pay on their own, with a reason. Managers still need someone else to approve."
            : "Every payment needs two people, admins included."}
        </p>
        <p className="text-xs text-muted">
          Each payment an admin approves alone records who did it and why.
        </p>
        <label className="block text-sm">
          <span className="text-label">Reason for turning it {next ? "on" : "off"}</span>
          <input
            className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-ink"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            placeholder={next ? "The owner approves payments" : "A second approver has joined"}
          />
        </label>
        {error ? (
          <p role="alert" className="rounded-[var(--c-r)] border border-deal/30 bg-deal-soft px-3.5 py-3 text-sm font-semibold text-deal">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          disabled={pending || reason.trim().length < 3}
          onClick={submit}
          className="rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
        >
          {pending ? "Saving…" : next ? "Turn on one-admin payments" : "Turn off one-admin payments"}
        </button>
      </div>
    </Section>
  );
}
