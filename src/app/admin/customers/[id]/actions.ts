"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { setCustomerAccount } from "@/lib/data-access/manager-customers";

export type AccountActionResult = { ok: true } | { ok: false; error: string };

/**
 * Admin → suspend, restrict or reactivate a customer, with a reason — the
 * same audited function the Manager app uses (0162), the admin as the actor.
 */
export async function setCustomerAccountAction(
  id: string,
  expected: string,
  _prev: AccountActionResult | null,
  form: FormData
): Promise<AccountActionResult> {
  const admin = await requireRole("admin");
  if (!(await rateLimit(`admin-customer-account:${admin.id}`, 20, 60_000)).ok) {
    return { ok: false, error: "Too many changes — wait a minute." };
  }
  const action = String(form.get("action") ?? "");
  const reason = String(form.get("reason") ?? "").trim();
  if (action !== "suspend" && action !== "restrict" && action !== "reactivate") return { ok: false, error: "Pick an action." };
  if (reason.length < 3 || reason.length > 300) return { ok: false, error: "Give a reason (3–300 characters)." };
  const r = await setCustomerAccount({ id: admin.id, role: "admin" }, { all: true }, id, {
    action, expected, reason, clientActionId: randomUUID(),
  }).catch(() => ({ ok: false as const, status: 500 as const, error: "action_failed" }));
  if (!r.ok) {
    const why: Record<string, string> = {
      stale: "Someone changed this account a moment ago. Reload and try again.",
      not_found: "Not found.",
      invalid_transition: "The account is already in that state.",
      effect_failed: "Saved, but sign-in could not be blocked yet. Try again to finish it.",
    };
    return { ok: false, error: why[r.error] ?? "That didn't go through. Try again." };
  }
  revalidatePath(`/admin/customers/${id}`);
  return { ok: true };
}
