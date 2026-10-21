import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings-defaults";
import { deferNotify } from "@/lib/notifications/defer";
import {
  notifyDriverExceptionDecided,
  notifyOpsExceptionRequested,
  stopOpsRing,
} from "@/lib/notifications/order-events";
import { captureError } from "@/lib/obs/emit";
import { isPlausibleFix } from "@/lib/geo/fix";
import { shortOrderId } from "@/lib/utils/order-map";
import { dispatchOrder, type DispatchStage } from "@/lib/dispatch/rider-dispatch";
import { forceRiderOffline, RiderSchemaPendingError } from "@/lib/data-access/rider-status";
import { rejectOffer } from "@/lib/data-access/rider-jobs";
import {
  completeDelivery,
  isCashOrder,
  type DeliveryNotifier,
} from "@/lib/data-access/rider-delivery-actions";
import { cancelOrderAsOps, type CancelOpsResult } from "@/lib/data-access/order-cancellation";
import { isMissingColumn, isMissingTable } from "@/lib/data-access/schema-probe";
import { podPhotoRequired } from "@/lib/rider/delivery-machine";
import {
  FAILING_KINDS,
  decisionAllowed,
  decisionStatus,
  exceptionAllowed,
  isExceptionDecision,
  isExceptionKind,
  isRequestKind,
  type ExceptionDecision,
  type ExceptionKind,
  type ExceptionState,
} from "@/lib/rider/exception-rules";
import type { PaymentMethod, PaymentStatus, PlatformSettings } from "@/types";

export type { ExceptionKind, ExceptionDecision } from "@/lib/rider/exception-rules";

/**
 * Delivery exceptions: a rider asks ops for a decision on a job they hold (or
 * reports something), and a manager or admin decides it. The rules for what
 * may be raised and how each kind is answered live in
 * `lib/rider/exception-rules.ts`; this module reads the state, asks them,
 * writes, and carries out what an approval means.
 *
 * ## Authorization
 *
 * Everything runs on the service-role client: riders and managers cannot
 * write `delivery_exceptions` (0082 grants them SELECT at most), and the queue
 * needs the rider's phone and signed photo URLs. So the caller authenticates:
 *
 *   * `raiseException(driverId, …)` — `/api/rider/exceptions` derives
 *     `driverId` from the session behind `requireRiderApi()`. What the rider may
 *     raise against is then decided here, by that id: the delivery must name
 *     them as its rider (or as the offeree, for `go_offline`), `not_yours`
 *     otherwise.
 *   * `listPendingExceptions()` / `decideException(actor, …)` — the manager
 *     actions (`app/manager/actions.ts`) behind `requireRole(["manager",
 *     "admin"])`; `actor` is that profile, never anything from the request.
 *
 * ## What an approval does
 *
 * Each approval re-reads the delivery first. A delivery already over, or no
 * longer held by the rider who asked (or held since an assignment that began
 * after they asked), is closed as `rejected` with a note and answered
 * `already_resolved` — nothing is changed twice. Otherwise:
 *
 *   failed_delivery / customer_unreachable / wrong_address
 *       the delivery fails (`failure_reason` = kind + reason), then the order
 *       is cancelled through `cancelOrderAsOps` (refund rules unchanged,
 *       `cancelled_by` = the deciding role), and the rider is told to take the
 *       food back to the shop.
 *   complete_without_code
 *       the proof-photo rule first (`photo_required` if it wants a photo and
 *       none is attached — the request stays pending), then `completeDelivery`
 *       with `ops_approved`: the one completion path (ruling P2-R1), with the
 *       COD record and the customer's push.
 *   manual_pickup
 *       nothing moves: the rider confirms the pickup with method `manual`,
 *       which the guard now allows.
 *   go_offline
 *       the job goes back to dispatch (a release: a correction with its own
 *       reason `released:go_offline:<id>`), is offered again without this
 *       rider, and the rider is taken offline. Holding only an offer, the offer
 *       is turned down for them instead.
 *
 * The decision itself is written first and only `where status = 'pending'`,
 * so of two managers deciding at once exactly one wins; 0082 makes a decided
 * row final underneath that.
 */

