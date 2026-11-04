import { isDayKey, isZeroDelivery } from "@/lib/rider/earnings-math";
import type { AdjustmentKind, EarningRecord } from "@/lib/rider/earnings-math";

/**
 * The admin Riders section's pure half: what an operator typed, judged before
 * anything is sent to the database, and the sentences that come back.
 *
 * No I/O and no `server-only`, so the same functions run in the server actions
 * (the authority), in the Record-payout form (the live "This will settle ₹X"
 * line) and in `scripts/qa/admin-riders.ts`.
 *
 * ## Why the parsers repeat what the database already refuses
 *
 * 0083 has CHECK constraints for every rule below (`rider_adjustments_amount_sign`,
 * `rider_incentive_rules_window_pair`, `rider_payouts_paid_after_period`, ...),
 * and they are the floor. A constraint violation says `23514` and names a
 * constraint; an operator needs "a deduction is entered as a positive amount".
 * So each parser refuses first, in words, and the database stays the last word.
 * The parsers are deliberately a little STRICTER than the database in two
 * places a typo would otherwise sail through: an adjustment or payout cannot be
 * dated in the future, and amounts are capped at ₹10,00,000.
 *
 * Money is `numeric(10,2)`: at most two decimals, and a typed "12.345" is
 * refused rather than rounded (a rounded payout is a payout nobody typed).
 */

/** What every admin money action answers. */
export interface ActionResult {
  ok: boolean;
  error?: string;
  /** What happened, in a sentence, when it did. */
  message?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** `FormData`, or anything with a `get`. */
export interface FormLike {
  get(name: string): unknown;
}

/** Salary first: riders are paid a fixed salary, so it is what an entry usually is (P3-R11). */
// Riders get a fixed salary only (rule book): no new bonus entries. Old ones stay on
// the ledger, which is why AdjustmentKind still names the kind.
export const ADJUSTMENT_KINDS = ["salary", "adjustment", "deduction"] as const;
/** What "Add an entry" starts on. */
export const DEFAULT_ADJUSTMENT_KIND: (typeof ADJUSTMENT_KINDS)[number] = "salary";
export const ADJUSTMENT_LABELS: Record<AdjustmentKind, string> = {
  bonus: "Older pay",
  adjustment: "Adjustment (+ or −)",
  deduction: "Deduction",
  salary: "Salary",
};
export const PAYOUT_METHODS = ["bank", "upi", "cash", "other"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];
export const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
  bank: "Bank transfer",
  upi: "UPI",
  cash: "Cash",
  other: "Other",
};

/** The largest single amount an operator may enter (₹10,00,000). */
export const MONEY_CEILING = 1_000_000;
const REASON_MAX = 300;
const NOTE_MAX = 300;
const REFERENCE_MAX = 120;

// ---------------------------------------------------------------------------
// reading fields
// ---------------------------------------------------------------------------

/** A text field; a missing one, and a File posted where text was expected, read as "". */
function text(form: FormLike, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * Rupees as typed: "500", "1,250.50", "₹75", "-20". At most two decimals; no
 * exponent, no "NaN", nothing above the ceiling. Returns the amount to the
 * paisa.
 */
function money(raw: string, label: string): Parsed<number> {
  const s = raw.replace(/[₹,\s]/g, "");
  if (s === "") return fail(`Enter the ${label} in rupees.`);
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(s)) {
    return fail(`The ${label} must be a plain number of rupees with at most two decimals (for example 250 or 250.50).`);
  }
  const n = Math.round(Number(s) * 100) / 100;
  if (Math.abs(n) > MONEY_CEILING) {
    return fail(`The ${label} is above ₹10,00,000 - check for a stray digit.`);
  }
  return { ok: true, value: n };
}

