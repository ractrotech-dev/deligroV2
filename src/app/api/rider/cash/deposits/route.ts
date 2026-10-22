import { cashJson, cashRouteError, riderCashGate } from "@/lib/auth/rider-cash-route";
import { listRiderDeposits, submitDeposit } from "@/lib/data-access/rider-cash";

const ROUTE = "/api/rider/cash/deposits";
/** 5 MB of photo plus the multipart envelope; anything larger is refused unread. */
const MAX_BODY_BYTES = 5 * 1024 * 1024 + 64 * 1024;

/**
 * GET /api/rider/cash/deposits — the rider's deposits, newest first.
 *
 *   200 { items: [{ id, amount, method: "cash" | "upi",
 *                   status: "submitted" | "confirmed" | "disputed" | "withdrawn",
 *                   managerId, managerName, reference, note, hasReceipt,
 *                   decisionNote, decidedAt, createdAt }] }
 *
 * `decisionNote` is the manager's note on a disputed deposit.
 *
 *   401 · 403 not_rider · 429 · 503 migration_pending · 500
 */
export async function GET() {
  const gate = await riderCashGate(`${ROUTE}:list`);
  if (!gate.ok) return gate.response;
  try {
    return cashJson({ items: await listRiderDeposits(gate.driverId) });
  } catch (e) {
    return cashRouteError(e, { route: ROUTE, method: "GET", riderId: gate.driverId, event: "cash_deposits" });
  }
}

/**
 * POST /api/rider/cash/deposits — declare a deposit.
 *
 * `multipart/form-data` { amount, method: "cash" | "upi", managerId?, reference?,
 * note?, photo? } (the receipt: JPEG or PNG, at most 5 MB, checked by its
 * bytes), or the same fields as JSON without a photo. Nothing is deposited
 * until a manager confirms: it joins `submittedAwaiting`.
 *
 *   201 { ok: true, id }
 *   400 invalid_body | invalid_amount (whole rupees above zero) | invalid_method |
 *       reference_required (UPI) | bad_photo | invalid_manager | invalid_note
 *   409 exceeds_pending   { pending, available } — more than the cash the rider
 *       holds, less deposits already waiting for a decision
 *   401 · 403 not_rider · 429 · 503 migration_pending · 500
 *
 * Rate limit: 6 a minute per rider.
 */
export async function POST(request: Request) {
  const gate = await riderCashGate(`${ROUTE}:post`, { writePerMinute: 6 });
  if (!gate.ok) return gate.response;

  const bad = (error: string) => cashJson({ error }, 400);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return bad("bad_photo");

  let fields: Record<string, unknown>;
  let photo: File | undefined;
  try {
    if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await request.formData();
      const text = (name: string) => {
        const v = form.get(name);
        return typeof v === "string" ? v : undefined;
      };
      const amountText = text("amount");
      fields = {
        amount: amountText !== undefined && /^\d{1,9}$/.test(amountText.trim()) ? Number(amountText) : NaN,
        method: text("method"),
        managerId: text("managerId"),
        reference: text("reference"),
        note: text("note"),
      };
      const file = form.get("photo");
      if (file instanceof File) {
        if (file.size > 0) photo = file;
      } else if (file !== null) {
        return bad("bad_photo");
      }
    } else {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      fields = parsed as Record<string, unknown>;
    }
  } catch {
    return bad("invalid_body");
  }

  // A field that is present must be text; absent is fine.
  const optional = (value: unknown): string | undefined | null =>
    value === undefined || value === null ? undefined : typeof value === "string" ? value : null;
  const managerId = optional(fields.managerId);
  const reference = optional(fields.reference);
  const note = optional(fields.note);
  if (managerId === null) return bad("invalid_manager");
  if (reference === null) return bad("reference_required");
  if (note === null) return bad("invalid_note");
  if (typeof fields.amount !== "number") return bad("invalid_amount");
  if (typeof fields.method !== "string") return bad("invalid_method");

  try {
    const result = await submitDeposit(gate.driverId, {
      amount: fields.amount,
      method: fields.method as "cash" | "upi",
      managerId,
      reference,
      note,
      photo,
    });
    if (result.ok) return cashJson({ ok: true, id: result.id }, 201);
    if (result.error === "exceeds_pending") {
      return cashJson({ error: result.error, pending: result.pending ?? 0, available: result.available ?? 0 }, 409);
    }
    return bad(result.error);
  } catch (e) {
    return cashRouteError(e, { route: ROUTE, method: "POST", riderId: gate.driverId, event: "cash_deposit_submit" });
  }
}
