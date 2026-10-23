/**
 * The decisions at the edge of customer account status (0151's columns, set by 0162's
 * audited RPC), kept pure so they are tested directly. The server half is
 * account-status.server.ts.
 */

export type LoginRefusal = "account_suspended" | "unavailable" | null;

/**
 * What a profile read means for a sign-in. A read that failed refuses
 * ("unavailable"): a sign-in must never get through because the check could not be
 * made (AGENTS.md rule 2). No profile yet is a new number, not a refusal. Only a
 * suspended customer is refused as such; a restricted one signs in (the orders
 * trigger stops them ordering), and staff are never refused here.
 */
export function refusalFromProfileRead(read: {
  data: { role: string; account_status?: string | null } | null;
  error: unknown;
}): LoginRefusal {
  if (read.error) return "unavailable";
  const p = read.data;
  if (!p) return null;
  return p.role === "customer" && p.account_status === "suspended" ? "account_suspended" : null;
}

export type AccountAction = "suspend" | "restrict" | "reactivate";

const STATUS_OF: Record<AccountAction, string> = { suspend: "suspended", restrict: "restricted", reactivate: "active" };

/** The account is already in the state this action asks for: only the Auth ban is left to apply. */
export function alreadyThere(action: AccountAction, current: string | null): boolean {
  return current === STATUS_OF[action];
}