/** A calendar day (`YYYY-MM-DD`), optionally defaulting to today, never after `today`. */
function day(raw: string, label: string, today: string, opts: { blankIsToday?: boolean } = {}): Parsed<string> {
  if (raw === "" && opts.blankIsToday) return { ok: true, value: today };
  if (raw === "") return fail(`Pick the ${label}.`);
  if (!isDayKey(raw)) return fail(`The ${label} is not a real date.`);
  if (raw > today) return fail(`The ${label} can't be after today.`);
  return { ok: true, value: raw };
}

// ---------------------------------------------------------------------------
// adjustments
// ---------------------------------------------------------------------------

export interface AdjustmentInput {
  kind: AdjustmentKind;
  /** Stored as typed: a deduction is positive (the ledger subtracts it); an adjustment is signed. */
  amount: number;
  reason: string;
  /** The 8-character code of an order this rider delivered, or null. */
  orderCode: string | null;
  effectiveOn: string;
}

/**
 * `kind`, `amount`, `reason`, `orderCode?`, `effectiveOn`. The sign rule is
 * `rider_adjustments_amount_sign`: salary and deduction are positive
 * (a deduction is entered positive and subtracted); an adjustment is signed
 * and never zero.
 */
export function parseAdjustment(form: FormLike, ctx: { today: string }): Parsed<AdjustmentInput> {
  const kind = text(form, "kind") as (typeof ADJUSTMENT_KINDS)[number];
  if (!ADJUSTMENT_KINDS.includes(kind)) return fail("Choose what kind of entry this is.");

  const amount = money(text(form, "amount"), "amount");
  if (!amount.ok) return amount;
  if (kind === "adjustment") {
    if (amount.value === 0) return fail("An adjustment can't be ₹0. Enter a positive or a negative amount.");
  } else if (amount.value <= 0) {
    return fail(
      kind === "deduction"
        ? "Enter a deduction as a positive amount - it is subtracted from what the rider is owed."
        : `A ${kind} must be more than ₹0. To take money away, use a deduction or a negative adjustment.`
    );
  }

  const reason = text(form, "reason");
  if (!reason) return fail("Give a reason - the rider can read it in their app.");
  if (reason.length > REASON_MAX) return fail(`Keep the reason under ${REASON_MAX} characters.`);

  const rawCode = text(form, "orderCode").replace(/^#/, "").toUpperCase();
  if (rawCode && !/^[0-9A-F]{8}$/.test(rawCode)) {
    return fail("The order code is the 8 characters after # on the order (for example #A1B2C3D4).");
  }

  const effectiveOn = day(text(form, "effectiveOn"), "date it belongs to", ctx.today, { blankIsToday: true });
  if (!effectiveOn.ok) return effectiveOn;

  return {
    ok: true,
    value: { kind, amount: amount.value, reason, orderCode: rawCode || null, effectiveOn: effectiveOn.value },
  };
}

// ---------------------------------------------------------------------------
// payouts
// ---------------------------------------------------------------------------

export interface PayoutInput {
  periodEnd: string;
  method: PayoutMethod;
  reference: string | null;
  paidOn: string;
  note: string | null;
}

/**
 * `periodEnd`, `method`, `reference?`, `paidOn`, `note?`. The database refuses a
 * period ending after today (IST) and a `paid_on` before the period end
 * (`invalid_payout`); this says so before the call. With `payNow` the admin is
 * approving their own payment in the same step (0152), so the reference and the
 * reason the database requires are required here too.
 */
export function parsePayout(form: FormLike, ctx: { today: string; payNow?: boolean }): Parsed<PayoutInput> {
  const periodEnd = day(text(form, "periodEnd"), "settle-up-to date", ctx.today);
  if (!periodEnd.ok) return periodEnd;

  const method = text(form, "method") as PayoutMethod;
  if (!PAYOUT_METHODS.includes(method)) return fail("Choose how the rider was paid: bank, UPI, cash or other.");

  const paidOn = day(text(form, "paidOn"), "payment date", ctx.today, { blankIsToday: true });
  if (!paidOn.ok) return paidOn;
  if (paidOn.value < periodEnd.value) {
    return fail("The payment date can't be before the day the period ends - a payout never precedes the earnings it settles.");
  }

  const reference = text(form, "reference");
  if (reference.length > REFERENCE_MAX) return fail(`Keep the reference under ${REFERENCE_MAX} characters.`);
  const note = text(form, "note");
  if (note.length > NOTE_MAX) return fail(`Keep the note under ${NOTE_MAX} characters.`);
  if (ctx.payNow) {
    if (!reference) return fail("Enter the payment reference from your bank or UPI app.");
    if (note.length < 3) return fail("Write a short reason for this payment (at least 3 characters).");
  }

  return {
    ok: true,
    value: { periodEnd: periodEnd.value, method, reference: reference || null, paidOn: paidOn.value, note: note || null },
  };
}

/** The part of a record the preview needs. */
export type PendingItem = Pick<EarningRecord, "id" | "kind" | "date" | "amount" | "reversesId">;

export interface PayoutPreview {
  /** The net a payment up to that date would settle (may be zero or negative). */
  amount: number;
  /** How many ledger rows it would attach. */
  items: number;
  /** Whether it would pay at all: the database refuses `nothing_to_pay` at ≤ ₹0. */
  payable: boolean;
}

const paise = (x: number) => Math.round(x * 100);

/**
 * What a payment up to `periodEnd` would settle, from the rider's unattached
 * records. The database's selection rule (`_rider_payout_preview`, 0152), row
 * for row:
 *
 *   earnings and awards  dated (IST) on or before `periodEnd`
 *   adjustments          `effective_on` on or before `periodEnd`, PLUS the
 *                        reversal of any earning the payout attaches even when
 *                        the reversal is dated after (ruling P3-R6)
 *
 * It is a preview: a delivery landing, or another admin recording a payout,
 * between this reading and the click changes the answer. The action therefore
 * reports what the database actually recorded.
 */
export function previewPayout(pending: readonly PendingItem[], periodEnd: string): PayoutPreview {
  const attachedEarnings = new Set(
    pending.filter((r) => r.kind === "delivery" && r.date <= periodEnd).map((r) => r.id)
  );
  const chosen = pending.filter((r) => {
    if (r.date <= periodEnd) return true;
    return r.reversesId !== null && attachedEarnings.has(r.reversesId);
  });
  const total = chosen.reduce((sum, r) => sum + paise(r.amount), 0);
  // ₹0 per-delivery rows (a salaried fleet) still attach to the payout, but they
  // are not something the operator is settling: leave them out of the item count.
  const items = chosen.filter((r) => !isZeroDelivery(r)).length;
  return { amount: total / 100, items, payable: total > 0 };
}

// ---------------------------------------------------------------------------
// what the database said, as sentences
// ---------------------------------------------------------------------------

export interface DbError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

/** What a screen says in place of the money it can't show yet. */
export const MIGRATION_MISSING = "Rider money isn't set up on this database yet";
export const MIGRATION_PENDING_MESSAGE = `${MIGRATION_MISSING}, so nothing was saved.`;

/** PostgREST / Postgres codes for "that table, column or function isn't there". */
const MISSING = new Set(["PGRST202", "PGRST204", "PGRST205", "42P01", "42703", "42883"]);

/** True when the error means the 0083 schema is absent. */
export function isSchemaMissing(error: DbError | null | undefined): boolean {
  return !!error?.code && MISSING.has(error.code);
}

/**
 * A rider payment's refusals (the codes `mapPaymentRpcError` and the body parser
 * answer with), as sentences. Raw database text never reaches the operator.
 */
export function riderPaymentMessage(code: string, extra: { amount?: number } = {}): string {
  switch (code) {
    case "nothing_to_pay":
      return "There is nothing to pay up to that date: what this rider is owed comes to ₹0 or less. Pick a later date, or check the records.";
    case "duplicate_pending":
      return "This rider already has a salary payment waiting. Decide that one on Rider salaries first.";
    case "same_person":
      return "You asked for this payment, so someone else must approve it.";
    case "not_requester":
      return "Only the person who asked for a payment can cancel it.";
    case "reference_required":
    case "reference":
      return "Enter the payment reference from your bank or UPI app.";
    case "note_required":
      return "Write a short reason (at least 3 characters).";
    case "amount_changed":
      return `The rider's records changed, so this payment is now ${formatMoney(extra.amount ?? 0)}. Check it and approve again.`;
    case "already_decided":
      return "This payment was already decided. Refresh to see it.";
    case "paidOn":
      return "The payment date can't be in the future.";
    case "not_found":
      return "That payment or rider no longer exists.";
    default:
      return "That didn't go through, and no money was recorded. Try again.";
  }
}

/** A refused adjustment write, as a sentence. */
export function writeErrorMessage(error: DbError): string {
  if (isSchemaMissing(error)) return MIGRATION_PENDING_MESSAGE;
  if (error.code === "42501") {
    return "The database says this account is not allowed to write rider money. Only an admin account can.";
  }
  if (error.code === "23514" || error.code === "22P02" || error.code === "22007") {
    return "The database rejected those values (a check failed). Review the entry and try again.";
  }
  return "Couldn't save the entry. Nothing was changed - try again, and if it keeps failing check the server logs.";
}

// ---------------------------------------------------------------------------
// display
// ---------------------------------------------------------------------------

/** "₹1,250", "₹1,250.50", "-₹30": rupees, Indian grouping, paise only when there are some. */
export function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return "₹0";
  const whole = Math.abs(paise(n)) % 100 === 0;
  const body = Math.abs(n).toLocaleString("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 && paise(n) !== 0 ? "-" : ""}₹${body}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-22" -> "22 Oct 2026". Anything that is not a day key comes back unchanged. */
export function formatDay(day: string | null | undefined): string {
  if (!day || !isDayKey(day)) return day ?? "";
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

/** How a delivery's pay was made up, for the Money tab: "₹20 base + ₹12 distance (4 km by road) + ₹5 tip". */
export function deliveryDetail(r: Pick<EarningRecord, "baseFee" | "distanceKm" | "distanceSource" | "distanceFee" | "minTopup" | "tip" | "tipInCash">): string {
  const parts = [`${formatMoney(r.baseFee ?? 0)} base`];
  const km = r.distanceKm ?? 0;
  if ((r.distanceFee ?? 0) > 0) {
    const how = r.distanceSource === "road" ? "by road" : r.distanceSource === "estimate" ? "estimated" : "";
    parts.push(`${formatMoney(r.distanceFee ?? 0)} distance (${km} km${how ? ` ${how}` : ""})`);
  }
  if ((r.minTopup ?? 0) > 0) parts.push(`${formatMoney(r.minTopup ?? 0)} minimum top-up`);
  if ((r.tip ?? 0) > 0) parts.push(r.tipInCash ? `${formatMoney(r.tip ?? 0)} tip paid in cash (not in this amount)` : `${formatMoney(r.tip ?? 0)} tip`);
  const detail = parts.join(" + ");
  return km === 0 && r.distanceSource === null ? `${detail} - distance not recorded` : detail;
}

/**
 * The confirmation after a payout: what the database ACTUALLY recorded (read
 * back from the payout row), and - when the preview the operator saw named a
 * different figure - why that can be.
 */
export function describePayout(
  recorded: { amount: number; items: number; paidOn: string; periodEnd: string },
  method: PayoutMethod,
  previewed: number | null
): string {
  const items = `${recorded.items} ${recorded.items === 1 ? "item" : "items"}`;
  const drift =
    previewed !== null && paise(previewed) !== paise(recorded.amount)
      ? ` The preview said ${formatMoney(previewed)}; the amount differs because the ledger changed after the page loaded.`
      : "";
  return `Recorded ${formatMoney(recorded.amount)} paid by ${PAYOUT_METHOD_LABELS[method].toLowerCase()} on ${formatDay(recorded.paidOn)} (${items} up to ${formatDay(recorded.periodEnd)}).${drift}`;
}
