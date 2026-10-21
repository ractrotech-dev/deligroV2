import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings-defaults";
import { deferNotify } from "@/lib/notifications/defer";
import {
  notifyDelivered,
  notifyOnTheWay,
  notifyRiderArrived,
  notifyRiderHandedOver,
} from "@/lib/notifications/order-events";
import { captureError } from "@/lib/obs/emit";
import { isPlausibleFix } from "@/lib/geo/fix";
import { assertRealType } from "@/lib/utils/file-signature";
import { DISPATCH_COLUMNS } from "@/lib/dispatch/rider-dispatch";
import {
  HANDOVER_COLUMNS,
  LOCATION_SOURCE_COLUMN,
  PAYMENT_COLUMNS,
  latchFor,
  paymentInstruction,
} from "@/lib/data-access/driver-orders";
import { RiderSchemaPendingError } from "@/lib/data-access/rider-status";
import {
  columnKnownMissing,
  isMissingColumn,
  isMissingTable,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import {
  isMissingColumnOnWrite,
  writeWithColumnFallback,
} from "@/lib/data-access/column-fallback";
import {
  checkAction,
  podPhotoRequired,
  type DeliverMethod,
  type MachineState,
  type PickupMethod,
  type RiderAction,
} from "@/lib/rider/delivery-machine";
import type { PaymentMethod, PaymentStatus, PlatformSettings, PodPhotoRule } from "@/types";

/**
 * A rider's steps on a delivery they hold — arrival at the shop, pickup, the
 * trip, arrival at the door, delivery — plus the proof photo, the logged call,
 * and the vendor's "Handed to rider". The rules for which step is legal live in
 * `lib/rider/delivery-machine.ts`; this module reads the state, asks them, and
 * writes.
 *
 * ## Authorization
 *
 * Every function runs on the service-role client (a rider's JWT cannot write
 * `deliveries`), so the caller authenticates: `/api/rider/deliveries/*` derive
 * `driverId` from the session behind `requireRiderApi()`, the web portal's
 * `advanceDelivery` from `requireDriver()`, and the vendor route `ownerId` from
 * `getProfile()` behind `hasVendorAccess()`. What a caller may touch is then
 * decided here, by that id and nothing in the request: a delivery is acted on
 * only when `deliveries.driver_id` is the caller (`not_yours` otherwise), and a
 * handover only when the order's shop is owned by the caller.
 *
 * ## Replays
 *
 * Each step carries the app's per-tap `actionId`, written to
 * `deliveries.last_action_id` in the same update; the audit trigger copies it
 * onto the event, whose unique index turns a replayed tap into 23505 — answered
 * as `{ ok: true, duplicate: true }`. A replay does not always get that far:
 * every step's write is conditional (the leg, and for a stamp "still empty"),
 * and a step whose result is already on the row is answered as a duplicate
 * before anything is written. A guard refusal (23514) whose re-read shows the
 * step's result is a duplicate too: the other tap won.
 *
 * ## Before 0081 / 0082
 *
 * Pickup and delivery are the web portal's two steps and keep working on a
 * database without 0081: the 0081 columns (`pickup_method`, `delivery_method`,
 * `last_action_id`) are dropped from the write by the column fallback. The three
 * stamp steps, a manual pickup, the proof photo and the contact log have
 * nowhere to be recorded without 0081/0082, so they throw
 * `RiderSchemaPendingError` (the routes answer 503 `migration_pending`).
 */

type AdminClient = ReturnType<typeof createAdminClient>;
type PgError = { code?: string; message?: string };

/** Postgres check_violation — what guard_delivery_transition (0081/0082) raises. */
const CHECK_VIOLATION = "23514";
/** Postgres unique_violation — a replayed action id (delivery_events_client_action_idx). */
const UNIQUE_VIOLATION = "23505";
/** `deliveries.pod_photo_path` arrives with 0082. */
const POD_PHOTO_COLUMN = "deliveries.pod_photo_path";
/** `deliveries.cod_collected_amount` / `cod_collected_at` arrive together with 0047. */
const COD_COLLECTED_COLUMN = "deliveries.cod_collected_amount";

const PROOF_BUCKET = "delivery-proofs";
const PROOF_TYPES: Record<string, "jpg" | "png"> = { "image/jpeg": "jpg", "image/png": "png" };
/** The bucket's own limit (0082), checked first so a large upload is refused before it is sent. */
const MAX_PROOF_BYTES = 5 * 1024 * 1024;

export type DeliveryActionError =
  | "bad_state"
  | "order_not_active"
  | "bad_pickup_otp"
  | "bad_otp"
  | "photo_required"
  | "manual_not_approved"
  | "not_yours";

export type DeliveryActionResult =
  | { ok: true; duplicate?: boolean }
  | { ok: false; error: DeliveryActionError };

export interface DeliveryActionInput {
  action: RiderAction;
  /** The app's id for this tap (a UUID). The web portal generates one per call. */
  actionId: string;
  /** The pickup code (code / qr) or the customer's delivery code. */
  code?: string;
  method?: PickupMethod | DeliverMethod;
  /** The proof photo's path, as `uploadDeliveryProof` returned it. */
  photoPath?: string;
  lat?: number;
  lng?: number;
}

/** Who is told what. Production uses the push senders; tests pass recorders. */
export interface DeliveryNotifier {
  onTheWay: (orderId: string) => Promise<unknown>;
  delivered: (orderId: string) => Promise<unknown>;
  riderArrived: (orderId: string, riderName: string | null) => Promise<unknown>;
  riderHandedOver: (driverId: string, orderId: string) => Promise<unknown>;
}

const PUSH: DeliveryNotifier = {
  onTheWay: notifyOnTheWay,
  delivered: notifyDelivered,
  riderArrived: notifyRiderArrived,
  riderHandedOver: notifyRiderHandedOver,
};

/**
 * Seams for tests. Production passes nothing: the proof-photo rule comes from
 * settings (which need a request scope) and the notifications are pushes.
 */
export interface DeliveryActionOptions {
  settings?: PlatformSettings;
  notify?: Partial<DeliveryNotifier>;
}

function notifierOf(override?: Partial<DeliveryNotifier>): DeliveryNotifier {
  return { ...PUSH, ...override };
}

const DUPLICATE: DeliveryActionResult = { ok: true, duplicate: true };
const fail = (error: DeliveryActionError): DeliveryActionResult => ({ ok: false, error });
const digits = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "");

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

