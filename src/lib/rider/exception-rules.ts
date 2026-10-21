/**
 * Delivery exceptions, as pure rules: which kinds exist, which a rider may
 * raise from where they are on the job, and how ops may answer each.
 *
 * No I/O and no `server-only`, so the QA script runs it directly and the data
 * layer (`data-access/delivery-exceptions.ts`) asks it before writing. The
 * database has the last word on what an APPROVAL may authorise
 * (`guard_delivery_transition`, 0082); these rules decide what may be ASKED,
 * which the database does not know about (a call before "customer
 * unreachable", the wait at the door).
 *
 * Two families (0082's `delivery_exceptions_status_for_kind`):
 *
 *   requests  customer_unreachable, wrong_address, complete_without_code,
 *             failed_delivery, manual_pickup, go_offline
 *             ops approve or reject; an approval changes the delivery
 *   reports   return_to_shop, missing_items, wrong_package, vendor_delay,
 *             other_issue
 *             ops acknowledge; nothing changes
 */

export const REQUEST_KINDS = [
  "customer_unreachable",
  "wrong_address",
  "complete_without_code",
  "failed_delivery",
  "manual_pickup",
  "go_offline",
] as const;

export const REPORT_KINDS = [
  "return_to_shop",
  "missing_items",
  "wrong_package",
  "vendor_delay",
  "other_issue",
] as const;

export const EXCEPTION_KINDS = [...REQUEST_KINDS, ...REPORT_KINDS] as const;

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];
export type RequestKind = (typeof REQUEST_KINDS)[number];

export type ExceptionDecision = "approve" | "reject" | "acknowledge";
export const EXCEPTION_DECISIONS: readonly ExceptionDecision[] = ["approve", "reject", "acknowledge"];

/** The kinds whose approval fails the delivery (guard rule 7) and cancels the order. */
export const FAILING_KINDS: readonly RequestKind[] = [
  "failed_delivery",
  "customer_unreachable",
  "wrong_address",
];

/** How each kind reads in a sentence — the ops queue, the pushes. */
const EXCEPTION_LABEL: Record<ExceptionKind, string> = {
  customer_unreachable: "Customer unreachable",
  wrong_address: "Wrong address",
  complete_without_code: "Complete without the code",
  failed_delivery: "Failed delivery",
  manual_pickup: "Manual pickup check",
  go_offline: "Go offline mid-job",
  return_to_shop: "Returning to the shop",
  missing_items: "Missing items",
  wrong_package: "Wrong package",
  vendor_delay: "Shop delay",
  other_issue: "Other issue",
};

export function exceptionLabel(kind: ExceptionKind): string {
  return EXCEPTION_LABEL[kind] ?? kind;
}

export function isExceptionKind(value: unknown): value is ExceptionKind {
  return typeof value === "string" && (EXCEPTION_KINDS as readonly string[]).includes(value);
}

export function isRequestKind(kind: ExceptionKind): kind is RequestKind {
  return (REQUEST_KINDS as readonly string[]).includes(kind);
}

export function isExceptionDecision(value: unknown): value is ExceptionDecision {
  return typeof value === "string" && (EXCEPTION_DECISIONS as readonly string[]).includes(value);
}

/**
 * May ops answer this kind this way? A request is approved or rejected; a
 * report is only acknowledged — a report "approved" into authorising something
 * is exactly what 0082's per-kind CHECK forbids, and this answers it first.
 */
export function decisionAllowed(kind: ExceptionKind, decision: ExceptionDecision): boolean {
  return isRequestKind(kind) ? decision === "approve" || decision === "reject" : decision === "acknowledge";
}

/** The `delivery_exceptions.status` a decision writes. */
export function decisionStatus(decision: ExceptionDecision): "approved" | "rejected" | "acknowledged" {
  if (decision === "approve") return "approved";
  if (decision === "reject") return "rejected";
  return "acknowledged";
}

/**
 * Where the rider stands on the job, as the data layer reads it:
 *   offered     the delivery is unassigned and held for this rider (an offer)
 *   assigned    they hold it and have not picked up
 *   picked_up   they are carrying it
 *   delivered / failed / cancelled   it is over (the row still names them)
 */
export type ExceptionState = "offered" | "assigned" | "picked_up" | "delivered" | "failed" | "cancelled";

export interface ExceptionContext {
  /** Epoch ms. */
  now: number;
  /** `deliveries.arrived_drop_at` — the rider tapped "I've arrived". */
  arrivedDropAt: string | null;
  /** The latest `contact_attempt` to the customer by this rider on this delivery. */
  lastCustomerCallAt: string | null;
  /** `platform_settings.unreachable_wait_minutes` (3–30, default 10). */
  unreachableWaitMinutes: number;
}

export type ExceptionCheck =
  | { ok: true }
  | { ok: false; error: "bad_state" | "call_first" }
  | { ok: false; error: "wait_longer"; minutesLeft: number };

/** The states each kind may be raised from. */
const FROM: Record<ExceptionKind, readonly ExceptionState[]> = {
  manual_pickup: ["assigned"],
  complete_without_code: ["picked_up"],
  failed_delivery: ["picked_up"],
  customer_unreachable: ["picked_up"],
  wrong_address: ["picked_up"],
  // Before pickup only (ruling P2-R9): an outstanding offer, or a job taken
  // but not yet collected. Once the rider has the food, leaving is not a
  // hand-back to dispatch — the next rider would be sent to an empty counter —
  // so it is a failed delivery or a call to ops instead.
  go_offline: ["offered", "assigned"],
  // Reports are notes to ops, raised while the rider holds the job. The food
  // going back to the shop also follows an approved failure, so that one may
  // be reported after the delivery has failed.
  return_to_shop: ["assigned", "picked_up", "failed"],
  missing_items: ["assigned", "picked_up"],
  wrong_package: ["assigned", "picked_up"],
  vendor_delay: ["assigned", "picked_up"],
  other_issue: ["assigned", "picked_up"],
};

const MINUTE = 60_000;

/**
 * May the rider raise `kind` now?
 *
 *   bad_state    not from here (manual pickup after the pickup, a delivery
 *                request before it, anything but go_offline on a bare offer,
 *                go_offline after the pickup,
 *                "customer unreachable" before tapping "I've arrived")
 *   call_first   customer_unreachable with no logged call to the customer
 *                since arriving at the door
 *   wait_longer  customer_unreachable before `unreachable_wait_minutes` have
 *                passed since arriving; `minutesLeft` is rounded up, so the
 *                app never says "0 minutes" while the server still refuses
 */
export function exceptionAllowed(
  kind: ExceptionKind,
  state: ExceptionState,
  ctx: ExceptionContext
): ExceptionCheck {
  if (!FROM[kind].includes(state)) return { ok: false, error: "bad_state" };
  if (kind !== "customer_unreachable") return { ok: true };

  const arrived = ctx.arrivedDropAt ? Date.parse(ctx.arrivedDropAt) : NaN;
  if (!Number.isFinite(arrived)) return { ok: false, error: "bad_state" };

  const called = ctx.lastCustomerCallAt ? Date.parse(ctx.lastCustomerCallAt) : NaN;
  if (!Number.isFinite(called) || called < arrived) return { ok: false, error: "call_first" };

  const waitMs = Math.max(0, ctx.unreachableWaitMinutes) * MINUTE;
  const waited = ctx.now - arrived;
  if (waited < waitMs) {
    return { ok: false, error: "wait_longer", minutesLeft: Math.max(1, Math.ceil((waitMs - waited) / MINUTE)) };
  }
  return { ok: true };
}
