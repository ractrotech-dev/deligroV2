import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readAllRows, readInChunks } from "@/lib/data-access/read-all";
import { isMissingColumn, isMissingTable } from "@/lib/data-access/schema-probe";
import { RiderSchemaPendingError, getRiderCode } from "@/lib/data-access/rider-status";
import { isCashOrder } from "@/lib/data-access/rider-delivery-actions";
import {
  notifyOpsCashDispute,
  notifyOpsDepositSubmitted,
  notifyRiderCashDisputeResolved,
  notifyRiderCashReminder,
  notifyRiderDepositDecided,
} from "@/lib/notifications/order-events";
import { createLinkedTicket } from "@/lib/data-access/support";
import { formatDay } from "@/lib/rider/admin-money";
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
 * Withdraw a deposit still waiting for a decision. Conditional on `submitted`:
 * the decision function locks the row, so a withdrawal racing a confirmation
 * waits, then finds the deposit decided and changes nothing.
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
    // 0085's cash_disputes_one_open_per_day: a report for the same day landed
    // between the check above and this insert.
    if (error && error.code === "23505") return { ok: false, error: "already_open" };
    throw error ?? new Error("dispute_not_saved");
  }

  // The dispute is also a support ticket (`cash_reconciliation`, linked by
  // cash_dispute_id) so the thread lives on the desk managers already work,
  // and ops are told. Best effort: the dispute stands whatever happens here.
  const claim = input.claimedAmount !== undefined ? `

The rider says the figure should be ₹${input.claimedAmount}.` : "";
  const ticket = await createLinkedTicket({
    requesterId: driverId,
    role: "rider",
    category: "cash_reconciliation",
    subject: `Cash dispute — ${formatDay(input.day)}`,
    body: `${message}${claim}`,
    cashDisputeId: data.id,
  });
  deferNotify(async () => {
    const { data: rider } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", driverId)
      .maybeSingle()
      .overrideTypes<{ full_name: string | null }>();
    await notifyOpsCashDispute({
      riderName: rider?.full_name,
      day: input.day,
      claimedAmount: input.claimedAmount ?? null,
      ticketNumber: ticket?.number ?? null,
    });
  });
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
  | {
      ok: true;
      /** Set when the amount confirmed is more than the cash the rider was recorded as holding. */
      warning?: { code: "exceeds_pending"; pending: number };
    }
  | {
      ok: false;
      error: "not_found" | "already_decided" | "note_required" | "manual_handover_exists";
      /** For `manual_handover_exists`: the IST day of the deposit (and of the handover written by hand). */
      day?: string;
    };

interface DepositRow {
  id: string;
  driver_id: string;
  amount: number;
  status: string;
  created_at: string;
}

/** The decision function is not in this database (0085 or 0152 not applied). */
function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    /could not find the function|does not exist/i.test(error.message ?? "")
  );
}

/**
 * A manager or admin decides a submitted deposit — by calling
 * `ops_decide_cash_deposit` (0085; the Manager branch's 0152 is the same
 * function with zone checks and an audit row), which in ONE transaction locks
 * the deposit, refuses one that is not `submitted`, and either disputes it
 * (the note the rider reads) or confirms it: the `cod_handovers` row
 * (`rider_to_manager`, from the rider, to the manager the rider named or else
 * the confirmer, recorded by the confirmer, dated to the day the rider
 * declared the deposit) is inserted and linked in the same statement set. There
 * is no claim step to leave half-done: a failure rolls everything back, and a
 * replayed or concurrent confirm finds the row decided.
 *
 * A handover already written by hand for that rider on the deposit's day is
 * refused (`manual_handover_exists`): confirming would count the same cash
 * twice. Dispute the deposit, or check the cash ledger.
 *
 * Authorization is the caller's (`requireRole(["manager", "admin"])`); the
 * function re-checks that `actor` is a manager or admin profile.
 */