interface DeliveryRow {
  id: string;
  order_id: string;
  status: string;
  driver_id: string | null;
  picked_up_at: string | null;
  arrived_pickup_at?: string | null;
  departed_pickup_at?: string | null;
  arrived_drop_at?: string | null;
  pod_photo_path?: string | null;
}

/** Which of the rider-app migrations the delivery row was read with. */
type Schema = "base" | "0081" | "0082";

const ROW_BASE = "id, order_id, status, driver_id, picked_up_at";
const ROW_0081 = `${ROW_BASE}, arrived_pickup_at, departed_pickup_at, arrived_drop_at`;
const ROW_0082 = `${ROW_0081}, pod_photo_path`;

/**
 * The order's delivery row, on whatever columns this database has.
 *
 * Probed newest first on every call rather than trusting the per-process latch:
 * a stamp step must not be refused as "migration pending" by an instance that
 * last looked before the migration ran. On a migrated database that is one
 * request; the fallbacks cost only an un-migrated one.
 */
async function readDeliveryRow(
  supabase: AdminClient,
  orderId: string
): Promise<{ row: DeliveryRow | null; schema: Schema }> {
  const attempts: [Schema, string][] = [
    ["0082", ROW_0082],
    ["0081", ROW_0081],
    ["base", ROW_BASE],
  ];
  for (const [schema, columns] of attempts) {
    const { data, error } = await supabase
      .from("deliveries")
      .select(columns)
      .eq("order_id", orderId)
      .maybeSingle()
      .overrideTypes<DeliveryRow>();
    if (!error) {
      if (schema !== "base") rememberColumn(HANDOVER_COLUMNS, true);
      if (schema === "0082") rememberColumn(POD_PHOTO_COLUMN, true);
      return { row: data, schema };
    }
    if (!isMissingColumn(error)) throw error;
    rememberColumn(schema === "0082" ? POD_PHOTO_COLUMN : HANDOVER_COLUMNS, false);
  }
  throw new Error("unreachable: the base delivery columns predate every migration here");
}

interface OrderRow {
  status: string;
  pickup_otp: string | null;
  delivery_otp: string | null;
  total: number | null;
  payment_method?: PaymentMethod | null;
  payment_status?: PaymentStatus | null;
}

/**
 * The order row a step needs: its status, both handover codes, and how it is
 * paid. Service role, so the two codes (column-revoked from `authenticated`
 * since 0058) are readable; neither ever leaves this module. The payment pair is
 * probed — 0025 may not be applied — and its absence means every order is cash.
 */
async function readOrder(
  supabase: AdminClient,
  orderId: string
): Promise<{ order: OrderRow | null; paymentColumns: boolean }> {
  const read = (columns: string) =>
    supabase.from("orders").select(columns).eq("id", orderId).maybeSingle().overrideTypes<OrderRow>();

  if (!columnKnownMissing(PAYMENT_COLUMNS)) {
    const { data, error } = await read(
      "status, pickup_otp, delivery_otp, total, payment_method, payment_status"
    );
    if (!error) {
      rememberColumn(PAYMENT_COLUMNS, true);
      return { order: data, paymentColumns: true };
    }
    if (!isMissingColumn(error)) throw error;
    rememberColumn(PAYMENT_COLUMNS, false);
  }
  const { data, error } = await read("status, pickup_otp, delivery_otp, total");
  if (error) throw error;
  return { order: data, paymentColumns: false };
}

