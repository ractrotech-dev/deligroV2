import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { refusalFromProfileRead, type AccountAction, type LoginRefusal } from "@/lib/auth/account-status";

/**
 * Customer account status (0151's columns, set by 0162's audited RPC) where it
 * meets sign-in:
 *
 *   restricted — can sign in, cannot order (the orders trigger refuses).
 *   suspended  — cannot sign in either: OTP and password sign-in refuse before
 *                a session is issued, and Supabase Auth bans the user so a
 *                refresh token stops working too.
 *
 * Staff accounts are never refused here — only role 'customer'.
 */

/**
 * "account_suspended" when this customer may not sign in; "unavailable" when the status
 * could not be read — the sign-in is refused, never waved through (AGENTS.md rule 2);
 * otherwise null.
 */
export async function customerLoginRefusal(who: { userId?: string; phone?: string }): Promise<LoginRefusal> {
  if (!who.userId && !who.phone) return null;
  let q = createAdminClient().from("profiles").select("role, account_status");
  q = who.userId ? q.eq("id", who.userId) : q.eq("phone", who.phone!);
  const { data, error } = await q.limit(1).maybeSingle();
  return refusalFromProfileRead({ data: (data as { role: string; account_status?: string | null } | null) ?? null, error });
}

/** The account status as saved, or null when there is no such profile or it cannot be read. */
export async function currentCustomerStatus(userId: string): Promise<string | null> {
  const { data, error } = await createAdminClient().from("profiles").select("account_status").eq("id", userId).maybeSingle();
  return error || !data ? null : ((data as { account_status?: string | null }).account_status ?? null);
}

/**
 * After the status RPC has committed: ban a suspended customer in Supabase Auth
 * (no new sessions, no token refresh), lift it otherwise, and end a suspended
 * customer's live sessions (0162's ops_revoke_customer_sessions) so a token already
 * issued stops working now rather than at expiry. Throws if the ban fails so the
 * route can answer 502 effect_failed — the status is already saved, and a retry
 * (same clientActionId, or a new one: the status then reads as already there)
 * re-applies only this step. Ending sessions is a second layer on top of the ban:
 * if the database refuses it, the ban still holds and access tokens lapse at expiry.
 */
export async function applyAuthBan(userId: string, action: AccountAction, actorId: string): Promise<{ sessionsEnded: boolean }> {
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: action === "suspend" ? "876000h" : "none",
  });
  if (error) throw error;
  if (action !== "suspend") return { sessionsEnded: false };
  const { error: endError } = await admin.rpc("ops_revoke_customer_sessions", { p_actor: actorId, p_customer: userId });
  return { sessionsEnded: !endError };
}