export async function decideDeposit(
  actor: { id: string; role: "manager" | "admin" },
  id: string,
  decision: "confirm" | "dispute",
  note?: string
): Promise<DecideDepositResult> {
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (decision === "dispute" && (trimmed.length < 3 || trimmed.length > 500)) return { ok: false, error: "note_required" };
  if (!UUID.test(id)) return { ok: false, error: "not_found" };

  const supabase = createAdminClient();
  const { data: deposit, error: readError } = await supabase
    .from("cash_deposits")
    .select("id, driver_id, amount, status, created_at")
    .eq("id", id)
    .maybeSingle()
    .overrideTypes<DepositRow>();
  if (readError) failRead(readError);
  if (!deposit) return { ok: false, error: "not_found" };
  if (deposit.status !== "submitted") return { ok: false, error: "already_decided" };

  // What the rider holds BEFORE this confirmation, for the "more than they hold" warning. A failed read
  // only loses the warning; it never blocks the decision.
  let pendingBefore: number | null = null;
  if (decision === "confirm") {
    try {
      pendingBefore = buildCashSummary(await loadPosition(supabase, deposit.driver_id)).pending;
    } catch {
      pendingBefore = null;
    }
  }

  const { error } = await supabase.rpc("ops_decide_cash_deposit", {
    p_actor: actor.id,
    p_deposit: id,
    p_decision: decision,
    p_note: trimmed || null,
    p_zone: null,
    p_client_action_id: null,
  });
  if (error) {
    const message = error.message ?? "";
    if (/manual_handover_exists/.test(message)) return { ok: false, error: "manual_handover_exists", day: istDay(deposit.created_at) };
    if (/already_decided/.test(message)) return { ok: false, error: "already_decided" };
    if (/note_required/.test(message)) return { ok: false, error: "note_required" };
    // `forbidden` is also what the function answers for an unknown deposit: no oracle.
    if (error.code === "42501" || /forbidden/.test(message)) return { ok: false, error: "not_found" };
    if (isMissingFunction(error) || isMissingTable(error)) throw pending();
    throw error;
  }

  if (decision === "dispute") {
    deferNotify(() =>
      notifyRiderDepositDecided(deposit.driver_id, { amount: deposit.amount, status: "disputed", note: trimmed })
    );
    return { ok: true };
  }
  deferNotify(() => notifyRiderDepositDecided(deposit.driver_id, { amount: deposit.amount, status: "confirmed" }));
  return pendingBefore !== null && deposit.amount > pendingBefore
    ? { ok: true, warning: { code: "exceeds_pending", pending: pendingBefore } }
    : { ok: true };
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
  /** The IST day the rider declared it: the day a confirmation is dated to. */
  depositDay: string;
  /**
   * Rupees already recorded by hand (not through a deposit) as handed over by
   * this rider on `depositDay`. Above zero, confirming is refused
   * (`manual_handover_exists`): the same cash would count twice.
   */
  manualHandoverOnDay: number;
}

