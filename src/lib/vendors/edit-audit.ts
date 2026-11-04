/**
 * The audit entry for a shop edit. Pure.
 *
 * Commission, hours and the like are logged with their old and new values. Contact,
 * bank and legal details are named but their values are never written: the audit log
 * says "bank account changed", not what it changed to (the same rule the ops RPCs keep).
 */

type RowValues = Record<string, unknown>;

const LOGGED = [
  "name", "category", "tagline", "description", "commission_pct", "min_order", "delivery_available", "self_pickup",
  "opening_time", "closing_time", "weekly_off", "landmark", "pincode", "lat", "lng", "image_url", "zone_id",
  "accept_cod", "accept_online", "cod_max_order", "other_charges_per_order", "settlement_cycle",
] as const;

const NAMED_ONLY = [
  "owner_name", "owner_mobile", "owner_alt_mobile", "owner_email", "address",
  "upi_id", "bank_account_name", "bank_account_number", "bank_ifsc", "bank_name",
  "fssai_number", "gst_number", "pan_number",
] as const;

/** Empty text and null are the same fact; "5" and 5 are too (numeric columns can arrive as text). */
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === null || v === undefined || v === "" ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return norm(a) === norm(b);
}

/** The database hands back "09:00:00"; the form sends "09:00". */
const TIME_COLUMNS = new Set<string>(["opening_time", "closing_time"]);
const comparable = (key: string, v: unknown) => (TIME_COLUMNS.has(key) && typeof v === "string" ? v.slice(0, 5) : v);

export interface VendorEditAudit {
  /** Nothing differs: no entry to write. */
  empty: boolean;
  before: RowValues;
  after: RowValues;
}

export function vendorEditAudit(beforeRow: RowValues, afterRow: RowValues): VendorEditAudit {
  const before: RowValues = {};
  const after: RowValues = {};
  for (const key of LOGGED) {
    if (key in afterRow && !same(comparable(key, beforeRow[key]), comparable(key, afterRow[key]))) {
      before[key] = beforeRow[key] ?? null;
      after[key] = afterRow[key] ?? null;
    }
  }
  const named = NAMED_ONLY.filter((key) => key in afterRow && !same(beforeRow[key], afterRow[key]));
  if (named.length > 0) after.details_changed = named;
  return { empty: Object.keys(after).length === 0, before, after };
}
