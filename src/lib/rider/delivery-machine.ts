/**
 * The rider's delivery steps, as pure rules: which step is legal from which
 * state, when a step has already happened, and when a proof photo is required.
 *
 * No I/O and no `server-only`, so the QA script runs it directly and the data
 * layer (`rider-delivery-actions.ts`) and the board (`rider-jobs.ts`) share one
 * answer. The database has the last word — `guard_delivery_transition` (0081/
 * 0082) refuses an illegal write whoever sends it — but asking here first is
 * what lets the server answer a replayed tap with "already done" instead of
 * writing it twice, and a wrong-leg tap with a reason the app can show.
 *
 *   arrive_pickup  assigned, not yet arrived            -> arrived_pickup_at
 *   pickup         assigned, order ready                -> picked_up (order on_the_way)
 *   start_trip     picked_up, not yet departed          -> departed_pickup_at
 *   arrive_drop    picked_up, not yet at the door       -> arrived_drop_at (+ departed_pickup_at)
 *   deliver        picked_up, order on the way          -> delivered (order delivered)
 *
 * Arrival and the trip stamps are optional steps, not gates: the web portal
 * goes straight from assigned to pickup to deliver, and the app may too.
 */

export const RIDER_ACTIONS = ["arrive_pickup", "pickup", "start_trip", "arrive_drop", "deliver"] as const;
export type RiderAction = (typeof RIDER_ACTIONS)[number];

export const PICKUP_METHODS = ["code", "qr", "manual"] as const;
export type PickupMethod = (typeof PICKUP_METHODS)[number];

export const DELIVER_METHODS = ["code", "photo", "ops_approved"] as const;
export type DeliverMethod = (typeof DELIVER_METHODS)[number];

export interface MachineState {
  status: "assigned" | "picked_up" | "delivered" | "failed" | "cancelled";
  arrivedPickupAt: string | null;
  departedPickupAt: string | null;
  arrivedDropAt: string | null;
  /** `orders.status`: placed | kitchen | ready | on_the_way | delivered | cancelled. */
  orderStatus: string;
}

export type CheckResult =
  | { ok: true }
  | { ok: false; error: "bad_state" | "order_not_active" | "already_done" };

export function isRiderAction(value: unknown): value is RiderAction {
  return typeof value === "string" && (RIDER_ACTIONS as readonly string[]).includes(value);
}

/**
 * Whether `method` is one this action takes. Pickup and deliver take one of
 * their own (absent means `code`); the three stamp steps take none.
 */
export function isMethodFor(action: RiderAction, method: unknown): boolean {
  if (method === undefined || method === null) return true;
  if (action === "pickup") return (PICKUP_METHODS as readonly unknown[]).includes(method);
  if (action === "deliver") return (DELIVER_METHODS as readonly unknown[]).includes(method);
  return false;
}

/** The delivery leg each step belongs to. */
const LEG: Record<RiderAction, MachineState["status"]> = {
  arrive_pickup: "assigned",
  pickup: "assigned",
  start_trip: "picked_up",
  arrive_drop: "picked_up",
  deliver: "picked_up",
};

/**
 * The order statuses each step may run against.
 *
 * `pickup` takes `on_the_way` as well as `ready`, and `deliver` takes
 * `delivered` as well as `on_the_way`: the order row moves first, so an order a
 * step has already moved — whose delivery write was then lost to a dropped
 * connection — must let the retry finish the delivery row rather than strand
 * the rider at "order not active". The delivery's own state (`LEG`) is what
 * stops a step running twice.
 */
const ORDER_OK: Record<RiderAction, readonly string[]> = {
  arrive_pickup: ["placed", "kitchen", "ready", "on_the_way"],
  pickup: ["ready", "on_the_way"],
  start_trip: ["on_the_way"],
  arrive_drop: ["on_the_way"],
  deliver: ["on_the_way", "delivered"],
};

/** The step's result is already on the row: a replay, or a second device. */
function targetHolds(s: MachineState, action: RiderAction): boolean {
  switch (action) {
    case "arrive_pickup":
      return s.arrivedPickupAt !== null;
    case "pickup":
      return s.status === "picked_up" || s.status === "delivered";
    case "start_trip":
      return s.departedPickupAt !== null;
    case "arrive_drop":
      return s.arrivedDropAt !== null;
    case "deliver":
      return s.status === "delivered";
  }
}

/**
 * May this step run now?
 *
 * In order: a cancelled order or a cancelled/failed delivery ends the job for
 * every step (`order_not_active` — the app clears it), even one whose stamp is
 * already set; a step whose result already holds is `already_done` (the caller
 * answers a duplicate success without writing); a delivered job refuses any
 * step it never took (`order_not_active`); a step on the wrong leg is
 * `bad_state`; and a step whose order is not at the matching stage is
 * `order_not_active` (pickup before the kitchen marks it ready, as the order's
 * own lock has always answered).
 */
export function checkAction(s: MachineState, action: RiderAction): CheckResult {
  if (s.status === "cancelled" || s.status === "failed" || s.orderStatus === "cancelled") {
    return { ok: false, error: "order_not_active" };
  }
  if (targetHolds(s, action)) return { ok: false, error: "already_done" };
  if (s.status === "delivered") return { ok: false, error: "order_not_active" };
  if (s.status !== LEG[action]) return { ok: false, error: "bad_state" };
  if (!ORDER_OK[action].includes(s.orderStatus)) return { ok: false, error: "order_not_active" };
  return { ok: true };
}

/**
 * Whether the rider must photograph the package before completing.
 * `platform_settings.pod_photo_rule` (0082): never; cod = cash orders only;
 * always; exceptions = only a completion ops approved without the code.
 */
export function podPhotoRequired(
  rule: "never" | "cod" | "always" | "exceptions",
  ctx: { isCod: boolean; viaException: boolean }
): boolean {
  switch (rule) {
    case "always":
      return true;
    case "cod":
      return ctx.isCod;
    case "exceptions":
      return ctx.viaException;
    default:
      return false;
  }
}
