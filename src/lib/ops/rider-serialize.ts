/**
 * Database rows → the pinned Phase 5 shapes for payment requests, cash deposits,
 * cash disputes and delivery exceptions. Pure; shared by the rider detail and
 * the Approvals, Cash and Exceptions routes so each shape is built once.
 */
import { orderShortCode } from "./order-contract";
import type { PersonRef } from "./vendor-contract";
import type { CashDeposit, CashDispute, DeliveryException, ExceptionKind, PaymentRequest } from "./rider-contract";

export interface Viewer {
  id: string;
  perms: Record<string, boolean>;
  isAdmin: boolean;
}

export interface Names {
  person(id: string | null | undefined): PersonRef | null;
  rider(id: string): { id: string; name: string; code: string | null; phone: string | null };
  zone(id: string | null | undefined): { id: string; name: string } | null;
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Whether this viewer may approve or reject the request: it is pending, they
 * hold approve_payment (an admin always does) and they did not request it.
 * The database refuses `same_person` regardless (0152).
 */
export function canDecide(r: { requestedBy: string; status: string }, viewer: Viewer): boolean {
  if (r.status !== "pending_approval") return false;
  if (r.requestedBy === viewer.id) return false;
  return viewer.isAdmin || viewer.perms["manager.finance.approve_payment"] === true;
}

export interface PaymentRequestRow {
  id: string;
  kind: string;
  subject_id: string;
  zone_id: string | null;
  amount: number | string;
  period_end: string | null;
  salary_amount: number | string | null;
  method: string | null;
  note: string | null;
  status: string;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  reference: string | null;
  paid_on: string | null;
  result_id: string | null;
}

export const PAYMENT_REQUEST_COLUMNS =
  "id, kind, subject_id, zone_id, amount, period_end, salary_amount, method, note, status, requested_by, requested_at, decided_by, decided_at, decision_note, reference, paid_on, result_id";

export function toPaymentRequest(r: PaymentRequestRow, names: Names, viewer: Viewer): PaymentRequest {
  const subject = names.rider(r.subject_id);
  return {
    id: r.id,
    kind: r.kind as PaymentRequest["kind"],
    subject: { id: subject.id, name: subject.name, code: subject.code },
    zone: names.zone(r.zone_id),
    amount: num(r.amount),
    periodEnd: r.period_end,
    salaryAmount: numOrNull(r.salary_amount),
    method: (r.method as PaymentRequest["method"]) ?? null,
    note: r.note,
    status: r.status as PaymentRequest["status"],
    requestedBy: names.person(r.requested_by) ?? { id: r.requested_by, name: "Staff" },
    requestedAt: r.requested_at,
    decidedBy: names.person(r.decided_by),
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    reference: r.reference,
    paidOn: r.paid_on,
    resultId: r.result_id,
    canDecide: canDecide({ requestedBy: r.requested_by, status: r.status }, viewer),
  };
}

export interface CashDepositRow {
  id: string;
  driver_id: string;
  amount: number;
  method: string;
  reference: string | null;
  photo_path: string | null;
  note: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  handover_id: string | null;
  created_at: string;
}

export const CASH_DEPOSIT_COLUMNS =
  "id, driver_id, amount, method, reference, photo_path, note, status, decided_by, decided_at, decision_note, handover_id, created_at";

export function toCashDeposit(r: CashDepositRow, names: Names): CashDeposit {
  const rider = names.rider(r.driver_id);
  return {
    id: r.id,
    rider: { id: rider.id, name: rider.name, code: rider.code },
    amount: num(r.amount),
    method: r.method as CashDeposit["method"],
    reference: r.reference,
    hasPhoto: !!r.photo_path,
    note: r.note,
    status: r.status as CashDeposit["status"],
    decidedBy: names.person(r.decided_by),
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    handoverId: r.handover_id,
    createdAt: r.created_at,
  };
}

export interface CashDisputeRow {
  id: string;
  driver_id: string;
  day: string;
  claimed_amount: number | null;
  message: string;
  status: string;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
}

export const CASH_DISPUTE_COLUMNS = "id, driver_id, day, claimed_amount, message, status, resolution, resolved_at, created_at";

export function toCashDispute(r: CashDisputeRow, names: Names): CashDispute {
  const rider = names.rider(r.driver_id);
  return {
    id: r.id,
    rider: { id: rider.id, name: rider.name, code: rider.code },
    day: r.day,
    claimedAmount: numOrNull(r.claimed_amount),
    message: r.message,
    status: r.status as CashDispute["status"],
    resolution: r.resolution,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  };
}

const REPORT_KINDS = new Set(["return_to_shop", "missing_items", "wrong_package", "vendor_delay", "other_issue", "other"]);

/** Reports are acknowledged; requests approved or rejected (0082's status-for-kind rule). */
export function isReportKind(kind: string): boolean {
  return REPORT_KINDS.has(kind);
}

export interface ExceptionRow {
  id: string;
  order_id: string;
  driver_id: string;
  kind: string;
  reason: string;
  notes: string | null;
  photo_path: string | null;
  lat: number | null;
  lng: number | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

export const EXCEPTION_COLUMNS =
  "id, order_id, driver_id, kind, reason, notes, photo_path, lat, lng, status, decided_by, decided_at, decision_note, created_at";

/**
 * The pinned DeliveryException. `kind` is exactly what 0082 stores (the
 * catch-all report is `other_issue`; the plan's contract said `other`, and the
 * app accepts both — aligned to the stored value at Phase 5, recorded in the
 * plan). `decisions` is what THIS viewer can do: nothing once decided or
 * without manager.exceptions.decide.
 */
export function serializeException(r: ExceptionRow, names: Names, viewerPerms: Record<string, boolean>): DeliveryException {
  const report = isReportKind(r.kind);
  const decidable = r.status === "pending" && viewerPerms["manager.exceptions.decide"] === true;
  return {
    id: r.id,
    orderId: r.order_id,
    orderCode: orderShortCode(r.order_id),
    rider: names.rider(r.driver_id),
    kind: r.kind as ExceptionKind,
    reason: r.reason,
    notes: r.notes,
    hasPhoto: !!r.photo_path,
    lat: r.lat,
    lng: r.lng,
    status: r.status as DeliveryException["status"],
    decidedBy: names.person(r.decided_by),
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    createdAt: r.created_at,
    decisions: decidable ? (report ? ["acknowledge"] : ["approve", "reject"]) : [],
  };
}
