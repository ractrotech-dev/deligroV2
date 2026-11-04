"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { setCustomerAccount } from "@/lib/data-access/manager-customers";
import { correctWallet } from "@/lib/data-access/wallet";
import { checkCorrection, correctionMessage } from "@/lib/wallet/money";

export type AccountActionResult = { ok: true } | { ok: false; error: string };

export type WalletCorrectionResult = { ok: true; balance: number } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Admin → correct a customer's wallet balance, with a written reason. Only an admin can
 * (rule book): the database checks the actor too, and writes the ledger row and the
 * audit row with the balance change, in one transaction.
 */
export async function correctWalletAction(
  id: string,
  _prev: WalletCorrectionResult | null,
  form: FormData
): Promise<WalletCorrectionResult> {
  const admin = await requireRole("admin");
  if (!(await rateLimit(`admin-wallet-correct:${admin.id}`, 20, 60_000)).ok) {
    return { ok: false, error: "Too many changes. Wait a minute." };
  }
  if (!UUID.test(id)) return { ok: false, error: "That customer isn't there any more." };
  const checked = checkCorrection(form.get("delta"), form.get("reason"));
  if (!checked.ok) return checked;
  const actionId = String(form.get("actionId") ?? "");
  const r = await correctWallet(
    admin.id,
    id,
    checked.delta,
    checked.reason,
    UUID.test(actionId) ? actionId : randomUUID()
  ).catch(() => ({ ok: false as const, error: "server_error" }));
  if (!r.ok) return { ok: false, error: correctionMessage(r.error) };
  revalidatePath(`/admin/customers/${id}`);
  revalidatePath("/admin/customer-wallets");
  return { ok: true, balance: r.balance };
}

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
