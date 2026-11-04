"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Coins } from "lucide-react";
import { addWalletChangeAction } from "@/app/driver/actions";
import type { DriverPayment } from "@/lib/data-access/driver-orders";
import { formatINR } from "@/lib/utils/format";

/**
 * "No change? Add to wallet", at the door of a cash delivery. Optional, and it never
 * stands between the rider and Delivered. The rider types what they received and the
 * customer's code; the server works out the change.
 */
export function WalletChangePanel({
  orderId,
  payment,
}: Readonly<{ orderId: string; payment: DriverPayment }>) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [received, setReceived] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // One id per attempt that reached the server and might have worked, so a lost answer
  // retried is the same action, not a second one.
  const actionId = useRef(crypto.randomUUID());

  const state = payment.walletChange;
  if (state?.added) {
    return (
      <p className="rounded-xl bg-green-soft px-3 py-2.5 text-sm font-semibold text-green">
        {formatINR(state.added.change)} added to the customer&apos;s wallet. Hand over the full{" "}
        {formatINR(state.added.received)}.
      </p>
    );
  }
  if (!state?.allowed || payment.instruction !== "collect" || payment.collectAmount <= 0) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="press flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm font-semibold text-ink"
      >
        <Coins className="size-4" />
        No change? Add to wallet
      </button>
    );
  }

  const amount = Number(received);
  const valid = Number.isInteger(amount) && amount > 0;
  const change = valid ? amount - payment.collectAmount : 0;

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await addWalletChangeAction(orderId, {
          received: amount,
          code: code.trim(),
          actionId: actionId.current,
        });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        router.refresh();
      } catch {
        setError("Couldn't reach Deligro. Check your internet, or give the change in cash.");
      }
    });
  }

  return (
    <div className="space-y-3 rounded-2xl border border-line bg-surface-2 p-3.5">
      <p className="text-sm font-bold text-ink">Add the change to the customer&apos;s wallet</p>
      <label className="block text-xs font-semibold text-muted">
        Cash received
        <input
          inputMode="numeric"
          value={received}
          onChange={(e) => setReceived(e.target.value.replace(/\D/g, ""))}
          className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base font-semibold text-ink"
          placeholder={`More than ${payment.collectAmount}`}
        />
      </label>
      {valid && change > 0 ? (
        <p className="text-sm font-semibold text-ink">
          {formatINR(change)} goes to the wallet.
          {change > state.maxPerOrder ? ` That is over the ${formatINR(state.maxPerOrder)} limit.` : ""}
        </p>
      ) : null}
      <label className="block text-xs font-semibold text-muted">
        Customer&apos;s code
        <input
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base font-semibold tracking-[0.3em] text-ink"
          placeholder="6 digits"
        />
      </label>
      <p className="text-xs text-muted">The customer sees this code on their order screen.</p>
      {error ? (
        <p role="alert" className="rounded-xl bg-deal-soft px-3 py-2 text-sm font-semibold text-deal">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="press flex-1 rounded-xl border border-line px-3 py-2.5 text-sm font-semibold text-ink"
        >
          Close
        </button>
        <button
          type="button"
          disabled={pending || !valid || change <= 0 || code.trim().length !== 6}
          onClick={submit}
          className="press flex-1 rounded-xl bg-accent px-3 py-2.5 text-sm font-bold text-[var(--on-accent)] disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add to wallet"}
        </button>
      </div>
    </div>
  );
}
