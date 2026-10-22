import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readAllRows } from "@/lib/data-access/read-all";
import { isMissingColumn, isMissingTable } from "@/lib/data-access/schema-probe";
import { RiderSchemaPendingError, getRiderCode } from "@/lib/data-access/rider-status";
import { isCashOrder } from "@/lib/data-access/rider-delivery-actions";
import { recordCodHandover } from "@/lib/data-access/cod-handovers";
import {
  notifyOpsDepositSubmitted,
  notifyRiderCashReminder,
  notifyRiderDepositDecided,
} from "@/lib/notifications/order-events";
import { deferNotify } from "@/lib/notifications/defer";
import { assertRealType } from "@/lib/utils/file-signature";
import { shortOrderId } from "@/lib/utils/order-map";
import { captureError } from "@/lib/obs/emit";
import { addDays, isDayKey, istDay, istDayStartIso, parseRange } from "@/lib/rider/earnings-math";
import {
  MAX_DEPOSIT,
  buildCashSummary,
  checkDeposit,
  reminderDue,
  reminderReason,
  sameDayHandoverTotal,
  type CashCollection,
  type CashDepositRow,
  type CashDisputeRow,
  type CashHandoverRow,
  type DepositInputError,
  type RiderCashSummary,
} from "@/lib/rider/cash-math";

export type { RiderCashSummary };

/**
 * A rider's cash, read from `deliveries.cod_collected_amount` (0047),
 * `cod_handovers` and `cash_deposits` (0085) — and the deposit workflow around
 * it: the rider declares, a manager confirms (which writes the one
 * `cod_handovers` row, through `recordCodHandover`) or disputes with a note.
 *
 * Every function takes an id and trusts it, because every one runs on the
 * service-role client. The authorization is the caller's: `/api/rider/cash/*`
 * derive the rider id from the session (`requireRiderApi`), and the manager
 * decisions arrive behind `requireRole(["manager", "admin"])` with the actor
 * passed in. Every rider read is filtered `driver_id = <that id>`.
 *
 * Cash collected for Deligro never touches the salary ledger: nothing here
 * reads or writes rider_earnings, rider_adjustments or rider_payouts.
 *
 * ## Before 0085 is applied
 *
 * Every function throws `RiderSchemaPendingError` (routes: 503
 * `migration_pending`) — a ₹0 position would be a false statement about cash
 * the rider is holding. `sendCashReminders` is the exception: it runs from the
 * dispatch sweep and does nothing.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

const PROOF_BUCKET = "delivery-proofs";
const PHOTO_TYPES: Record<string, "jpg" | "png"> = { "image/jpeg": "jpg", "image/png": "png" };
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const SIGNED_URL_SECONDS = 600;
const NOTE_MAX = 300;
const MESSAGE_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 5000;
const DEFAULT_MAX_HOURS = 24;
/** A claim on a deposit that was never completed (the process died) can be taken over after this. */
const CLAIM_STALE_MS = 2 * 60_000;
/** Disputes may name any day in this window. */
const DISPUTE_WINDOW_DAYS = 90;

function pending(): RiderSchemaPendingError {
  return new RiderSchemaPendingError("migration_pending: the rider cash tables (0085) are not applied");
}

/** A missing 0085 table is a known state (503); anything else is the raw error. */
function failRead(error: { code?: string }): never {
  if (isMissingTable(error)) throw pending();
  throw error;
}

/** A malformed query: the routes answer 400 with `code`. */
export class CashInputError extends Error {
  constructor(readonly code: "invalid_date" | "invalid_range" | "invalid_cursor") {
    super(code);
    this.name = "CashInputError";
  }
}

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

// ---------------------------------------------------------------------------
// the position
// ---------------------------------------------------------------------------

/** `rider_cash_limit` / `rider_cash_max_hours`; a database without 0085 reads the defaults. */
export async function readCashThresholds(supabase: AdminClient): Promise<{ limit: number; maxHours: number }> {
  const { data, error } = await supabase
    .from("platform_settings")
    .select("rider_cash_limit, rider_cash_max_hours")
    .eq("id", true)
    .maybeSingle()
    .overrideTypes<{ rider_cash_limit: number | null; rider_cash_max_hours: number | null }>();
  if (error) {
    if (isMissingColumn(error) || isMissingTable(error)) return { limit: DEFAULT_LIMIT, maxHours: DEFAULT_MAX_HOURS };
    throw error;
  }
  return {
    limit: Number.isInteger(data?.rider_cash_limit) ? (data!.rider_cash_limit as number) : DEFAULT_LIMIT,
    maxHours: Number.isInteger(data?.rider_cash_max_hours) ? (data!.rider_cash_max_hours as number) : DEFAULT_MAX_HOURS,
  };
}

interface OrderJoin {
  total: number | null;
  payment_method: string | null;
  payment_status: string | null;
}

