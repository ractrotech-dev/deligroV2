"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { formString } from "@/lib/utils/form-data";
import {
  createSettlementDraft,
  markOrderUnpaid,
  voidSettlement,
} from "@/lib/data-access/admin-settlements";
import {
  adminPayOrRequestSettlement,
  adminRequestOrderPayout,
} from "@/lib/data-access/settlement-requests";

export type SettlementActionResult =
  | { ok: true; id?: string; requested?: boolean }
  | { ok: false; error: string };

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

/**
 * "Send for approval" / "Approve and mark paid" on a draft. No vendor payment
 * is ever made by one person (migration 0156): an unrequested draft is put up
 * for approval; a draft someone ELSE put up is approved here with the UTR,
 * which marks it paid.
 */
export async function markSettlementPaidAction(
  formData: FormData
): Promise<SettlementActionResult> {
  const admin = await requireRole("admin");
  const id = formString(formData, "id");
  const paymentRef = formString(formData, "paymentRef");

  const result = await adminPayOrRequestSettlement({
    settlementId: id,
    adminId: admin.id,
    paymentRef,
  });
  if ("error" in result) return { ok: false, error: result.error };

  revalidatePath("/admin/settlements");
  revalidatePath(`/admin/settlements/${id}`);
  return { ok: true, id, requested: result.requested };
}

/**
 * The Paid / Unpaid dropdown on a single order.
 *
 * "Paid" builds a one-order draft and puts it up for approval (someone else
 * approves it with the reference); "Unpaid" voids the order's one-order
 * payout, audited. Both re-gate on admin — a Server Action is a public HTTP
 * endpoint, and this one moves an order in and out of a vendor's payout
 * (AGENTS.md §3).
 */
export async function setOrderPaidAction(
  orderId: string,
  paid: boolean
): Promise<SettlementActionResult> {
  const admin = await requireRole("admin");

  const result = paid
    ? await adminRequestOrderPayout({ orderId, adminId: admin.id })
    : await markOrderUnpaid({ orderId, adminId: admin.id });

  if ("error" in result) return { ok: false, error: result.error };

  revalidatePath("/admin/settlements");
  revalidatePath("/admin/settlements/orders");
  revalidatePath("/admin/orders");
  return { ok: true, id: "id" in result ? result.id : undefined, requested: paid };
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