function machineState(row: DeliveryRow, order: OrderRow | null): MachineState {
  return {
    status: row.status as MachineState["status"],
    arrivedPickupAt: row.arrived_pickup_at ?? null,
    departedPickupAt: row.departed_pickup_at ?? null,
    arrivedDropAt: row.arrived_drop_at ?? null,
    // An order row that is gone is an order nobody can deliver.
    orderStatus: order?.status ?? "cancelled",
  };
}

/** Cash at the door, decided by the same rule as the rider's board. */
function collectsCash(order: OrderRow, paymentColumns: boolean): boolean {
  return (
    paymentInstruction({
      pickupOtp: null,
      method: order.payment_method ?? null,
      status: order.payment_status ?? null,
      paymentColumns,
      found: true,
    }) === "collect"
  );
}

/** An approved request of `kind` raised by this rider on this delivery (0082). */
async function hasApprovedException(
  supabase: AdminClient,
  deliveryId: string,
  driverId: string,
  kind: "manual_pickup" | "complete_without_code"
): Promise<boolean> {
  const { data, error } = await supabase
    .from("delivery_exceptions")
    .select("id")
    .eq("delivery_id", deliveryId)
    .eq("driver_id", driverId)
    .eq("kind", kind)
    .eq("status", "approved")
    .limit(1)
    .overrideTypes<{ id: string }[]>();
  if (error) {
    if (isMissingTable(error)) throw new RiderSchemaPendingError();
    throw error;
  }
  return (data ?? []).length > 0;
}

/**
 * The proof-photo rule in force. A settings read that throws (it should not:
 * `getSettings` serves its own fallback) uses the default rule rather than
 * stranding a rider at the door with the food; the failure is reported.
 */
async function podRule(opts: DeliveryActionOptions): Promise<PodPhotoRule> {
  if (opts.settings) return opts.settings.podPhotoRule;
  try {
    return (await getSettings()).podPhotoRule;
  } catch (e) {
    captureError(e, { source: "rider-delivery-actions/podRule", attrs: { event: "settings_unreadable" } });
    return DEFAULT_SETTINGS.podPhotoRule;
  }
}

// ---------------------------------------------------------------------------
// the write
// ---------------------------------------------------------------------------

interface Step {
  deliveryId: string;
  driverId: string;
  /** The optimistic lock: the leg the row must still be on. */
  fromStatus: "assigned" | "picked_up";
  /** Written on every database (a stamp step only runs where its column exists). */
  fields: Record<string, unknown>;
  /** 0081: how the step was proved, and the tap's id. Dropped where 0081 is not applied. */
  v0081: Record<string, unknown>;
  /** 0082 (`pod_photo_path`). Dropped where 0082 is not applied. */
  v0082?: Record<string, unknown>;
  /** Only while these columns are still empty: a stamp is set once. */
  whileNull?: string[];
  /** Where the rider was: written in the same update, so the event carries it. */
  position?: { lat: number; lng: number } | null;
}

/**
 * One conditional update of the delivery row, through the column fallbacks.
 *
 * Nested oldest outside, newest inside, for the reason `writeAcceptRow` gives:
 * PostgREST names one missing column per answer, and a layer that latches its
 * own column wrongly can only be wrong in the direction that is also true (no
 * 0081 means no 0082). The 0081 layer re-probes on the guard's 23514 — the
 * guard only exists where 0081 does. The position layer (0026's
 * `driver_location_source`) runs only when there is a position to write.
 */
async function writeStep(
  supabase: AdminClient,
  step: Step
): Promise<{ moved: boolean; error: PgError | null }> {
  const at = new Date().toISOString();
  const run = (source: boolean, handover: boolean, pod: boolean) => {
    let query = supabase
      .from("deliveries")
      .update({
        ...step.fields,
        ...(handover ? step.v0081 : {}),
        ...(handover && pod ? (step.v0082 ?? {}) : {}),
        ...(step.position
          ? {
              driver_lat: step.position.lat,
              driver_lng: step.position.lng,
              driver_location_at: at,
              ...(source ? { driver_location_source: "gps" } : {}),
            }
          : {}),
      })
      .eq("id", step.deliveryId)
      .eq("driver_id", step.driverId)
      .eq("status", step.fromStatus);
    for (const column of step.whileNull ?? []) query = query.is(column, null);
    return query.select("id").overrideTypes<{ id: string }[]>();
  };
  const inner = (source: boolean) =>
    writeWithColumnFallback(
      latchFor(HANDOVER_COLUMNS),
      (handover) =>
        writeWithColumnFallback(latchFor(POD_PHOTO_COLUMN), (pod) => run(source, handover, pod)),
      (e) => e.code === CHECK_VIOLATION
    );
  const result = step.position
    ? await writeWithColumnFallback(latchFor(LOCATION_SOURCE_COLUMN), inner)
    : await inner(false);
  return { moved: (result.data ?? []).length > 0, error: result.error };
}

