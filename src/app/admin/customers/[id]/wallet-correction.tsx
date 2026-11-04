"use client";

import { useActionState } from "react";
import { correctWalletAction, type WalletCorrectionResult } from "./actions";

/**
 * Correct a customer's balance. A written reason is required, and it is kept on the
 * ledger row and in the audit log. `actionId` is fresh on every render of the page, so a
 * double click or a retried request applies once.
 */
export function WalletCorrection({ id, actionId }: Readonly<{ id: string; actionId: string }>) {
  const [state, act, pending] = useActionState<WalletCorrectionResult | null, FormData>(
    correctWalletAction.bind(null, id),
    null
  );
  return (
    <form action={act} className="space-y-2 text-sm">
      <input type="hidden" name="actionId" value={actionId} />
      <div className="flex flex-wrap items-center gap-2">
        <label className="font-semibold text-ink" htmlFor="wallet-delta">
          Correct the balance
        </label>
        <input
          id="wallet-delta"
          name="delta"
          className="c-field w-[120px]"
          inputMode="numeric"
          placeholder="50 or -50"
          required
        />
      </div>
      <input
        name="reason"
        className="c-field c-field-wide"
        placeholder="Reason (required, kept on the ledger and in the audit log)"
        minLength={5}
        maxLength={500}
        required
      />
      <button type="submit" className="c-btn c-btn-dark" disabled={pending}>
        {pending ? "Saving…" : "Save correction"}
      </button>
      {state && !state.ok ? <p role="alert" className="text-deal">{state.error}</p> : null}
      {state?.ok ? <p className="text-muted">Saved. The balance is now ₹{state.balance}.</p> : null}
    </form>
  );
}
