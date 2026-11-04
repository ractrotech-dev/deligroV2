"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { formString } from "@/lib/utils/form-data";
import {
  createSettlementDraft,
  markOrderUnpaid,
  voidSettlement,
} from "@/lib/data-access/admin-settlements";
import {
  adminMarkOrderPaid,
  adminMarkPaymentUnpaid,
  adminMarkShopPaid,
  adminPayOrRequestSettlement,
  adminRequestOrderPayout,
  approveSettlementReversal,
  requestSettlementReversal,
} from "@/lib/data-access/settlement-requests";

export type SettlementActionResult =
  | { ok: true; id?: string; requested?: boolean; reversalRequested?: boolean }
  | { ok: false; error: string; movedTo?: string };

export async function createSettlementAction(
  formData: FormData
): Promise<SettlementActionResult> {
  const admin = await requireRole("admin");
  const restaurantId = formString(formData, "restaurantId");
  const fromDate = formString(formData, "fromDate");
  const toDate = formString(formData, "toDate");
  const notes = formString(formData, "notes").trim() || null;

  const result = await createSettlementDraft({
    restaurantId,
    fromDate,
    toDate,
    adminId: admin.id,
    notes,
  });
  if ("error" in result) return { ok: false, error: result.error };

  revalidatePath("/admin/settlements");
  revalidatePath(`/admin/settlements/${result.id}`);
  return { ok: true, id: result.id };
}

export type MarkPaidResult =
  | { ok: true; paid: number; requested: number; failed: { id: string; error: string }[] }
  | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SHOPS = 20;
const MAX_ORDERS = 50;

/**
 * Record money already sent by hand, for each id in turn. The reference and reason
 * are what make it a record rather than a tick, so nothing starts without them.
 * One failure does not stop the rest; each is reported against its own id.
 */
async function markEachPaid(
  ids: string[],
  max: number,
  noun: string,
  paymentRef: string,
  note: string,
  adminId: string,
  mark: (id: string, input: { adminId: string; paymentRef: string; note: string }) => Promise<
    { ok: true; requested: boolean } | { error: string }
  >
): Promise<MarkPaidResult> {
  const limit = await rateLimit(`admin-settlement-mark:${adminId}`, 20, 60_000);
  if (!limit.ok) return { ok: false, error: "Too many payments in a minute. Wait a moment and try again." };

  const ref = paymentRef.trim();
  const why = note.trim();
  if (!ref) return { ok: false, error: "Enter the payment reference. For cash, write Cash." };
  if (why.length < 3) return { ok: false, error: "Write a short reason for this payment." };
  const unique = [...new Set(ids)];
  if (!unique.length || !unique.every((id) => UUID.test(id))) return { ok: false, error: `Choose a ${noun} first.` };
  if (unique.length > max) return { ok: false, error: `Mark up to ${max} at a time.` };

  let paid = 0;
  let requested = 0;
  const failed: { id: string; error: string }[] = [];
  for (const id of unique) {
    try {
      const res = await mark(id, { adminId, paymentRef: ref, note: why });
      if ("error" in res) failed.push({ id, error: res.error });
      else if (res.requested) requested += 1;
      else paid += 1;
    } catch {
      failed.push({ id, error: "That didn't go through. Try again." });
    }
  }

  revalidatePath("/admin/settlements");
  revalidatePath("/admin/settlements/orders");
  return { ok: true, paid, requested, failed };
}

/** "Mark as paid" on shops: for each, one payment covering everything it is owed. */
export async function markShopsPaidAction(
  restaurantIds: string[],
  paymentRef: string,
  note: string
): Promise<MarkPaidResult> {
  const admin = await requireRole("admin");
  return markEachPaid(restaurantIds, MAX_SHOPS, "shop", paymentRef, note, admin.id, (restaurantId, input) =>
    adminMarkShopPaid({ restaurantId, ...input })
  );
}

/** "Mark as paid" on orders: each becomes its own payment, so each can be undone alone. */
export async function markOrdersPaidAction(
  orderIds: string[],
  paymentRef: string,
  note: string
): Promise<MarkPaidResult> {
  const admin = await requireRole("admin");
  return markEachPaid(orderIds, MAX_ORDERS, "order", paymentRef, note, admin.id, (orderId, input) =>
    adminMarkOrderPaid({ orderId, ...input })
  );
}