/** The write lost a race (no row matched): read again and decide. */
const LOST = Symbol("lost");
type Attempt = DeliveryActionResult | typeof LOST;

interface Loaded {
  row: DeliveryRow;
  schema: Schema;
  order: OrderRow | null;
  paymentColumns: boolean;
  state: MachineState;
}

async function load(
  supabase: AdminClient,
  driverId: string,
  orderId: string
): Promise<{ ok: true; loaded: Loaded } | { ok: false; result: DeliveryActionResult }> {
  const { row, schema } = await readDeliveryRow(supabase, orderId);
  if (!row || row.driver_id !== driverId) return { ok: false, result: fail("not_yours") };
  const { order, paymentColumns } = await readOrder(supabase, orderId);
  return { ok: true, loaded: { row, schema, order, paymentColumns, state: machineState(row, order) } };
}

/**
 * After the guard refused a write (23514): if the step's result is on the row
 * now, the other tap won and this one is a duplicate; otherwise the refusal
 * stands, as `refused` unless the state itself now says why.
 */
async function resolveRefusal(
  supabase: AdminClient,
  driverId: string,
  orderId: string,
  action: RiderAction,
  refused: DeliveryActionError
): Promise<DeliveryActionResult> {
  const again = await load(supabase, driverId, orderId);
  if (!again.ok) return again.result;
  const check = checkAction(again.loaded.state, action);
  if (!check.ok) return check.error === "already_done" ? DUPLICATE : fail(check.error);
  return fail(refused);
}

/** What a failed step write means. Never returns for an error it cannot place. */
async function settleWrite(
  supabase: AdminClient,
  driverId: string,
  orderId: string,
  action: RiderAction,
  write: { moved: boolean; error: PgError | null },
  refused: DeliveryActionError = "bad_state"
): Promise<Attempt | "moved"> {
  if (write.error) {
    if (write.error.code === UNIQUE_VIOLATION) return DUPLICATE;
    if (write.error.code === CHECK_VIOLATION) {
      return resolveRefusal(supabase, driverId, orderId, action, refused);
    }
    if (isMissingColumnOnWrite(write.error)) throw new RiderSchemaPendingError();
    throw write.error;
  }
  return write.moved ? "moved" : LOST;
}

// ---------------------------------------------------------------------------
// the steps
// ---------------------------------------------------------------------------

/**
 * Perform one of the rider's steps on the delivery they hold.
 *
 * Reads the row and the order, asks `checkAction`, validates what the step
 * needs (the code, the approval, the photo), then writes. A write that loses a
 * race (no row matched) is re-read and tried once more: the re-read answers a
 * replay as a duplicate, a cancelled order as `order_not_active`, and a still
 * legal step gets its second attempt. See the module header for replays.
 */
export async function performDeliveryAction(
  driverId: string,
  orderId: string,
  input: DeliveryActionInput,
  opts: DeliveryActionOptions = {}
): Promise<DeliveryActionResult> {
  const supabase = createAdminClient();
  const position =
    isPlausibleFix(input.lat, input.lng) ? { lat: input.lat as number, lng: input.lng as number } : null;

  for (let attempt = 0; ; attempt++) {
    const loaded = await load(supabase, driverId, orderId);
    if (!loaded.ok) return loaded.result;
    const check = checkAction(loaded.loaded.state, input.action);
    if (!check.ok) return check.error === "already_done" ? DUPLICATE : fail(check.error);
    // Two lost races in a row: something else keeps moving this row. The app
    // re-reads the board rather than this loop chasing it.
    if (attempt >= 2) return fail("bad_state");

    const outcome = await applyStep(supabase, driverId, orderId, input, loaded.loaded, position, opts);
    if (outcome !== LOST) return outcome;
  }
}