/** COD totals of the deliveries the rider holds right now. Online-paid orders are not cash. */
async function loadToCollect(supabase: AdminClient, driverId: string): Promise<number> {
  const { data, error } = await supabase
    .from("deliveries")
    .select("id, orders(total, payment_method, payment_status)")
    .eq("driver_id", driverId)
    .in("status", ["assigned", "picked_up"])
    .limit(200)
    .overrideTypes<{ id: string; orders: OrderJoin | OrderJoin[] | null }[]>();
  if (error) throw error;
  let total = 0;
  for (const d of data ?? []) {
    const order = one(d.orders);
    if (!order) continue;
    if (isCashOrder({ payment_method: order.payment_method as never, payment_status: order.payment_status as never })) {
      total += order.total ?? 0;
    }
  }
  return total;
}

interface Position {
  collections: CashCollection[];
  handovers: CashHandoverRow[];
  deposits: CashDepositRow[];
  disputes: CashDisputeRow[];
  toCollect: number;
  limit: number;
  maxHours: number;
}

async function loadPosition(supabase: AdminClient, driverId: string): Promise<Position> {
  const [collected, handed, deposits, disputes, toCollect, thresholds] = await Promise.all([
    readAllRows<{ id: string; cod_collected_amount: number | null; cod_collected_at: string | null }>((from, to) =>
      supabase
        .from("deliveries")
        .select("id, cod_collected_amount, cod_collected_at")
        .eq("driver_id", driverId)
        .not("cod_collected_amount", "is", null)
        .order("id")
        .range(from, to)
        .overrideTypes<{ id: string; cod_collected_amount: number | null; cod_collected_at: string | null }[]>()
    ),
    readAllRows<{ id: string; amount: number; handover_date: string }>((from, to) =>
      supabase
        .from("cod_handovers")
        .select("id, amount, handover_date")
        .eq("leg", "rider_to_manager")
        .eq("from_user", driverId)
        .order("id")
        .range(from, to)
        .overrideTypes<{ id: string; amount: number; handover_date: string }[]>()
    ),
    readAllRows<{ id: string; status: CashDepositRow["status"]; amount: number; created_at: string; decision_note: string | null }>(
      (from, to) =>
        supabase
          .from("cash_deposits")
          .select("id, status, amount, created_at, decision_note")
          .eq("driver_id", driverId)
          .order("id")
          .range(from, to)
          .overrideTypes<
            { id: string; status: CashDepositRow["status"]; amount: number; created_at: string; decision_note: string | null }[]
          >()
    ),
    readAllRows<{ id: string; day: string; status: CashDisputeRow["status"] }>((from, to) =>
      supabase
        .from("cash_disputes")
        .select("id, day, status")
        .eq("driver_id", driverId)
        .order("id")
        .range(from, to)
        .overrideTypes<{ id: string; day: string; status: CashDisputeRow["status"] }[]>()
    ),
    loadToCollect(supabase, driverId),
    readCashThresholds(supabase),
  ]);
  for (const result of [collected, handed, deposits, disputes]) {
    if (result.error) failRead(result.error as { code?: string });
  }
  return {
    collections: collected.data
      .filter((r) => r.cod_collected_amount !== null)
      .map((r) => ({ amount: r.cod_collected_amount as number, at: r.cod_collected_at ?? "1970-01-01T00:00:00Z" })),
    handovers: handed.data.map((r) => ({ amount: r.amount, day: r.handover_date })),
    deposits: deposits.data.map((r) => ({
      status: r.status,
      amount: r.amount,
      createdAt: r.created_at,
      decisionNote: r.decision_note,
    })),
    disputes: disputes.data.map((r) => ({ day: r.day, status: r.status })),
    toCollect,
    limit: thresholds.limit,
    maxHours: thresholds.maxHours,
  };
}

/** The Cash screen's figures. See `buildCashSummary` for the definitions. */
export async function getRiderCashSummary(driverId: string, now: Date = new Date()): Promise<RiderCashSummary> {
  return buildCashSummary(await loadPosition(createAdminClient(), driverId), now);
}

// ---------------------------------------------------------------------------
// collections (order-wise)
// ---------------------------------------------------------------------------

export interface CollectionItem {
  orderId: string;
  /** `#ABCD1234`. */
  code: string;
  /** ISO instant the order was delivered. */
  at: string;
  /** Rupees: the cash collected for `cod`; the order total for `online` (paid online, not cash). */
  amount: number;
  method: "cod" | "online";
  /** `collected` (cash recorded), `not_recorded` (a cash order whose collection was never recorded), `paid_online`. */
  status: "collected" | "not_recorded" | "paid_online";
}

const DEFAULT_RANGE_DAYS = 31;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