type AdminClient = ReturnType<typeof createAdminClient>;
type PgError = { code?: string; message?: string };

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const REASON_MAX = 200;
const NOTES_MAX = 500;
const NOTE_MAX = 300;
const QUEUE_MAX = 50;
/** Signed photo URLs live 10 minutes (plan: "signed URLs valid 10 minutes"). */
const PHOTO_URL_TTL_SEC = 600;
const PROOF_BUCKET = "delivery-proofs";
const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// seams
// ---------------------------------------------------------------------------

/** Who is told what. Production uses the pushes; tests pass recorders. */
export interface ExceptionNotifier {
  opsRequested: (
    exceptionId: string,
    info: { orderId: string; kind: ExceptionKind; riderName?: string | null }
  ) => Promise<unknown>;
  stopOpsRing: (exceptionId: string) => Promise<unknown>;
  driverDecided: (
    driverId: string,
    info: {
      orderId: string;
      kind: ExceptionKind;
      status: "approved" | "rejected" | "acknowledged";
      note?: string | null;
    }
  ) => Promise<unknown>;
  /** Passed through to `completeDelivery` (the customer's "delivered" push). */
  delivery?: Partial<DeliveryNotifier>;
}

const PUSH: ExceptionNotifier = {
  opsRequested: notifyOpsExceptionRequested,
  stopOpsRing,
  driverDecided: notifyDriverExceptionDecided,
};

/** What an approval sets off beyond this module. Production uses the real ones. */
export interface ExceptionEffects {
  cancelOrder: (
    orderId: string,
    opts: { by: "admin" | "manager"; reason?: string | null; requestedBy: string }
  ) => Promise<CancelOpsResult>;
  dispatch: (orderId: string, stage: DispatchStage, opts: { excludeRiderIds?: string[] }) => Promise<unknown>;
  forceOffline: (driverId: string) => Promise<unknown>;
  rejectOffer: (driverId: string, orderId: string) => Promise<unknown>;
}

const EFFECTS: ExceptionEffects = {
  cancelOrder: cancelOrderAsOps,
  dispatch: dispatchOrder,
  forceOffline: (driverId) => forceRiderOffline(driverId, "ops"),
  rejectOffer: (driverId, orderId) => rejectOffer(driverId, orderId, "other", "go_offline approved by ops"),
};

export interface ExceptionOptions {
  /** Epoch ms; defaults to now. */
  now?: number;
  settings?: PlatformSettings;
  notify?: Partial<ExceptionNotifier>;
  effects?: Partial<ExceptionEffects>;
}

/**
 * The settings in force. A read that throws (it should not: `getSettings`
 * serves its own fallback) uses the defaults rather than refusing every
 * request; the failure is reported.
 */