async function applyStep(
  supabase: AdminClient,
  driverId: string,
  orderId: string,
  input: DeliveryActionInput,
  { row, schema, order, paymentColumns }: Loaded,
  position: { lat: number; lng: number } | null,
  opts: DeliveryActionOptions
): Promise<Attempt> {
  const notify = notifierOf(opts.notify);
  const now = new Date().toISOString();
  const base = { deliveryId: row.id, driverId, position };
  const tap = { last_action_id: input.actionId };

  switch (input.action) {
    case "arrive_pickup":
    case "start_trip":
    case "arrive_drop": {
      if (schema === "base") throw new RiderSchemaPendingError();
      const stamp =
        input.action === "arrive_pickup"
          ? { arrived_pickup_at: now }
          : input.action === "start_trip"
            ? { departed_pickup_at: now }
            : {
                arrived_drop_at: now,
                // Riders forget "Start trip"; the door proves they left the shop.
                ...(row.departed_pickup_at ? {} : { departed_pickup_at: now }),
              };
      const write = await writeStep(supabase, {
        ...base,
        fromStatus: input.action === "arrive_pickup" ? "assigned" : "picked_up",
        fields: stamp,
        v0081: tap,
        whileNull: Object.keys(stamp),
      });
      const settled = await settleWrite(supabase, driverId, orderId, input.action, write);
      if (settled !== "moved") return settled;
      if (input.action === "arrive_drop") await announceArrival(supabase, row.id, driverId, orderId, notify);
      return { ok: true };
    }

    case "pickup": {
      if (!order) return fail("order_not_active");
      const method = (input.method ?? "code") as PickupMethod;
      let pickupMethod: string;
      if (method === "manual") {
        if (!(await hasApprovedException(supabase, row.id, driverId, "manual_pickup"))) {
          return fail("manual_not_approved");
        }
        pickupMethod = "manual";
      } else {
        // Exactly the check the web portal has always made: the counter's code,
        // digits only. A QR scan encodes the same code, so the check is the
        // same; an order with no code recorded stays ungated, recorded `none`.
        const expected = digits(order.pickup_otp);
        if (expected && digits(input.code) !== expected) return fail("bad_pickup_otp");
        pickupMethod = expected ? method : "none";
      }

      // The order moves first, conditional on still being `ready`: an order the
      // vendor cancelled under the rider is never resurrected to on_the_way. An
      // order already on_the_way (a previous attempt whose delivery write was
      // lost) is left as it is, so the retry can finish the delivery row.
      if (order.status === "ready") {
        const { data: moved, error } = await supabase
          .from("orders")
          .update({ status: "on_the_way" })
          .eq("id", orderId)
          .eq("status", "ready")
          .select("id")
          .overrideTypes<{ id: string }[]>();
        if (error) throw error;
        if ((moved ?? []).length === 0) return LOST;
      }

      const write = await writeStep(supabase, {
        ...base,
        fromStatus: "assigned",
        fields: { status: "picked_up", picked_up_at: now },
        v0081: { pickup_method: pickupMethod, ...tap },
      });
      const settled = await settleWrite(
        supabase,
        driverId,
        orderId,
        "pickup",
        write,
        method === "manual" ? "manual_not_approved" : "bad_state"
      );
      if (settled !== "moved") return settled;
      deferNotify(() => notify.onTheWay(orderId));
      return { ok: true };
    }

    case "deliver": {
      if (!order) return fail("order_not_active");
      const method = (input.method ?? "code") as DeliverMethod;
      const expected = digits(order.delivery_otp);
      if (method === "code" && (!expected || digits(input.code) !== expected)) return fail("bad_otp");
      // A photo stands in for the code only where the order has no code to
      // check. Where it has one, the customer's code is the proof, and a photo
      // of a doorstep is not a substitute for the customer.
      if (method === "photo" && expected) return fail("bad_otp");
      if (
        method === "ops_approved" &&
        !(await hasApprovedException(supabase, row.id, driverId, "complete_without_code"))
      ) {
        return fail("bad_state");
      }

      const needsPhoto =
        method === "photo" ||
        podPhotoRequired(await podRule(opts), {
          isCod: collectsCash(order, paymentColumns),
          viaException: method === "ops_approved",
        });
      // Only a photo uploaded for THIS delivery (the path the upload recorded)
      // counts — never a path the app names on its own.
      if (needsPhoto && (!input.photoPath || !row.pod_photo_path || input.photoPath !== row.pod_photo_path)) {
        return fail("photo_required");
      }

      return completeDelivery(
        supabase,
        { id: row.id, orderId, driverId },
        { method, actorId: driverId, actionId: input.actionId, position, notify: opts.notify }
      );
    }
  }
}

/**
 * The customer is told the rider is at the door — the second and final notice
 * — and the proximity latch (`arrival_notified_at`, 0042) is set so the
 * position-based "arriving" push cannot follow it. Best-effort.
 */
async function announceArrival(
  supabase: AdminClient,
  deliveryId: string,
  driverId: string,
  orderId: string,
  notify: DeliveryNotifier
): Promise<void> {
  try {
    if (!columnKnownMissing(DISPATCH_COLUMNS)) {
      const { error } = await supabase
        .from("deliveries")
        .update({ arrival_notified_at: new Date().toISOString() })
        .eq("id", deliveryId)
        .is("arrival_notified_at", null);
      if (error && isMissingColumnOnWrite(error)) rememberColumn(DISPATCH_COLUMNS, false);
    }
    const { data: rider } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", driverId)
      .maybeSingle()
      .overrideTypes<{ full_name: string | null }>();
    const name = rider?.full_name?.trim() || null;
    deferNotify(() => notify.riderArrived(orderId, name));
  } catch (e) {
    captureError(e, { source: "rider-delivery-actions/arrival", orderId, driverId, attrs: { event: "arrival_notice" } });
  }
}

export interface CompleteDeliveryTarget {
  /** `deliveries.id`. */
  id: string;
  orderId: string;
  /** The rider on the delivery. The write is conditional on it still being theirs. */
  driverId: string;
}

