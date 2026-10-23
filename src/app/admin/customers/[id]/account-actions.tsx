"use client";

import { useActionState } from "react";
import { setCustomerAccountAction, type AccountActionResult } from "./actions";

/**
 * Suspend (cannot sign in or order), restrict (can sign in, cannot order) or
 * reactivate — always with a reason, which the audit log keeps.
 */
export function AccountActions({
  id,
  status,
}: Readonly<{ id: string; status: "active" | "restricted" | "suspended" }>) {
  const [state, act, pending] = useActionState<AccountActionResult | null, FormData>(
    setCustomerAccountAction.bind(null, id, status),
    null
  );
  const options = (["suspend", "restrict", "reactivate"] as const).filter((a) =>
    a === "suspend" ? status !== "suspended" : a === "restrict" ? status !== "restricted" : status !== "active"
  );
  return (
    <form action={act} className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label className="font-semibold text-ink" htmlFor="account-action">
          Change account
        </label>
        <select id="account-action" name="action" className="c-field" defaultValue={options[0]}>
          {options.map((o) => (
            <option key={o} value={o}>
              {o === "suspend" ? "Suspend (no sign-in, no orders)" : o === "restrict" ? "Restrict (no orders)" : "Reactivate"}
            </option>
          ))}
        </select>
      </div>
      <input name="reason" className="c-field c-field-wide" placeholder="Reason (kept in the audit log)" minLength={3} maxLength={300} required />
      <button type="submit" className="c-btn c-btn-dark press" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>
      {state && !state.ok ? <p className="text-muted">{state.error}</p> : null}
      {state?.ok ? <p className="text-muted">Saved.</p> : null}
    </form>
  );
}