async function settingsOf(opts: ExceptionOptions): Promise<PlatformSettings> {
  if (opts.settings) return opts.settings;
  try {
    return await getSettings();
  } catch (e) {
    captureError(e, { source: "delivery-exceptions/settings", attrs: { event: "settings_unreadable" } });
    return DEFAULT_SETTINGS;
  }
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

interface DeliveryRow {
  id: string;
  order_id: string;
  status: string;
  driver_id: string | null;
  offered_driver_id: string | null;
  assigned_at: string | null;
  arrived_drop_at: string | null;
  pod_photo_path: string | null;
}

/** 0081's arrived_drop_at and 0082's pod_photo_path, plus 0042's offer column. */
const DELIVERY_COLUMNS =
  "id, order_id, status, driver_id, offered_driver_id, assigned_at, arrived_drop_at, pod_photo_path";

/** A missing column or table here means 0081/0082 are not applied: 503, never a guess. */
function schemaFail(error: PgError): never {
  if (isMissingColumn(error) || isMissingTable(error)) throw new RiderSchemaPendingError();
  throw error;
}

async function readDelivery(
  supabase: AdminClient,
  by: { orderId: string } | { id: string }
): Promise<DeliveryRow | null> {
  const query = supabase.from("deliveries").select(DELIVERY_COLUMNS);
  const { data, error } = await ("orderId" in by
    ? query.eq("order_id", by.orderId)
    : query.eq("id", by.id)
  )
    .maybeSingle()
    .overrideTypes<DeliveryRow>();
  if (error) schemaFail(error);
  return data;
}

/** Where `driverId` stands on this delivery, or null when it is not theirs at all. */
function riderState(row: DeliveryRow | null, driverId: string): ExceptionState | null {
  if (!row) return null;
  if (row.driver_id === driverId) {
    switch (row.status) {
      case "assigned":
      case "picked_up":
      case "delivered":
      case "failed":
      case "cancelled":
        return row.status;
      default:
        return null;
    }
  }
  if (row.driver_id === null && row.status === "unassigned" && row.offered_driver_id === driverId) {
    return "offered";
  }
  return null;
}

/** The rider's latest logged call to the customer on this delivery (0082 `contact_attempt`). */
async function lastCustomerCall(
  supabase: AdminClient,
  deliveryId: string,
  driverId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("delivery_events")
    .select("created_at")
    .eq("delivery_id", deliveryId)
    .eq("driver_id", driverId)
    .eq("kind", "contact_attempt")
    .eq("method", "customer")
    .order("created_at", { ascending: false })
    .limit(1)
    .overrideTypes<{ created_at: string }[]>();
  if (error) schemaFail(error);
  return data?.[0]?.created_at ?? null;
}

async function riderName(supabase: AdminClient, driverId: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", driverId)
      .maybeSingle()
      .overrideTypes<{ full_name: string | null }>();
    return data?.full_name?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The audit row on the delivery's timeline (`exception_requested` /
 * `exception_decided`, 0081 kinds). Best-effort: the exception row itself is
 * the record; a missing timeline entry is reported, not fatal.
 */
async function auditEvent(
  supabase: AdminClient,
  row: { delivery_id: string; order_id: string; driver_id: string },
  kind: "exception_requested" | "exception_decided",
  reason: string,
  actorId: string,
  position: { lat: number; lng: number } | null = null
): Promise<void> {
  try {
    const { error } = await supabase.from("delivery_events").insert({
      delivery_id: row.delivery_id,
      order_id: row.order_id,
      driver_id: row.driver_id,
      kind,
      reason,
      actor_id: actorId,
      lat: position?.lat ?? null,
      lng: position?.lng ?? null,
    });
    if (error) throw error;
  } catch (e) {
    captureError(e, {
      source: "delivery-exceptions/audit",
      orderId: row.order_id,
      driverId: row.driver_id,
      attrs: { event: "exception_audit_failed", kind },
    });
  }
}

const clip = (value: string | null | undefined, max: number): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

// ---------------------------------------------------------------------------
// raising
// ---------------------------------------------------------------------------

export interface RaiseExceptionInput {
  orderId: string;
  kind: ExceptionKind;
  reason: string;
  notes?: string;
  /** A proof photo already uploaded for this delivery (`uploadDeliveryProof`'s path). */
  photoPath?: string;
  lat?: number;
  lng?: number;
}

export type RaiseExceptionResult =
  | { ok: true; id: string }
  | {
      ok: false;
      error: "not_yours" | "duplicate_pending" | "call_first" | "bad_state" | "invalid_kind" | "bad_photo";
    }
  | { ok: false; error: "wait_longer"; minutesLeft: number };

/**
 * A rider raises an exception on the job they hold (or, for `go_offline`, the
 * offer they hold). See `exceptionAllowed` for which kind may be raised from
 * where, and `call_first` / `wait_longer` for `customer_unreachable`.
 *
 * A photo, if sent, must be the one the proof upload recorded for this
 * delivery (`deliveries.pod_photo_path`) — never a path the app names on its
 * own (`bad_photo`). One pending request per kind per delivery: a second is
 * `duplicate_pending` (0082's unique index). Ops are pushed — and for a
 * request, rung — once it is stored.
 */
export async function raiseException(
  driverId: string,
  input: RaiseExceptionInput,
  opts: ExceptionOptions = {}
): Promise<RaiseExceptionResult> {
  if (!isExceptionKind(input.kind)) return { ok: false, error: "invalid_kind" };
  const kind = input.kind;
  const notify = { ...PUSH, ...opts.notify };
  const supabase = createAdminClient();
  const now = opts.now ?? Date.now();

  const row = await readDelivery(supabase, { orderId: input.orderId });
  const state = riderState(row, driverId);
  if (!row || !state) return { ok: false, error: "not_yours" };

  let lastCall: string | null = null;
  let waitMinutes = DEFAULT_SETTINGS.unreachableWaitMinutes;
  if (kind === "customer_unreachable" && state === "picked_up") {
    lastCall = await lastCustomerCall(supabase, row.id, driverId);
    waitMinutes = (await settingsOf(opts)).unreachableWaitMinutes;
  }
  const check = exceptionAllowed(kind, state, {
    now,
    arrivedDropAt: row.arrived_drop_at,
    lastCustomerCallAt: lastCall,
    unreachableWaitMinutes: waitMinutes,
  });
  if (!check.ok) return check;

  let photoPath: string | null = null;
  if (input.photoPath !== undefined && input.photoPath !== null) {
    if (
      !row.pod_photo_path ||
      input.photoPath !== row.pod_photo_path ||
      !input.photoPath.startsWith(`${row.id}/`)
    ) {
      return { ok: false, error: "bad_photo" };
    }
    photoPath = input.photoPath;
  }

  const position = isPlausibleFix(input.lat, input.lng)
    ? { lat: input.lat as number, lng: input.lng as number }
    : null;

  const { data, error } = await supabase
    .from("delivery_exceptions")
    .insert({
      delivery_id: row.id,
      order_id: row.order_id,
      driver_id: driverId,
      kind,
      reason: clip(input.reason, REASON_MAX) ?? kind,
      notes: clip(input.notes, NOTES_MAX),
      photo_path: photoPath,
      lat: position?.lat ?? null,
      lng: position?.lng ?? null,
    })
    .select("id")
    .single()
    .overrideTypes<{ id: string }>();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { ok: false, error: "duplicate_pending" };
    schemaFail(error);
  }
  const id = data.id;

  const owner = { delivery_id: row.id, order_id: row.order_id, driver_id: driverId };
  await auditEvent(supabase, owner, "exception_requested", kind, driverId, position);
  const name = await riderName(supabase, driverId);
  deferNotify(() => notify.opsRequested(id, { orderId: row.order_id, kind, riderName: name }));
  return { ok: true, id };
}