function encodeCursor(item: CollectionItem): string {
  return Buffer.from(`${item.at}|${item.orderId}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { at: string; orderId: string } {
  const raw = /^[A-Za-z0-9_-]{1,200}$/.test(cursor) ? Buffer.from(cursor, "base64url").toString("utf8") : "";
  const [at, orderId] = raw.split("|");
  if (!at || !Number.isFinite(Date.parse(at)) || !orderId || !UUID.test(orderId)) throw new CashInputError("invalid_cursor");
  return { at, orderId };
}

/**
 * The orders the rider delivered, newest first, each as cash or paid online.
 * An online-paid order is listed (method `online`) but is never cash to
 * collect or collected. `from`/`to` are IST days, both or neither (neither =
 * the last 31 days).
 */
export async function listRiderCollections(
  driverId: string,
  q: { from?: string; to?: string; cursor?: string | null; limit?: number },
  now: Date = new Date()
): Promise<{ items: CollectionItem[]; nextCursor: string | null }> {
  let from: string;
  let to: string;
  if (q.from === undefined && q.to === undefined) {
    to = istDay(now);
    from = addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  } else if (q.from === undefined || q.to === undefined) {
    throw new CashInputError("invalid_range");
  } else {
    const range = parseRange(q.from, q.to);
    if (!range.ok) throw new CashInputError(range.error);
    ({ from, to } = range);
  }
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const limit = Number.isInteger(q.limit) && (q.limit as number) > 0 ? Math.min(q.limit as number, MAX_PAGE) : DEFAULT_PAGE;

  const supabase = createAdminClient();
  const rows = await readAllRows<{
    order_id: string;
    delivered_at: string | null;
    cod_collected_amount: number | null;
    orders: OrderJoin | OrderJoin[] | null;
  }>((start, end) =>
    supabase
      .from("deliveries")
      .select("order_id, delivered_at, cod_collected_amount, orders(total, payment_method, payment_status)")
      .eq("driver_id", driverId)
      .eq("status", "delivered")
      .gte("delivered_at", istDayStartIso(from))
      .lt("delivered_at", istDayStartIso(addDays(to, 1)))
      .order("order_id")
      .range(start, end)
      .overrideTypes<
        {
          order_id: string;
          delivered_at: string | null;
          cod_collected_amount: number | null;
          orders: OrderJoin | OrderJoin[] | null;
        }[]
      >()
  );
  if (rows.error) throw rows.error;

  const items: CollectionItem[] = [];
  for (const r of rows.data) {
    if (!r.delivered_at) continue;
    const order = one(r.orders);
    // Cash if a collection was recorded, or the order was payable in cash at the door.
    const cash =
      r.cod_collected_amount !== null ||
      isCashOrder(order ? { payment_method: order.payment_method as never, payment_status: order.payment_status as never } : null);
    items.push({
      orderId: r.order_id,
      code: `#${shortOrderId(r.order_id)}`,
      at: r.delivered_at,
      amount: cash ? (r.cod_collected_amount ?? order?.total ?? 0) : (order?.total ?? 0),
      method: cash ? "cod" : "online",
      status: !cash ? "paid_online" : r.cod_collected_amount !== null ? "collected" : "not_recorded",
    });
  }
  items.sort((a, b) => {
    const t = Date.parse(b.at) - Date.parse(a.at);
    return t !== 0 ? t : a.orderId < b.orderId ? 1 : a.orderId > b.orderId ? -1 : 0;
  });
  const page = after
    ? items.filter((i) => {
        const t = Date.parse(i.at) - Date.parse(after.at);
        return t < 0 || (t === 0 && i.orderId < after.orderId);
      })
    : items;
  const slice = page.slice(0, limit);
  return { items: slice, nextCursor: page.length > limit ? encodeCursor(slice[slice.length - 1]) : null };
}

// ---------------------------------------------------------------------------
// deposits (the rider's side)
// ---------------------------------------------------------------------------

export type SubmitDepositResult =
  | { ok: true; id: string }
  | {
      ok: false;
      error: DepositInputError | "bad_photo" | "invalid_manager" | "invalid_note";
      /** For `exceeds_pending`: the cash the rider holds, and what they may still declare. */
      pending?: number;
      available?: number;
    };

