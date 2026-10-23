import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

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

/** "account_suspended" when this customer may not sign in, else null. A failed read refuses nothing. */
export async function customerLoginRefusal(who: { userId?: string; phone?: string }): Promise<"account_suspended" | null> {
  if (!who.userId && !who.phone) return null;
  let q = createAdminClient().from("profiles").select("role, account_status");
  q = who.userId ? q.eq("id", who.userId) : q.eq("phone", who.phone!);
  const { data, error } = await q.limit(1).maybeSingle();
  if (error || !data) return null;
  const p = data as { role: string; account_status?: string | null };
  return p.role === "customer" && p.account_status === "suspended" ? "account_suspended" : null;
}

/**
 * After the status RPC has committed: ban a suspended customer in Supabase
 * Auth (no new sessions, no token refresh), lift it otherwise. Throws on
 * failure so the route can answer 502 effect_failed — the status is already
 * saved and a retry (same clientActionId) re-applies only this step.
 */
export async function applyAuthBan(userId: string, action: "suspend" | "restrict" | "reactivate"): Promise<void> {
  const { error } = await createAdminClient().auth.admin.updateUserById(userId, {
    ban_duration: action === "suspend" ? "876000h" : "none",
  });
  if (error) throw error;
}
