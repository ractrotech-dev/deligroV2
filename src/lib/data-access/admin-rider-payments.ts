import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Profile } from "@/lib/auth";
import type { ManagerApiContext } from "@/lib/auth/manager-api.server";
import { listPaymentRequests, type PaymentRequestQuery } from "@/lib/data-access/payment-requests";
import { singleAdminPaymentsOn, withPaymentSettings } from "@/lib/data-access/payment-approvals";
import type { PaymentRequest } from "@/lib/ops/rider-contract";
import { isSchemaMissing } from "@/lib/rider/admin-money";
import { PAYMENT_REQUEST_COLUMNS, toPaymentRequest, type PaymentRequestRow } from "@/lib/ops/rider-serialize";
import { loadPeople, loadZoneNames, namesFrom } from "@/lib/data-access/manager-riders";

/**
 * The admin console's door to rider payment requests (0152). There is one way a
 * rider gets paid: `ops_request_rider_payout`, then `ops_decide_payment_request`.
 * This module adds no rule of its own. It hands the manager app's data layer an
 * admin's context (every zone, and `isAdmin` for the viewer) so a payment made
 * here runs the same RPCs, sends the same notices and writes the same audit rows.
 *
 * Callers run `requireRole("admin")` first (AGENTS.md rule 5); the RPCs check the
 * actor's role again.
 */

/** An admin as the payment data layer expects its caller. */
export function adminPaymentContext(admin: Profile): ManagerApiContext {
  return { profile: admin, scope: { all: true }, permissions: {} };
}

/** Whether this admin can approve their own payment, or null when payment requests aren't there yet. */
export async function adminPaymentMode(): Promise<boolean | null> {
  return singleAdminPaymentsOn();
}

export type RiderPaymentList =
  | { state: "ok"; items: PaymentRequest[]; nextCursor: string | null; counts: Record<PaymentRequest["status"], number> }
  | { state: "unavailable" };

/** One page of rider payment requests, newest first, with true counts per status. */
export async function listRiderPayments(
  admin: Profile,
  q: Pick<PaymentRequestQuery, "status" | "cursor">
): Promise<RiderPaymentList> {
  const viewer = { id: admin.id, perms: {}, isAdmin: true };
  try {
    const page = await listPaymentRequests({ all: true }, viewer, { ...q, kind: "rider_payout", zone: null, mine: false });
    return { state: "ok", ...page };
  } catch (e) {
    if (isSchemaMissing(e as { code?: string })) return { state: "unavailable" };
    throw e;
  }
}

/** The payment waiting for one rider, if any: one at a time is the database's rule. */
export async function waitingPaymentForRider(admin: Profile, riderId: string): Promise<PaymentRequest | null> {
  const { data, error } = await createAdminClient()
    .from("payment_requests")
    .select(PAYMENT_REQUEST_COLUMNS)
    .eq("kind", "rider_payout")
    .eq("subject_id", riderId)
    .eq("status", "pending_approval")
    .maybeSingle();
  if (error) {
    if (isSchemaMissing(error)) return null;
    throw error;
  }
  if (!data) return null;
  const row = data as unknown as PaymentRequestRow;
  const [people, zones, viewer] = await Promise.all([
    loadPeople([row.subject_id, row.requested_by, row.decided_by]),
    loadZoneNames([row.zone_id]),
    withPaymentSettings({ id: admin.id, perms: {}, isAdmin: true }),
  ]);
  return toPaymentRequest(row, namesFrom(people, zones, false), viewer);
}