/** Submitted deposits, oldest first, with what a manager needs to decide. */
export async function listDepositQueue(): Promise<QueuedDeposit[]> {
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
  const days = [...new Set(rows.map((r) => istDay(r.created_at)))];
  const [handovers, linked] = await Promise.all([
    supabase
      .from("cod_handovers")
      .select("id, leg, from_user, amount, handover_date")
      .eq("leg", "rider_to_manager")
      .in("from_user", riderIds)
      .in("handover_date", days)
      .limit(1000)
      .overrideTypes<{ id: string; leg: string; from_user: string | null; amount: number; handover_date: string }[]>(),
    supabase
      .from("cash_deposits")
      .select("handover_id")
      .in("driver_id", riderIds)
      .not("handover_id", "is", null)
      .limit(1000)
      .overrideTypes<{ handover_id: string }[]>(),
  ]);
  if (handovers.error) throw handovers.error;
  if (linked.error) throw linked.error;
  // A handover a confirmed deposit produced is that deposit's, not one written by hand.
  const fromDeposits = new Set((linked.data ?? []).map((l) => l.handover_id));
  const manual = (handovers.data ?? [])
    .filter((h) => !fromDeposits.has(h.id))
    .map((h) => ({ leg: h.leg, fromUser: h.from_user, amount: h.amount, handoverDate: h.handover_date }));
  const codes = new Map<string, string | null>();
  await Promise.all(riderIds.map(async (id) => codes.set(id, await getRiderCode(id).catch(() => null))));

  return Promise.all(
    rows.map(async (r) => {
      const depositDay = istDay(r.created_at);
      return {
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
        depositDay,
        manualHandoverOnDay: sameDayHandoverTotal(manual, r.driver_id, depositDay),
      };
    })
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

/**
 * The dispute's linked ticket is closed with it, so the support desk does not
 * keep an answered dispute open. The rider is told once, by the cash notice,
 * not again by a ticket status push. Best effort.
 */
async function closeDisputeTicket(supabase: ReturnType<typeof createAdminClient>, disputeId: string): Promise<void> {
  try {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("support_tickets")
      .update({ status: "resolved", resolved_at: now, updated_at: now })
      .eq("cash_dispute_id", disputeId)
      .not("status", "in", "(resolved,closed)");
    if (error && !isMissingTable(error) && !isMissingColumn(error)) throw error;
  } catch (e) {
    captureError(e, { source: "rider-cash/dispute-ticket", attrs: { event: "dispute_ticket_not_closed" } });
  }
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
    .select("id, driver_id, day")
    .overrideTypes<{ id: string; driver_id: string; day: string }[]>();
  if (error) failRead(error);
  const won = (data ?? [])[0];
  if (won) {
    // Only the call that resolved it tells anyone (the update is conditional on "open").
    await closeDisputeTicket(supabase, won.id);
    deferNotify(() => notifyRiderCashDisputeResolved(won.driver_id, { day: won.day, resolution: text }));
    return { ok: true };
  }
  const { data: existing, error: readError } = await supabase
    .from("cash_disputes")
    .select("id")
    .eq("id", id)
    .maybeSingle()
    .overrideTypes<{ id: string }>();
  // An unreadable row is neither "resolved" nor "gone": say nothing rather than guess.
  if (readError) failRead(readError);
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
 *
 * The throttle, "still a rider" and "a deposit already waiting covers it"
 * filters are applied BEFORE the batch of 50 is cut, so skipped riders never
 * use up its places.
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

  const over: { driverId: string; pending: number; reason: "limit" | "hours" | "both" }[] = [];
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
    if (reason) over.push({ driverId, pending: s.pending, reason });
  }
  if (over.length === 0) return 0;

  // Who is not worth a push, decided BEFORE the batch is cut so that riders who
  // are throttled, no longer riders, or already deposited-and-waiting never use
  // up its places. Biggest holdings first.
  let awaiting = new Map<string, number>();
  let lastSent = new Map<string, string | null>();
  let riders = new Set<string>();
  try {
    const [deposits, reminders, profiles] = await Promise.all([
      readAllRows<{ id: string; driver_id: string; amount: number }>((from, to) =>
        supabase
          .from("cash_deposits")
          .select("id, driver_id, amount")
          .eq("status", "submitted")
          .order("id")
          .range(from, to)
          .overrideTypes<{ id: string; driver_id: string; amount: number }[]>()
      ),
      readAllRows<{ driver_id: string; last_sent_at: string | null }>((from, to) =>
        supabase
          .from("cash_reminders")
          .select("driver_id, last_sent_at")
          .order("driver_id")
          .range(from, to)
          .overrideTypes<{ driver_id: string; last_sent_at: string | null }[]>()
      ),
      readInChunks<{ id: string }>(
        over.map((o) => o.driverId),
        (chunk) =>
          supabase.from("profiles").select("id").in("id", chunk).eq("role", "driver").overrideTypes<{ id: string }[]>()
      ),
    ]);
    for (const result of [deposits, reminders, profiles]) {
      if (result.error) {
        if (isMissingTable(result.error as { code?: string })) return 0;
        throw result.error;
      }
    }
    awaiting = new Map();
    for (const d of deposits.data) awaiting.set(d.driver_id, (awaiting.get(d.driver_id) ?? 0) + d.amount);
    lastSent = new Map(reminders.data.map((r) => [r.driver_id, r.last_sent_at]));
    riders = new Set(profiles.data.map((p) => p.id));
  } catch (e) {
    captureError(e, { source: "rider-cash", attrs: { event: "cash_reminder_filters_failed" } });
    return 0;
  }
  const candidates = over
    .filter((o) => riders.has(o.driverId)) // a profile that is no longer a rider is not reminded
    .filter((o) => (awaiting.get(o.driverId) ?? 0) < o.pending) // a deposit already waiting for a manager covers it
    .filter((o) => reminderDue(lastSent.get(o.driverId), now)) // the 6-hour throttle
    .sort((a, b) => b.pending - a.pending);

  // The atomic claim still decides (two sweeps may have read the same state); go on down the list until
  // REMINDER_BATCH pushes have actually gone.
  let sent = 0;
  for (const d of candidates) {
    if (sent >= REMINDER_BATCH) break;
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