export interface CompleteDeliveryOptions {
  /** How the delivery was proved. The caller has already checked it. */
  method: DeliverMethod;
  /** Who completed it: the rider, or the manager/admin who approved it. For the logs. */
  actorId: string;
  /** A proof photo's path in `delivery-proofs`, recorded on the row (0082). */
  photoPath?: string;
  /** The rider's tap id, when a tap is what completed it. */
  actionId?: string;
  position?: { lat: number; lng: number } | null;
  notify?: Partial<DeliveryNotifier>;
}

/**
 * Complete a picked-up delivery: the order to `delivered`, the delivery to
 * `delivered` with how it was proved, the cash-on-delivery record, and the
 * customer's push. The one implementation of "it was delivered" (ruling P2-R1):
 * the rider's `deliver` step calls it after checking the code and the photo,
 * and an ops approval of `complete_without_code` calls it with
 * `method: "ops_approved"`.
 *
 * It checks state, not proof: the caller has verified the code, the approval
 * or the photo rule. Idempotent: a delivery already delivered answers
 * `{ ok: true, duplicate: true }` and changes nothing, so neither a replayed tap
 * nor an approval racing the rider's own code records the cash twice.
 *
 * The order moves first, conditional on `on_the_way` — an order cancelled under
 * the rider is not resurrected — and an order already `delivered` (by staff, or
 * by an attempt whose delivery write was lost) is left as it is so this can
 * finish the delivery row.
 *
 * Deliberately NOT touching `payment_status`. A COD order that reaches here is
 * cash in a rider's pocket, and there is no reconciliation behind the word
 * "paid" yet: writing it would assert a control that does not exist. An online
 * order still `pending` is a real anomaly and stays visible as one.
 */
export async function completeDelivery(
  supabase: AdminClient,
  delivery: CompleteDeliveryTarget,
  opts: CompleteDeliveryOptions
): Promise<{ ok: true; duplicate?: boolean } | { ok: false; error: "order_not_active" | "bad_state" }> {
  const notify = notifierOf(opts.notify);

  const current = await deliveryStatus(supabase, delivery.id);
  if (current?.status === "delivered") return { ok: true, duplicate: true };
  if (!current || current.status === "cancelled" || current.status === "failed") {
    return { ok: false, error: "order_not_active" };
  }
  if (current.status !== "picked_up" || current.driver_id !== delivery.driverId) {
    return { ok: false, error: "bad_state" };
  }

  const { order } = await readOrder(supabase, delivery.orderId);
  if (!order) return { ok: false, error: "order_not_active" };
  if (order.status === "on_the_way") {
    const { data: moved, error } = await supabase
      .from("orders")
      .update({ status: "delivered" })
      .eq("id", delivery.orderId)
      .eq("status", "on_the_way")
      .select("id")
      .overrideTypes<{ id: string }[]>();
    if (error) throw error;
    if ((moved ?? []).length === 0) {
      // Somebody moved it first: fine if that was to delivered (the other tap).
      const { order: now } = await readOrder(supabase, delivery.orderId);
      if (now?.status !== "delivered") return { ok: false, error: "order_not_active" };
    }
  } else if (order.status !== "delivered") {
    return { ok: false, error: "order_not_active" };
  }

  const write = await writeStep(supabase, {
    deliveryId: delivery.id,
    driverId: delivery.driverId,
    fromStatus: "picked_up",
    fields: { status: "delivered", delivered_at: new Date().toISOString() },
    v0081: {
      delivery_method: opts.method,
      ...(opts.actionId ? { last_action_id: opts.actionId } : {}),
    },
    v0082: opts.photoPath ? { pod_photo_path: opts.photoPath } : undefined,
    position: opts.position ?? null,
  });

  if (write.error) {
    if (write.error.code === UNIQUE_VIOLATION) return { ok: true, duplicate: true };
    if (isMissingColumnOnWrite(write.error)) throw new RiderSchemaPendingError();
    if (write.error.code !== CHECK_VIOLATION) throw write.error;
    captureError(write.error, {
      source: "rider-delivery-actions/complete",
      orderId: delivery.orderId,
      driverId: delivery.driverId,
      attrs: { event: "delivered_refused", method: opts.method, actorId: opts.actorId },
    });
  }
  if (write.error || !write.moved) {
    const after = await deliveryStatus(supabase, delivery.id);
    if (after?.status === "delivered") return { ok: true, duplicate: true };
    if (!after || after.status === "cancelled" || after.status === "failed") {
      return { ok: false, error: "order_not_active" };
    }
    return { ok: false, error: "bad_state" };
  }

  await recordCodCollection(supabase, delivery.id, order);
  deferNotify(() => notify.delivered(delivery.orderId));
  return { ok: true };
}