// ---------------------------------------------------------------------------
// the ops queue
// ---------------------------------------------------------------------------

export interface OpsException {
  id: string;
  kind: ExceptionKind;
  /** request: approve / reject; report: acknowledge. */
  family: "request" | "report";
  reason: string;
  notes: string | null;
  createdAt: string;
  minutesWaiting: number;
  orderId: string;
  /** "#1A2B3C4D", as every board shows it. */
  orderCode: string;
  orderStatus: string | null;
  deliveryStatus: string | null;
  /** The rider still holds the job (or the offer) they asked about. */
  active: boolean;
  riderId: string;
  riderName: string;
  /** Only while `active`; the page drops it too when calling is switched off. */
  riderPhone: string | null;
  shopName: string | null;
  /** The drop's area (or the last part of its line) — enough to place it, no more. */
  customerArea: string | null;
  /** A 10-minute signed URL of the photo in the private bucket, or null. */
  photoUrl: string | null;
  lat: number | null;
  lng: number | null;
}

interface ExceptionRow {
  id: string;
  delivery_id: string;
  order_id: string;
  driver_id: string;
  kind: string;
  reason: string;
  notes: string | null;
  photo_path: string | null;
  lat: number | null;
  lng: number | null;
  status: string;
  created_at: string;
}

type Shop = { name: string | null };
interface QueueOrder {
  id: string;
  status: string;
  address: { area?: unknown; line?: unknown } | null;
  restaurants: Shop | Shop[] | null;
}