export async function submitDeposit(
  driverId: string,
  input: {
    amount: number;
    method: "cash" | "upi";
    managerId?: string;
    reference?: string;
    photo?: File;
    note?: string;
  }
): Promise<SubmitDepositResult> {
  const supabase = createAdminClient();
  const position = buildCashSummary(await loadPosition(supabase, driverId));
  const checked = checkDeposit(input, position);
  if (!checked.ok) return checked;

  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > NOTE_MAX) return { ok: false, error: "invalid_note" };

  let managerId: string | null = null;
  if (input.managerId !== undefined && input.managerId !== "") {
    if (typeof input.managerId !== "string" || !UUID.test(input.managerId)) return { ok: false, error: "invalid_manager" };
    const { data, error } = await supabase
      .from("profiles")
      .select("id, role")
      .eq("id", input.managerId)
      .maybeSingle()
      .overrideTypes<{ id: string; role: string }>();
    if (error) throw error;
    if (!data || (data.role !== "manager" && data.role !== "admin")) return { ok: false, error: "invalid_manager" };
    managerId = data.id;
  }

  let photoPath: string | null = null;
  const photo = input.photo;
  if (photo !== undefined) {
    const ext = PHOTO_TYPES[photo.type];
    if (!ext || photo.size === 0 || photo.size > MAX_PHOTO_BYTES) return { ok: false, error: "bad_photo" };
    try {
      await assertRealType(photo, ["image/jpeg", "image/png"]);
    } catch {
      return { ok: false, error: "bad_photo" };
    }
    photoPath = `deposits/${driverId}/${crypto.randomUUID()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from(PROOF_BUCKET)
      .upload(photoPath, photo, { contentType: photo.type, upsert: false });
    if (uploadError) {
      if (/bucket not found/i.test(uploadError.message)) throw pending();
      throw uploadError;
    }
  }

  const { data, error } = await supabase
    .from("cash_deposits")
    .insert({
      driver_id: driverId,
      amount: checked.amount,
      method: checked.method,
      manager_id: managerId,
      reference: checked.reference,
      photo_path: photoPath,
      note: note || null,
    })
    .select("id")
    .single()
    .overrideTypes<{ id: string }>();
  if (error || !data) {
    if (photoPath) await supabase.storage.from(PROOF_BUCKET).remove([photoPath]);
    if (error && isMissingTable(error)) throw pending();
    throw error ?? new Error("deposit_not_saved");
  }

  deferNotify(async () => {
    const { data: rider } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", driverId)
      .maybeSingle()
      .overrideTypes<{ full_name: string | null }>();
    await notifyOpsDepositSubmitted({ riderName: rider?.full_name, amount: checked.amount, method: checked.method });
  });
  return { ok: true, id: data.id };
}

export interface RiderDeposit {
  id: string;
  amount: number;
  method: "cash" | "upi";
  status: "submitted" | "confirmed" | "disputed" | "withdrawn";
  managerId: string | null;
  managerName: string | null;
  reference: string | null;
  note: string | null;
  hasReceipt: boolean;
  /** The manager's note on a dispute. */
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** The rider's deposits, newest first. */
export async function listRiderDeposits(driverId: string, limit = 50): Promise<RiderDeposit[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("cash_deposits")
    .select("id, amount, method, status, manager_id, reference, photo_path, note, decision_note, decided_at, created_at")
    .eq("driver_id", driverId)
    .order("created_at", { ascending: false })
    .order("id")
    .limit(Math.min(Math.max(1, limit), 200))
    .overrideTypes<
      {
        id: string;
        amount: number;
        method: "cash" | "upi";
        status: RiderDeposit["status"];
        manager_id: string | null;
        reference: string | null;
        photo_path: string | null;
        note: string | null;
        decision_note: string | null;
        decided_at: string | null;
        created_at: string;
      }[]
    >();
  if (error) failRead(error);
  const rows = data ?? [];
  const names = await profileNames(
    supabase,
    rows.map((r) => r.manager_id)
  );
  return rows.map((r) => ({
    id: r.id,
    amount: r.amount,
    method: r.method,
    status: r.status,
    managerId: r.manager_id,
    managerName: r.manager_id ? (names.get(r.manager_id) ?? null) : null,
    reference: r.reference,
    note: r.note,
    hasReceipt: !!r.photo_path,
    decisionNote: r.decision_note,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  }));
}

async function profileNames(supabase: AdminClient, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name")
    .in("id", unique)
    .overrideTypes<{ id: string; full_name: string | null }[]>();
  if (error) throw error;
  for (const p of data ?? []) out.set(p.id, p.full_name?.trim() || "Manager");
  return out;
}

/** The managers a rider can name when depositing: id and name, nothing else. */
export async function listDepositManagers(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await createAdminClient()
    .from("profiles")
    .select("id, full_name")
    .eq("role", "manager")
    .order("full_name")
    .limit(100)
    .overrideTypes<{ id: string; full_name: string | null }[]>();
  if (error) throw error;
  return (data ?? []).map((m) => ({ id: m.id, name: m.full_name?.trim() || "Manager" }));
}

/**
 * Withdraw a deposit still waiting for a decision. Conditional on `submitted`
 * and not claimed by a manager mid-confirmation, so a deposit being confirmed
 * cannot be withdrawn out from under the handover.
 */
export async function withdrawDeposit(
  driverId: string,
  depositId: string
): Promise<{ ok: true } | { ok: false; error: "not_found" | "already_decided" }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("cash_deposits")
    .update({ status: "withdrawn" })
    .eq("id", depositId)
    .eq("driver_id", driverId)
    .eq("status", "submitted")
    .is("decided_by", null)
    .select("id")
    .overrideTypes<{ id: string }[]>();
  if (error) failRead(error);
  if ((data ?? []).length > 0) return { ok: true };
  // The same answer for another rider's deposit and one that does not exist.
  const { data: existing, error: readError } = await supabase
    .from("cash_deposits")
    .select("id")
    .eq("id", depositId)
    .eq("driver_id", driverId)
    .maybeSingle()
    .overrideTypes<{ id: string }>();
  if (readError) throw readError;
  return { ok: false, error: existing ? "already_decided" : "not_found" };
}

// ---------------------------------------------------------------------------
// disputes (the rider's side)
// ---------------------------------------------------------------------------

export type RaiseDisputeResult =
  | { ok: true; id: string }
  | { ok: false; error: "invalid_day" | "message_required" | "invalid_amount" | "already_open" };

export async function raiseCashDispute(
  driverId: string,
  input: { day: string; claimedAmount?: number; message: string },
  now: Date = new Date()
): Promise<RaiseDisputeResult> {
  const today = istDay(now);
  if (!isDayKey(input.day) || input.day > today || input.day < addDays(today, -DISPUTE_WINDOW_DAYS)) {
    return { ok: false, error: "invalid_day" };
  }
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message || message.length > MESSAGE_MAX) return { ok: false, error: "message_required" };
  if (
    input.claimedAmount !== undefined &&
    (!Number.isInteger(input.claimedAmount) || input.claimedAmount < 0 || input.claimedAmount > MAX_DEPOSIT)
  ) {
    return { ok: false, error: "invalid_amount" };
  }

  const supabase = createAdminClient();
  const { data: open, error: openError } = await supabase
    .from("cash_disputes")
    .select("id")
    .eq("driver_id", driverId)
    .eq("day", input.day)
    .eq("status", "open")
    .limit(1)
    .overrideTypes<{ id: string }[]>();
  if (openError) failRead(openError);
  if ((open ?? []).length > 0) return { ok: false, error: "already_open" };

  const { data, error } = await supabase
    .from("cash_disputes")
    .insert({
      driver_id: driverId,
      day: input.day,
      claimed_amount: input.claimedAmount ?? null,
      message,
    })
    .select("id")
    .single()
    .overrideTypes<{ id: string }>();
  if (error || !data) {
    if (error && isMissingTable(error)) throw pending();
    throw error ?? new Error("dispute_not_saved");
  }
  return { ok: true, id: data.id };
}

export interface RiderDispute {
  id: string;
  day: string;
  claimedAmount: number | null;
  message: string;
  status: "open" | "resolved";
  resolution: string | null;
  createdAt: string;
}

export async function listRiderDisputes(driverId: string, limit = 50): Promise<RiderDispute[]> {
  const { data, error } = await createAdminClient()
    .from("cash_disputes")
    .select("id, day, claimed_amount, message, status, resolution, created_at")
    .eq("driver_id", driverId)
    .order("created_at", { ascending: false })
    .order("id")
    .limit(Math.min(Math.max(1, limit), 200))
    .overrideTypes<
      {
        id: string;
        day: string;
        claimed_amount: number | null;
        message: string;
        status: "open" | "resolved";
        resolution: string | null;
        created_at: string;
      }[]
    >();
  if (error) failRead(error);
  return (data ?? []).map((d) => ({
    id: d.id,
    day: d.day,
    claimedAmount: d.claimed_amount,
    message: d.message,
    status: d.status,
    resolution: d.resolution,
    createdAt: d.created_at,
  }));
}

// ---------------------------------------------------------------------------
// the manager's side
// ---------------------------------------------------------------------------

export type DecideDepositResult =
  | { ok: true }
  | {
      ok: false;
      error: "not_found" | "already_decided" | "note_required" | "already_recorded" | "handover_failed";
      /** For `already_recorded`: what is already recorded as handed over by this rider today. */
      recordedToday?: number;
    };

interface DepositRow {
  id: string;
  driver_id: string;
  amount: number;
  method: "cash" | "upi";
  manager_id: string | null;
  reference: string | null;
  status: string;
  decided_by: string | null;
}

/**
 * A manager or admin decides a submitted deposit.
 *
 * **Confirm** writes the one `cod_handovers` row (`rider_to_manager`,
 * `from_user` = the rider, `to_user` = the manager the rider named or else the
 * confirmer, `recorded_by` = the confirmer) through `recordCodHandover`, then
 * links it (`handover_id`) and marks the deposit `confirmed`. Exactly once: the
 * deposit is first CLAIMED with a conditional update (`decided_by` set while
 * still `submitted`), so two managers confirming together cannot both write a
 * handover; a claim whose confirmation never finished goes stale after two
 * minutes and can be taken over. If the manager recorded the same handover
 * directly today, the confirmation is refused with `already_recorded` unless
 * `confirmAnyway` — nothing is silently counted twice.
 *
 * **Dispute** needs a note, which the rider reads.
 */
export async function decideDeposit(
  actor: { id: string; role: "manager" | "admin" },
  id: string,
  decision: "confirm" | "dispute",
  note?: string,
  opts: { confirmAnyway?: boolean; now?: Date } = {}
): Promise<DecideDepositResult> {
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (decision === "dispute" && !trimmed) return { ok: false, error: "note_required" };
  if (!UUID.test(id)) return { ok: false, error: "not_found" };

  const supabase = createAdminClient();
  const now = opts.now ?? new Date();
  const { data: deposit, error: readError } = await supabase
    .from("cash_deposits")
    .select("id, driver_id, amount, method, manager_id, reference, status, decided_by")
    .eq("id", id)
    .maybeSingle()
    .overrideTypes<DepositRow>();
  if (readError) failRead(readError);
  if (!deposit) return { ok: false, error: "not_found" };
  if (deposit.status !== "submitted") return { ok: false, error: "already_decided" };

  if (decision === "confirm" && !opts.confirmAnyway) {
    const recordedToday = await riderHandoversToday(supabase, deposit.driver_id, istDay(now));
    if (recordedToday > 0) return { ok: false, error: "already_recorded", recordedToday };
  }

  const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
  const decidedAt = now.toISOString();

  if (decision === "dispute") {
    const { data, error } = await supabase
      .from("cash_deposits")
      .update({ status: "disputed", decision_note: trimmed, decided_by: actor.id, decided_at: decidedAt })
      .eq("id", id)
      .eq("status", "submitted")
      .or(`decided_by.is.null,decided_at.lt.${stale}`)
      .select("id")
      .overrideTypes<{ id: string }[]>();
    if (error) failRead(error);
    if ((data ?? []).length === 0) return { ok: false, error: "already_decided" };
    deferNotify(() =>
      notifyRiderDepositDecided(deposit.driver_id, { amount: deposit.amount, status: "disputed", note: trimmed })
    );
    return { ok: true };
  }

  // Claim, then write the handover, then link: see the doc comment.
  const claim = await supabase
    .from("cash_deposits")
    .update({ decided_by: actor.id, decided_at: decidedAt })
    .eq("id", id)
    .eq("status", "submitted")
    .or(`decided_by.is.null,decided_at.lt.${stale}`)
    .select("id")
    .overrideTypes<{ id: string }[]>();
  if (claim.error) failRead(claim.error);
  if ((claim.data ?? []).length === 0) return { ok: false, error: "already_decided" };

  const release = () =>
    supabase
      .from("cash_deposits")
      .update({ decided_by: null, decided_at: null })
      .eq("id", id)
      .eq("status", "submitted")
      .eq("decided_by", actor.id);

  const handoverNote = [
    "Rider deposit",
    deposit.method === "upi" ? `UPI${deposit.reference ? ` ${deposit.reference}` : ""}` : "cash",
    trimmed || null,
  ]
    .filter(Boolean)
    .join(" · ");
  const handover = await recordCodHandover({
    leg: "rider_to_manager",
    fromUserId: deposit.driver_id,
    toUserId: deposit.manager_id ?? actor.id,
    amount: deposit.amount,
    note: handoverNote,
    recordedBy: actor.id,
  });
  if (!handover.ok || !handover.id) {
    await release();
    return { ok: false, error: "handover_failed" };
  }

  const link = await supabase
    .from("cash_deposits")
    .update({ status: "confirmed", handover_id: handover.id, decision_note: trimmed || null })
    .eq("id", id)
    .eq("status", "submitted")
    .eq("decided_by", actor.id)
    .select("id")
    .overrideTypes<{ id: string }[]>();
  if (link.error || (link.data ?? []).length === 0) {
    // The handover exists (append-only) but the deposit did not take it. The claim
    // stays, so a retry cannot write a second handover; say so loudly.
    captureError(link.error ?? new Error("deposit_link_failed"), {
      source: "rider-cash",
      attrs: { event: "deposit_handover_not_linked", depositId: id, handoverId: handover.id },
    });
    throw link.error ?? new Error("deposit_link_failed");
  }
  deferNotify(() => notifyRiderDepositDecided(deposit.driver_id, { amount: deposit.amount, status: "confirmed" }));
  return { ok: true };
}

/** rider_to_manager cash already recorded for this rider on this IST day. */
async function riderHandoversToday(supabase: AdminClient, driverId: string, day: string): Promise<number> {
  const { data, error } = await supabase
    .from("cod_handovers")
    .select("leg, from_user, amount, handover_date")
    .eq("leg", "rider_to_manager")
    .eq("from_user", driverId)
    .eq("handover_date", day)
    .limit(200)
    .overrideTypes<{ leg: string; from_user: string | null; amount: number; handover_date: string }[]>();
  if (error) throw error;
  return sameDayHandoverTotal(
    (data ?? []).map((h) => ({ leg: h.leg, fromUser: h.from_user, amount: h.amount, handoverDate: h.handover_date })),
    driverId,
    day
  );
}

export interface QueuedDeposit {
  id: string;
  riderId: string;
  riderName: string;
  /** DR-0001, or null until 0081 issued one. */
  riderCode: string | null;
  amount: number;
  method: "cash" | "upi";
  reference: string | null;
  note: string | null;
  managerId: string | null;
  managerName: string | null;
  /** A short-lived signed link to the receipt photo, when there is one. */
  receiptUrl: string | null;
  createdAt: string;
  /** What is already recorded as handed over by this rider today (rupees). */
  alreadyRecordedToday: number;
}

/** Submitted deposits, oldest first, with what a manager needs to decide. */
export async function listDepositQueue(now: Date = new Date()): Promise<QueuedDeposit[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("cash_deposits")
    .select("id, driver_id, amount, method, manager_id, reference, photo_path, note, created_at")
    .eq("status", "submitted")
    .order("created_at", { ascending: true })
    .order("id")
    .limit(100)
    .overrideTypes<
      {
        id: string;
        driver_id: string;
        amount: number;
        method: "cash" | "upi";
        manager_id: string | null;
        reference: string | null;
        photo_path: string | null;
        note: string | null;
        created_at: string;
      }[]
    >();
  if (error) failRead(error);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const names = await profileNames(supabase, [...rows.map((r) => r.driver_id), ...rows.map((r) => r.manager_id)]);
  const riderIds = [...new Set(rows.map((r) => r.driver_id))];
  const today = istDay(now);
  const handovers = await supabase
    .from("cod_handovers")
    .select("leg, from_user, amount, handover_date")
    .eq("leg", "rider_to_manager")
    .eq("handover_date", today)
    .in("from_user", riderIds)
    .limit(500)
    .overrideTypes<{ leg: string; from_user: string | null; amount: number; handover_date: string }[]>();
  if (handovers.error) throw handovers.error;
  const dup = (handovers.data ?? []).map((h) => ({
    leg: h.leg,
    fromUser: h.from_user,
    amount: h.amount,
    handoverDate: h.handover_date,
  }));
  const codes = new Map<string, string | null>();
  await Promise.all(riderIds.map(async (id) => codes.set(id, await getRiderCode(id).catch(() => null))));

  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      riderId: r.driver_id,
      riderName: names.get(r.driver_id) ?? "Rider",
      riderCode: codes.get(r.driver_id) ?? null,
      amount: r.amount,
      method: r.method,
      reference: r.reference,
      note: r.note,
      managerId: r.manager_id,
      managerName: r.manager_id ? (names.get(r.manager_id) ?? null) : null,
      receiptUrl: await signReceipt(supabase, r.driver_id, r.photo_path),
      createdAt: r.created_at,
      alreadyRecordedToday: sameDayHandoverTotal(dup, r.driver_id, today),
    }))
  );
}

/** Signed only for a path inside this rider's own `deposits/<riderId>/` folder. */
async function signReceipt(supabase: AdminClient, driverId: string, path: string | null): Promise<string | null> {
  if (!path || !path.startsWith(`deposits/${driverId}/`)) return null;
  const { data, error } = await supabase.storage.from(PROOF_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export interface CashDisputeListing {
  id: string;
  riderId: string;
  riderName: string;
  day: string;
  claimedAmount: number | null;
  message: string;
  status: "open" | "resolved";
  resolution: string | null;
  createdAt: string;
}

/** Open disputes first (oldest first: the longest waiting), then the most recent resolved ones. */
export async function listCashDisputes(limit = 50): Promise<CashDisputeListing[]> {
  const supabase = createAdminClient();
  type Row = {
    id: string;
    driver_id: string;
    day: string;
    claimed_amount: number | null;
    message: string;
    status: "open" | "resolved";
    resolution: string | null;
    created_at: string;
  };
  const columns = "id, driver_id, day, claimed_amount, message, status, resolution, created_at";
  const [open, resolved] = await Promise.all([
    supabase
      .from("cash_disputes")
      .select(columns)
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .limit(200)
      .overrideTypes<Row[]>(),
    supabase
      .from("cash_disputes")
      .select(columns)
      .eq("status", "resolved")
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(1, limit), 200))
      .overrideTypes<Row[]>(),
  ]);
  if (open.error) failRead(open.error);
  if (resolved.error) failRead(resolved.error);
  const rows = [...(open.data ?? []), ...(resolved.data ?? [])];
  const names = await profileNames(supabase, rows.map((r) => r.driver_id));
  return rows.map((r) => ({
    id: r.id,
    riderId: r.driver_id,
    riderName: names.get(r.driver_id) ?? "Rider",
    day: r.day,
    claimedAmount: r.claimed_amount,
    message: r.message,
    status: r.status,
    resolution: r.resolution,
    createdAt: r.created_at,
  }));
}

/** A manager or admin closes a dispute with what was decided. */
export async function resolveCashDispute(
  actor: { id: string },
  id: string,
  resolution: string
): Promise<{ ok: true } | { ok: false; error: "not_found" | "already_resolved" | "resolution_required" }> {
  const text = typeof resolution === "string" ? resolution.trim() : "";
  if (!text || text.length > MESSAGE_MAX) return { ok: false, error: "resolution_required" };
  if (!UUID.test(id)) return { ok: false, error: "not_found" };
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("cash_disputes")
    .update({ status: "resolved", resolution: text, resolved_by: actor.id, resolved_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "open")
    .select("id")
    .overrideTypes<{ id: string }[]>();
  if (error) failRead(error);
  if ((data ?? []).length > 0) return { ok: true };
  const { data: existing } = await supabase
    .from("cash_disputes")
    .select("id")
    .eq("id", id)
    .maybeSingle()
    .overrideTypes<{ id: string }>();
  return { ok: false, error: existing ? "already_resolved" : "not_found" };
}

export interface RecentDeposit {
  id: string;
  riderName: string;
  amount: number;
  method: "cash" | "upi";
  status: string;
  decisionNote: string | null;
  createdAt: string;
}

/** The latest deposits of any status, for the admin cash ledger. */
export async function listRecentDeposits(limit = 30): Promise<RecentDeposit[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("cash_deposits")
    .select("id, driver_id, amount, method, status, decision_note, created_at")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(1, limit), 200))
    .overrideTypes<
      {
        id: string;
        driver_id: string;
        amount: number;
        method: "cash" | "upi";
        status: string;
        decision_note: string | null;
        created_at: string;
      }[]
    >();
  if (error) failRead(error);
  const rows = data ?? [];
  const names = await profileNames(supabase, rows.map((r) => r.driver_id));
  return rows.map((r) => ({
    id: r.id,
    riderName: names.get(r.driver_id) ?? "Rider",
    amount: r.amount,
    method: r.method,
    status: r.status,
    decisionNote: r.decision_note,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// reminders (the dispatch sweep)
// ---------------------------------------------------------------------------

/** How many riders one sweep reminds, at most. */
const REMINDER_BATCH = 50;

/**
 * Push every rider who is over the cash limit or has held cash too long
 * (`rider_cash_limit` / `rider_cash_max_hours`; 0 switches a rule off), at most
 * once every 6 hours each. The throttle is claimed in `cash_reminders` with a
 * conditional write, so concurrent sweeps on several instances send one.
 *
 * Runs from the dispatch sweep and never throws: a database without 0085 or
 * 0047 sends nothing. Returns how many riders were reminded.
 */
export async function sendCashReminders(
  now: Date = new Date(),
  notify: typeof notifyRiderCashReminder = notifyRiderCashReminder
): Promise<number> {
  const supabase = createAdminClient();
  let thresholds: { limit: number; maxHours: number };
  try {
    thresholds = await readCashThresholds(supabase);
  } catch {
    return 0;
  }
  if (thresholds.limit <= 0 && thresholds.maxHours <= 0) return 0;

  const [collected, handed] = await Promise.all([
    readAllRows<{ id: string; driver_id: string | null; cod_collected_amount: number | null; cod_collected_at: string | null }>(
      (from, to) =>
        supabase
          .from("deliveries")
          .select("id, driver_id, cod_collected_amount, cod_collected_at")
          .not("cod_collected_amount", "is", null)
          .not("driver_id", "is", null)
          .order("id")
          .range(from, to)
          .overrideTypes<
            { id: string; driver_id: string | null; cod_collected_amount: number | null; cod_collected_at: string | null }[]
          >()
    ),
    readAllRows<{ id: string; from_user: string | null; amount: number; handover_date: string }>((from, to) =>
      supabase
        .from("cod_handovers")
        .select("id, from_user, amount, handover_date")
        .eq("leg", "rider_to_manager")
        .not("from_user", "is", null)
        .order("id")
        .range(from, to)
        .overrideTypes<{ id: string; from_user: string | null; amount: number; handover_date: string }[]>()
    ),
  ]);
  if (collected.error || handed.error) return 0;

  const collections = new Map<string, CashCollection[]>();
  for (const r of collected.data) {
    if (!r.driver_id || r.cod_collected_amount === null) continue;
    const list = collections.get(r.driver_id) ?? [];
    list.push({ amount: r.cod_collected_amount, at: r.cod_collected_at ?? "1970-01-01T00:00:00Z" });
    collections.set(r.driver_id, list);
  }
  const handovers = new Map<string, CashHandoverRow[]>();
  for (const r of handed.data) {
    if (!r.from_user) continue;
    const list = handovers.get(r.from_user) ?? [];
    list.push({ amount: r.amount, day: r.handover_date });
    handovers.set(r.from_user, list);
  }

  const due: { driverId: string; pending: number; reason: "limit" | "hours" | "both" }[] = [];
  for (const [driverId, rows] of collections) {
    const s = buildCashSummary(
      {
        toCollect: 0,
        collections: rows,
        handovers: handovers.get(driverId) ?? [],
        deposits: [],
        disputes: [],
        limit: thresholds.limit,
        maxHours: thresholds.maxHours,
      },
      now
    );
    const reason = reminderReason(s);
    if (reason) due.push({ driverId, pending: s.pending, reason });
  }
  if (due.length === 0) return 0;

  let sent = 0;
  for (const d of due.slice(0, REMINDER_BATCH)) {
    try {
      if (!(await claimReminder(supabase, d.driverId, now))) continue;
      await notify(d.driverId, { pending: d.pending, reason: d.reason, hours: thresholds.maxHours });
      sent++;
    } catch (e) {
      if (isMissingTable(e as { code?: string })) return sent;
      captureError(e, { source: "rider-cash", driverId: d.driverId, attrs: { event: "cash_reminder_failed" } });
    }
  }
  return sent;
}

/** First caller per rider per 6 hours wins. */
async function claimReminder(supabase: AdminClient, driverId: string, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const inserted = await supabase.from("cash_reminders").insert({ driver_id: driverId, last_sent_at: at }).select("driver_id");
  if (!inserted.error) return true;
  if (inserted.error.code !== "23505") throw inserted.error;
  const { data: row, error: readError } = await supabase
    .from("cash_reminders")
    .select("last_sent_at")
    .eq("driver_id", driverId)
    .maybeSingle()
    .overrideTypes<{ last_sent_at: string | null }>();
  if (readError) throw readError;
  if (!reminderDue(row?.last_sent_at, now)) return false;
  // Conditional on the value just read: a concurrent sweep that won leaves it changed.
  let update = supabase.from("cash_reminders").update({ last_sent_at: at }).eq("driver_id", driverId);
  update = row?.last_sent_at ? update.eq("last_sent_at", row.last_sent_at) : update.is("last_sent_at", null);
  const { data, error } = await update.select("driver_id").overrideTypes<{ driver_id: string }[]>();
  if (error) throw error;
  return (data ?? []).length > 0;
}