async function deliveryStatus(
  supabase: AdminClient,
  deliveryId: string
): Promise<{ status: string; driver_id: string | null } | null> {
  const { data, error } = await supabase
    .from("deliveries")
    .select("status, driver_id")
    .eq("id", deliveryId)
    .maybeSingle()
    .overrideTypes<{ status: string; driver_id: string | null }>();
  if (error) throw error;
  return data;
}

/**
 * Digital record of cash collected at the door, for a cash-on-delivery order.
 *
 * The physical cash stays with the rider until the next handover (see
 * cod-handovers.ts) — this write does not move money, it records that a
 * collection happened and for how much. An online-paid order has nothing to
 * collect and is left alone; with no payment columns at all (pre-0025) every
 * order was cash by construction.
 *
 * Once only (`cod_collected_at is null`), so a second completion path can never
 * overwrite the first. Best-effort: a delivery must complete whether or not this
 * write succeeds. The columns are 0047's, and a write naming them on a database
 * without them answers PGRST204, not 42703 — `writeWithColumnFallback` knows
 * both (the old version checked 42703 only and silently skipped on PGRST204).
 */
export async function recordCodCollection(
  supabase: AdminClient,
  deliveryId: string,
  order: { total: number | null; payment_method?: PaymentMethod | null } | null
): Promise<void> {
  const isCod = order?.payment_method == null || order.payment_method === "cod";
  if (!isCod) return;

  try {
    const { error } = await writeWithColumnFallback(latchFor(COD_COLLECTED_COLUMN), (withCod) =>
      withCod
        ? supabase
            .from("deliveries")
            .update({
              cod_collected_amount: order?.total ?? 0,
              cod_collected_at: new Date().toISOString(),
            })
            .eq("id", deliveryId)
            .is("cod_collected_at", null)
        : Promise.resolve({ error: null as PgError | null })
    );
    if (error) throw error;
  } catch (e) {
    // Never let a reporting write turn a completed delivery into a failed one —
    // but say so: a missing cash record is what the rider's ledger is built on.
    captureError(e, {
      source: "rider-delivery-actions/cod",
      attrs: { event: "cod_record_failed", deliveryId },
    });
  }
}

// ---------------------------------------------------------------------------
// proof photo, contact, vendor handover
// ---------------------------------------------------------------------------

async function removeProofs(supabase: AdminClient, paths: string[]): Promise<void> {
  try {
    await supabase.storage.from(PROOF_BUCKET).remove(paths);
  } catch {
    // an orphan in a private bucket is housekeeping (the 90-day cron), not a failure
  }
}

/**
 * Store a proof-of-delivery photo for the delivery this rider is carrying.
 *
 * JPEG or PNG, at most 5 MB, checked by its bytes (`assertRealType`), not only
 * by what the phone declared. The path is `<deliveryId>/<uuid>.<ext>` — built
 * here, never from the request — in the private `delivery-proofs` bucket, and
 * it is recorded on `deliveries.pod_photo_path`, which is what `deliver`
 * compares the app's `photoPath` against. Only while the rider holds the
 * delivery at `picked_up`. A retake replaces the path and removes the old file.
 */