function areaOf(address: QueueOrder["address"]): string | null {
  if (!address) return null;
  if (typeof address.area === "string" && address.area.trim()) return address.area.trim().slice(0, 60);
  if (typeof address.line === "string" && address.line.trim()) {
    const parts = address.line.split(",").map((p) => p.trim()).filter(Boolean);
    return (parts.at(-1) ?? null)?.slice(0, 60) ?? null;
  }
  return null;
}

function isActive(x: { driver_id: string }, d: DeliveryRow | undefined): boolean {
  if (!d) return false;
  if (d.driver_id === x.driver_id) return d.status === "assigned" || d.status === "picked_up";
  return d.driver_id === null && d.status === "unassigned" && d.offered_driver_id === x.driver_id;
}

/**
 * Every exception waiting on ops, oldest first (the one a rider has waited
 * longest for is the one in reach). For the manager board and the admin live
 * board. Callers are `requireRole(["manager", "admin"])` — this reads phones
 * and mints signed URLs.
 *
 * Reads degrade: a database without `delivery_exceptions` has nothing
 * waiting, and a photo that cannot be signed shows no thumbnail.
 */
export async function listPendingExceptions(
  opts: { now?: number; limit?: number } = {}
): Promise<OpsException[]> {
  const supabase = createAdminClient();
  const now = opts.now ?? Date.now();

  const { data, error } = await supabase
    .from("delivery_exceptions")
    .select("id, delivery_id, order_id, driver_id, kind, reason, notes, photo_path, lat, lng, status, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? QUEUE_MAX)
    .overrideTypes<ExceptionRow[]>();
  if (error) {
    if (isMissingTable(error) || isMissingColumn(error)) return [];
    throw error;
  }
  const rows = (data ?? []).filter((x) => isExceptionKind(x.kind));
  if (rows.length === 0) return [];

  const unique = (values: string[]) => [...new Set(values)];
  const [deliveries, orders, people] = await Promise.all([
    supabase
      .from("deliveries")
      .select(DELIVERY_COLUMNS)
      .in("id", unique(rows.map((x) => x.delivery_id)))
      .overrideTypes<DeliveryRow[]>(),
    supabase
      .from("orders")
      .select("id, status, address, restaurants(name)")
      .in("id", unique(rows.map((x) => x.order_id)))
      .overrideTypes<QueueOrder[]>(),
    supabase
      .from("profiles")
      .select("id, full_name, phone")
      .in("id", unique(rows.map((x) => x.driver_id)))
      .overrideTypes<{ id: string; full_name: string | null; phone: string | null }[]>(),
  ]);
  const byDelivery = new Map((deliveries.data ?? []).map((d) => [d.id, d]));
  const byOrder = new Map((orders.data ?? []).map((o) => [o.id, o]));
  const byRider = new Map((people.data ?? []).map((p) => [p.id, p]));

  const photoOf = (x: ExceptionRow) => x.photo_path ?? byDelivery.get(x.delivery_id)?.pod_photo_path ?? null;
  const paths = unique(rows.map(photoOf).filter((p): p is string => Boolean(p)));
  const urls = new Map<string, string>();
  if (paths.length > 0) {
    try {
      const { data: signedUrls, error: signError } = await supabase.storage
        .from(PROOF_BUCKET)
        .createSignedUrls(paths, PHOTO_URL_TTL_SEC);
      if (signError) throw signError;
      for (const s of signedUrls ?? []) if (s.path && s.signedUrl && !s.error) urls.set(s.path, s.signedUrl);
    } catch (e) {
      captureError(e, { source: "delivery-exceptions/sign", attrs: { event: "photo_sign_failed" } });
    }
  }

  return rows.map((x) => {
    const kind = x.kind as ExceptionKind;
    const d = byDelivery.get(x.delivery_id);
    const o = byOrder.get(x.order_id);
    const person = byRider.get(x.driver_id);
    const shop = Array.isArray(o?.restaurants) ? o.restaurants[0] : o?.restaurants;
    const active = isActive(x, d);
    const photo = photoOf(x);
    return {
      id: x.id,
      kind,
      family: isRequestKind(kind) ? "request" : "report",
      reason: x.reason,
      notes: x.notes,
      createdAt: x.created_at,
      minutesWaiting: Math.max(0, Math.floor((now - Date.parse(x.created_at)) / MINUTE)),
      orderId: x.order_id,
      orderCode: `#${shortOrderId(x.order_id)}`,
      orderStatus: o?.status ?? null,
      deliveryStatus: d?.status ?? null,
      active,
      riderId: x.driver_id,
      riderName: person?.full_name?.trim() || "Rider",
      riderPhone: active ? person?.phone?.trim() || null : null,
      shopName: shop?.name?.trim() || null,
      customerArea: areaOf(o?.address ?? null),
      photoUrl: photo ? (urls.get(photo) ?? null) : null,
      lat: x.lat,
      lng: x.lng,
    } satisfies OpsException;
  });
}

// ---------------------------------------------------------------------------
// deciding
// ---------------------------------------------------------------------------

export type DecideExceptionResult =
  | { ok: true; orderCancelled?: boolean }
  | { ok: false; error: "not_found" | "already_resolved" | "invalid_decision" | "photo_required" };

export interface ExceptionActor {
  id: string;
  role: "admin" | "manager";
}

const RESOLVED = { ok: false, error: "already_resolved" } as const;

/**
 * Write the decision, only if it is still pending. False when somebody else
 * decided first (no row matched) or 0082 refused it as already decided.
 */
async function recordDecision(
  supabase: AdminClient,
  id: string,
  status: "approved" | "rejected" | "acknowledged",
  actor: ExceptionActor,
  note: string | null
): Promise<boolean> {
  const { data, error } = await supabase
    .from("delivery_exceptions")
    .update({
      status,
      decided_by: actor.id,
      decided_at: new Date().toISOString(),
      decision_note: note,
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id")
    .overrideTypes<{ id: string }[]>();
  if (error) {
    if (error.code === CHECK_VIOLATION) return false;
    schemaFail(error);
  }
  return (data ?? []).length > 0;
}

/** Is the job still where the rider was when they asked, so the approval can act? */
function stillLive(x: ExceptionRow, kind: ExceptionKind, d: DeliveryRow | null): boolean {
  if (!d) return false;
  const theirs = d.driver_id === x.driver_id;
  // An approval counts only for the assignment it was raised in (0082 rule
  // 11): a request left over from an earlier stint on this job is stale.
  const thisStint = d.assigned_at !== null && Date.parse(x.created_at) >= Date.parse(d.assigned_at);
  if (kind === "go_offline") {
    return (
      (theirs && (d.status === "assigned" || d.status === "picked_up")) ||
      (d.driver_id === null && d.status === "unassigned" && d.offered_driver_id === x.driver_id)
    );
  }
  if (!theirs || !thisStint) return false;
  if (kind === "manual_pickup") return d.status === "assigned";
  if (kind === "complete_without_code") return d.status === "picked_up";
  return d.status === "assigned" || d.status === "picked_up";
}

interface OrderPayment {
  status: string;
  total: number | null;
  payment_method?: PaymentMethod | null;
  payment_status?: PaymentStatus | null;
}

async function readOrderPayment(supabase: AdminClient, orderId: string): Promise<OrderPayment | null> {
  for (const columns of ["status, total, payment_method, payment_status", "status, total"]) {
    const { data, error } = await supabase
      .from("orders")
      .select(columns)
      .eq("id", orderId)
      .maybeSingle()
      .overrideTypes<OrderPayment>();
    if (!error) return data;
    if (!isMissingColumn(error)) throw error;
  }
  return null;
}

/**
 * A manager or admin decides an exception. See the module header for what
 * each approval does. `already_resolved` when it was decided already (by
 * anyone), or when the job has moved on since the rider asked — closed then as
 * `rejected` with a note so it leaves the queue. `photo_required` when
 * `complete_without_code` would complete without the photo the rule wants; it
 * stays pending so ops can reject it or wait for the rider's photo.
 */
export async function decideException(
  actor: ExceptionActor,
  id: string,
  decision: ExceptionDecision,
  note?: string,
  opts: ExceptionOptions = {}
): Promise<DecideExceptionResult> {
  if (!isExceptionDecision(decision)) return { ok: false, error: "invalid_decision" };
  const notify = { ...PUSH, ...opts.notify };
  const effects = { ...EFFECTS, ...opts.effects };
  const supabase = createAdminClient();

  const { data: x, error } = await supabase
    .from("delivery_exceptions")
    .select("id, delivery_id, order_id, driver_id, kind, reason, notes, photo_path, lat, lng, status, created_at")
    .eq("id", id)
    .maybeSingle()
    .overrideTypes<ExceptionRow>();
  if (error) schemaFail(error);
  if (!x) return { ok: false, error: "not_found" };
  if (!isExceptionKind(x.kind) || !decisionAllowed(x.kind, decision)) {
    return { ok: false, error: "invalid_decision" };
  }
  if (x.status !== "pending") return RESOLVED;
  const kind = x.kind;
  const cleanNote = clip(note, NOTE_MAX);

  /** Every decision: the ops phones stop ringing and the timeline records it. */
  const closed = async (status: "approved" | "rejected" | "acknowledged", tellRider: boolean, why = cleanNote) => {
    deferNotify(() => notify.stopOpsRing(x.id));
    await auditEvent(supabase, x, "exception_decided", `${kind}:${status}`, actor.id);
    if (tellRider) {
      deferNotify(() => notify.driverDecided(x.driver_id, { orderId: x.order_id, kind, status, note: why }));
    }
  };

  if (decision !== "approve") {
    const status = decisionStatus(decision);
    if (!(await recordDecision(supabase, x.id, status, actor, cleanNote))) return RESOLVED;
    await closed(status, true);
    return { ok: true };
  }

  const d = await readDelivery(supabase, { id: x.delivery_id });
  if (!stillLive(x, kind, d)) {
    const why = `Already resolved: the delivery is ${d ? (d.driver_id === x.driver_id || d.driver_id === null ? d.status : "with another rider") : "gone"}.`;
    if (await recordDecision(supabase, x.id, "rejected", actor, why)) await closed("rejected", false, why);
    return RESOLVED;
  }
  const delivery = d as DeliveryRow;

  // The photo rule, before anything is decided (Task 3: completeDelivery checks
  // state, not proof). The delivery's own proof counts, as does the one the
  // rider attached — which raiseException only accepted if it was that proof.
  let photo: string | null = null;
  let payment: OrderPayment | null = null;
  if (kind === "complete_without_code") {
    payment = await readOrderPayment(supabase, x.order_id);
    photo = delivery.pod_photo_path ?? x.photo_path ?? null;
    const rule = (await settingsOf(opts)).podPhotoRule;
    if (podPhotoRequired(rule, { isCod: isCashOrder(payment), viaException: true }) && !photo) {
      return { ok: false, error: "photo_required" };
    }
  }

  if (!(await recordDecision(supabase, x.id, "approved", actor, cleanNote))) return RESOLVED;

  /** The approval stands but the job moved under it: report, stop ringing, answer resolved. */
  const movedOn = async (refusal?: PgError) => {
    if (refusal) {
      captureError(refusal, {
        source: "delivery-exceptions/approve",
        orderId: x.order_id,
        driverId: x.driver_id,
        attrs: { event: "approval_refused_by_guard", kind },
      });
    }
    await closed("approved", false);
    return RESOLVED;
  };

  if ((FAILING_KINDS as readonly string[]).includes(kind)) {
    const { data: failedRows, error: failError } = await supabase
      .from("deliveries")
      .update({ status: "failed", failure_reason: `${kind}: ${x.reason}`.slice(0, 300) })
      .eq("id", delivery.id)
      .eq("driver_id", x.driver_id)
      .in("status", ["assigned", "picked_up"])
      .select("id")
      .overrideTypes<{ id: string }[]>();
    if (failError) {
      if (failError.code === CHECK_VIOLATION) return movedOn(failError);
      throw failError;
    }
    if ((failedRows ?? []).length === 0) return movedOn();

    let orderCancelled = false;
    try {
      const cancel = await effects.cancelOrder(x.order_id, {
        by: actor.role,
        reason: `delivery_failed: ${kind}`,
        requestedBy: actor.id,
      });
      orderCancelled = cancel.ok || cancel.error === "already_cancelled";
      if (!cancel.ok && !orderCancelled) {
        captureError(new Error(`cancel_after_failure: ${cancel.error}`), {
          source: "delivery-exceptions/cancel",
          orderId: x.order_id,
          attrs: { event: "order_not_cancelled_after_failure", error: cancel.error },
        });
      }
    } catch (e) {
      captureError(e, {
        source: "delivery-exceptions/cancel",
        orderId: x.order_id,
        attrs: { event: "order_not_cancelled_after_failure" },
      });
    }
    await closed("approved", true);
    return { ok: true, orderCancelled };
  }

  if (kind === "complete_without_code") {
    const done = await completeDelivery(
      supabase,
      { id: delivery.id, orderId: x.order_id, driverId: x.driver_id },
      {
        method: "ops_approved",
        actorId: actor.id,
        photoPath: photo ?? undefined,
        notify: notify.delivery,
      }
    );
    // Delivered meanwhile (the rider's code won), or no longer deliverable:
    // nothing is changed twice.
    if (!done.ok || done.duplicate) return movedOn();
    await closed("approved", true);
    return { ok: true };
  }

  if (kind === "go_offline") {
    if (delivery.driver_id === x.driver_id) {
      const { data: released, error: releaseError } = await supabase
        .from("deliveries")
        .update({
          driver_id: null,
          status: "unassigned",
          // Unique per release: an update that repeats the last reason is not
          // a correction, and the guard would refuse it as a plain release.
          correction_reason: `released:go_offline:${x.id}`,
          // The leaving rider's proof photo and position are not the next
          // rider's. (The guard clears the stamps and the offer.)
          pod_photo_path: null,
          driver_lat: null,
          driver_lng: null,
          driver_location_at: null,
        })
        .eq("id", delivery.id)
        .eq("driver_id", x.driver_id)
        .in("status", ["assigned", "picked_up"])
        .select("id")
        .overrideTypes<{ id: string }[]>();
      if (releaseError) {
        if (releaseError.code === CHECK_VIOLATION) return movedOn(releaseError);
        schemaFail(releaseError);
      }
      if ((released ?? []).length === 0) return movedOn();

      const { data: o } = await supabase
        .from("orders")
        .select("status")
        .eq("id", x.order_id)
        .maybeSingle()
        .overrideTypes<{ status: string }>();
      const stage: DispatchStage = o?.status === "ready" || o?.status === "on_the_way" ? "ready" : "accepted";
      await effects.dispatch(x.order_id, stage, { excludeRiderIds: [x.driver_id] });
    } else {
      // Holding only an offer: decline it for them (recorded, re-dispatched
      // without them) — the same path as their own Reject.
      await effects.rejectOffer(x.driver_id, x.order_id);
    }
    await effects.forceOffline(x.driver_id);
    await closed("approved", true);
    return { ok: true };
  }

  // manual_pickup: the approval is the whole effect — the rider now confirms
  // the pickup with method `manual`, which guard rule 9 allows.
  await closed("approved", true);
  return { ok: true };
}