/** "Mark as unpaid" on a paid payment: a reversal, with the reason on record. */
export async function markPaymentUnpaidAction(
  id: string,
  reason: string
): Promise<{ ok: true; waiting: boolean } | { ok: false; error: string }> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`admin-settlement-mark:${admin.id}`, 20, 60_000);
  if (!limit.ok) return { ok: false, error: "Too many payments in a minute. Wait a moment and try again." };
  const why = reason.trim();
  if (!UUID.test(id)) return { ok: false, error: "Payment not found." };
  if (why.length < 3) return { ok: false, error: "Say why this should be unpaid." };

  const result = await adminMarkPaymentUnpaid({ settlementId: id, adminId: admin.id, reason: why });
  if ("error" in result) return { ok: false, error: result.error };

  revalidatePath("/admin/settlements");
  revalidatePath("/admin/settlements/orders");
  revalidatePath(`/admin/settlements/${id}`);
  return { ok: true, waiting: result.waiting };
}

/**
 * "I have paid" on an unfinished payment: approved here with the reference, which
 * marks it paid, and with a reason when it is the admin's own (one-admin rule,
 * 0152). With that rule off, an unrequested payment is put up for approval instead.
 */
export async function markSettlementPaidAction(
  formData: FormData
): Promise<SettlementActionResult> {
  const admin = await requireRole("admin");
  const id = formString(formData, "id");
  const paymentRef = formString(formData, "paymentRef");
  const note = formString(formData, "note");

  const result = await adminPayOrRequestSettlement({
    settlementId: id,
    adminId: admin.id,
    paymentRef,
    note,
  });
  if ("error" in result) {
    if (result.movedTo) revalidatePath("/admin/settlements");
    return { ok: false, error: result.error, movedTo: result.movedTo };
  }

  revalidatePath("/admin/settlements");
  revalidatePath(`/admin/settlements/${id}`);
  return { ok: true, id, requested: result.requested };
}

/**
 * The Paid / Unpaid dropdown on a single order.
 *
 * "Paid" builds a one-order draft and puts it up for approval, finished on that
 * payment's page with the reference; "Unpaid" voids a DRAFT one-order payout,
 * audited — or, when that payout is already paid, asks for a reversal that is
 * then approved on its page. Both re-gate on admin — a Server Action is a public
 * HTTP endpoint, and this one moves an order in and out of a vendor's payout
 * (AGENTS.md §3).
 */
export async function setOrderPaidAction(
  orderId: string,
  paid: boolean,
  reason?: string
): Promise<SettlementActionResult> {
  const admin = await requireRole("admin");

  const result = paid
    ? await adminRequestOrderPayout({ orderId, adminId: admin.id })
    : await markOrderUnpaid({ orderId, adminId: admin.id, reason });

  if ("error" in result) return { ok: false, error: result.error };

  revalidatePath("/admin/settlements");
  revalidatePath("/admin/settlements/orders");
  revalidatePath("/admin/orders");
  return {
    ok: true,
    id: "id" in result ? result.id : undefined,
    requested: paid,
    reversalRequested: "reversalRequested" in result ? result.reversalRequested : undefined,
  };
}

/** Ask for a paid settlement to be reversed (its transfer did not reach the vendor). */
export async function requestReversalAction(id: string, reason: string): Promise<SettlementActionResult> {
  const admin = await requireRole("admin");
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the payout should be reversed." };
  const res = await requestSettlementReversal(admin.id, id, why, crypto.randomUUID());
  if (!res.ok) {
    return {
      ok: false,
      error:
        res.error === "duplicate_pending" ? "A reversal of this payout is already waiting for approval."
        : res.error === "not_paid" ? "This settlement is not paid."
        : "Couldn't ask for the reversal. Try again.",
    };
  }
  revalidatePath(`/admin/settlements/${id}`);
  return { ok: true, id, requested: true };
}

/** Approve someone else's reversal request (or your own, under the one-admin switch, with a reason). */
export async function approveReversalAction(settlementId: string, requestId: string, note: string): Promise<SettlementActionResult> {
  const admin = await requireRole("admin");
  const res = await approveSettlementReversal(admin.id, requestId, note.trim() || null, crypto.randomUUID());
  if (!res.ok) {
    return {
      ok: false,
      error:
        res.error === "same_person" ? "You asked for this reversal, so someone else must approve it."
        : res.error === "reason_required" ? "Write a short reason."
        : res.error === "not_paid" ? "This settlement is no longer paid."
        : "Couldn't approve the reversal. Try again.",
    };
  }
  revalidatePath("/admin/settlements");
  revalidatePath(`/admin/settlements/${settlementId}`);
  return { ok: true, id: settlementId };
}

export async function voidSettlementAction(
  id: string,
  reason: string
): Promise<SettlementActionResult> {
  const admin = await requireRole("admin");
  const result = await voidSettlement({ id, adminId: admin.id, reason });
  if ("error" in result) return { ok: false, error: result.error };

  revalidatePath("/admin/settlements");
  revalidatePath(`/admin/settlements/${id}`);
  return { ok: true, id };
}