export async function uploadDeliveryProof(
  driverId: string,
  orderId: string,
  file: File
): Promise<{ ok: true; path: string } | { ok: false; error: "bad_type" | "too_large" | "not_yours" | "bad_state" }> {
  const ext = PROOF_TYPES[file.type];
  if (!ext || file.size === 0) return { ok: false, error: "bad_type" };
  if (file.size > MAX_PROOF_BYTES) return { ok: false, error: "too_large" };

  const supabase = createAdminClient();
  const { row, schema } = await readDeliveryRow(supabase, orderId);
  if (!row || row.driver_id !== driverId) return { ok: false, error: "not_yours" };
  if (row.status !== "picked_up") return { ok: false, error: "bad_state" };
  if (schema !== "0082") throw new RiderSchemaPendingError();

  try {
    await assertRealType(file, ["image/jpeg", "image/png"]);
  } catch {
    return { ok: false, error: "bad_type" };
  }

  const path = `${row.id}/${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from(PROOF_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) {
    if (/bucket not found/i.test(uploadError.message)) throw new RiderSchemaPendingError();
    throw uploadError;
  }

  const { data, error } = await supabase
    .from("deliveries")
    .update({ pod_photo_path: path })
    .eq("id", row.id)
    .eq("driver_id", driverId)
    .eq("status", "picked_up")
    .select("id")
    .overrideTypes<{ id: string }[]>();
  if (error || (data ?? []).length === 0) {
    await removeProofs(supabase, [path]);
    if (error) {
      if (isMissingColumnOnWrite(error)) {
        rememberColumn(POD_PHOTO_COLUMN, false);
        throw new RiderSchemaPendingError();
      }
      throw error;
    }
    // Delivered, cancelled or reassigned between the read and the write.
    return { ok: false, error: "bad_state" };
  }

  const previous = row.pod_photo_path;
  if (previous && previous !== path && previous.startsWith(`${row.id}/`)) {
    await removeProofs(supabase, [previous]);
  }
  return { ok: true, path };
}

/**
 * Log that the rider called the customer or the shop — the `contact_attempt`
 * event that `customer_unreachable` waits on (Task 4). Only for the rider
 * holding the delivery while it is live. The position is the delivery row's
 * last fix, the same one the audit trigger puts on every other event.
 */
export async function logContactAttempt(
  driverId: string,
  orderId: string,
  target: "customer" | "vendor"
): Promise<{ ok: true } | { ok: false; error: "not_yours" | "bad_state" }> {
  const supabase = createAdminClient();
  const { data: row, error } = await supabase
    .from("deliveries")
    .select("id, status, driver_id, driver_lat, driver_lng")
    .eq("order_id", orderId)
    .maybeSingle()
    .overrideTypes<{
      id: string;
      status: string;
      driver_id: string | null;
      driver_lat: number | null;
      driver_lng: number | null;
    }>();
  if (error) throw error;
  if (!row || row.driver_id !== driverId) return { ok: false, error: "not_yours" };
  if (row.status !== "assigned" && row.status !== "picked_up") return { ok: false, error: "bad_state" };

  const { error: insertError } = await supabase.from("delivery_events").insert({
    delivery_id: row.id,
    order_id: orderId,
    driver_id: driverId,
    kind: "contact_attempt",
    method: target,
    lat: row.driver_lat,
    lng: row.driver_lng,
  });
  if (insertError) {
    // No table (0081), or the kind not allowed yet (0081 without 0082).
    if (isMissingTable(insertError) || insertError.code === CHECK_VIOLATION) {
      throw new RiderSchemaPendingError();
    }
    throw insertError;
  }
  return { ok: true };
}

/**
 * The vendor taps "Handed to rider": the pickup is recorded on the vendor's
 * word (`pickup_method = 'vendor'`), the order goes `on_the_way`, the customer
 * hears it is on the way and the rider that the shop confirmed the handover.
 *
 * Only for the owner of the order's shop (`not_yours` otherwise — the route
 * has already checked vendor access, this checks this order). Only while a
 * rider holds the delivery at `assigned` and the kitchen has the order ready
 * (`no_rider` / `bad_state`). A second tap, or a tap after the rider already
 * entered the code, is `ok`: the food has been handed over either way.
 */
export async function vendorConfirmHandover(
  ownerId: string,
  orderId: string,
  opts: { notify?: Partial<DeliveryNotifier> } = {}
): Promise<{ ok: true } | { ok: false; error: "not_yours" | "no_rider" | "bad_state" }> {
  const notify = notifierOf(opts.notify);
  const supabase = createAdminClient();

  type Shop = { owner_id: string | null };
  const { data: order, error } = await supabase
    .from("orders")
    .select("id, status, restaurants(owner_id)")
    .eq("id", orderId)
    .maybeSingle()
    .overrideTypes<{ id: string; status: string; restaurants: Shop | Shop[] | null }>();
  if (error) throw error;
  const shop = Array.isArray(order?.restaurants) ? order.restaurants[0] : order?.restaurants;
  if (!order || !shop?.owner_id || shop.owner_id !== ownerId) return { ok: false, error: "not_yours" };

  const { row } = await readDeliveryRow(supabase, orderId);
  if (!row || !row.driver_id || row.status === "unassigned") return { ok: false, error: "no_rider" };
  if (row.status === "picked_up" || row.status === "delivered") return { ok: true };
  if (row.status !== "assigned") return { ok: false, error: "bad_state" };

  if (order.status === "ready") {
    const { data: moved, error: moveError } = await supabase
      .from("orders")
      .update({ status: "on_the_way" })
      .eq("id", orderId)
      .eq("status", "ready")
      .select("id")
      .overrideTypes<{ id: string }[]>();
    if (moveError) throw moveError;
    if ((moved ?? []).length === 0) {
      const { order: now } = await readOrder(supabase, orderId);
      if (now?.status !== "on_the_way") return { ok: false, error: "bad_state" };
    }
  } else if (order.status !== "on_the_way") {
    return { ok: false, error: "bad_state" };
  }

  const driverId = row.driver_id;
  const write = await writeStep(supabase, {
    deliveryId: row.id,
    driverId,
    fromStatus: "assigned",
    fields: { status: "picked_up", picked_up_at: new Date().toISOString() },
    v0081: { pickup_method: "vendor" },
  });
  if (write.error) {
    if (isMissingColumnOnWrite(write.error)) throw new RiderSchemaPendingError();
    if (write.error.code !== CHECK_VIOLATION) throw write.error;
  }
  if (write.error || !write.moved) {
    const { row: after } = await readDeliveryRow(supabase, orderId);
    return after?.status === "picked_up" ? { ok: true } : { ok: false, error: "bad_state" };
  }

  deferNotify(() => notify.onTheWay(orderId));
  deferNotify(() => notify.riderHandedOver(driverId, orderId));
  return { ok: true };
}
