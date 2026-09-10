import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  effectiveCommissionPct,
  getVendorCommissionDefault,
} from "@/lib/data-access/admin-commission";
import { VENDOR_STATUSES, type VendorStatus } from "@/lib/vendor-status";
import { assertCanGoLive, isPinned } from "@/lib/vendors/readiness";
import {
  DEFAULT_SETTLEMENT_CYCLE,
  isSettlementCycle,
  type SettlementCycle,
} from "@/lib/settlements/cycle";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import { legiblePassword } from "@/lib/utils/password";
import { toE164 } from "@/lib/auth/phone";
import { checkOtp } from "@/lib/data-access/otp";
import { getVendorPositions } from "@/lib/data-access/vendor-positions";
import {
  getVendorCredential,
  listVendorCredentials,
  storeVendorCredential,
} from "@/lib/data-access/vendor-credentials";

// Re-exported so existing importers keep working; the canonical definition lives
// in the client-safe @/lib/vendor-status module.
export { VENDOR_STATUSES };
export type { VendorStatus };

/**
 * Admin-facing vendor management, over the `restaurants` table (+ owner
 * `profiles`). A "vendor" is a restaurant owned by a role='restaurant' profile;
 * these functions are the admin CRUD/oversight surface for them.
 *
 * Reads and ordinary writes ride the `is_admin()` RLS policies through the
 * cookie-bound `createClient()` — the admin layout has already gated the caller,
 * and RLS is the second lock. Only the operations RLS can't express — creating
 * an auth user's password, hard-deleting an account — reach for the service-role
 * `createAdminClient()`, and the calling server action re-gates with
 * requireRole("admin") first.
 *
 * Everything here needs migration 0017. Until it's applied, selecting the new
 * columns is a hard PostgREST error, so reads degrade to empty and the list page
 * shows a "preview mode" banner (mirrors the banners rollout).
 */

export interface VendorCounts {
  total: number;
  active: number;
  inactive: number;
  pending: number;
  suspended: number;
  categories: number;
  /**
   * Shops with no map pin, across the whole roster. Counted separately from the
   * other storefront gaps because it is the one that stops a shop working
   * rather than merely looking unfinished — `createOrder` refuses an order it
   * cannot range-check. See `lib/vendors/readiness.ts`.
   */
  unpinned: number;
}

export interface VendorListItem {
  id: string;
  slug: string;
  name: string;
  ownerName: string | null;
  ownerMobile: string | null;
  /**
   * The address the owner signs in with. Required since 0039 — a vendor with no
   * email cannot be issued a password, and mobile+password login resolves the
   * account through it.
   */
  ownerEmail: string | null;
  category: string | null;
  address: string | null;
  commissionPct: number | null;
  /** `commissionPct` with the platform default already applied. */
  effectiveCommissionPct: number;
  /** True when this vendor tracks the platform rate rather than its own. */
  inheritsPlatformRate: boolean;
  status: VendorStatus;
  isOpen: boolean;
  imageUrl: string | null;
  accentTint: string | null;
  createdAt: string;
  /**
   * The shop's map pin. On the LIST row, not just the detail, because an
   * unpinned shop is a storefront gap an admin has to chase — see
   * `storefrontGaps` and `lib/vendors/readiness.ts`.
   */
  lat: number | null;
  lng: number | null;
  /** Customer rating (0002), and how many ratings it is an average of. */
  rating: number;
  ratingCount: number;
  /** Manual featured slot 1–10, or null when unranked (migration 0021). */
  sortPosition: number | null;
  /**
   * The hand-off login password an admin can read back to the owner, or null
   * when none has been issued (or 0039 isn't applied). Populated only by the
   * admin-gated list/detail reads — see @/lib/data-access/vendor-credentials.
   */
  loginPassword: string | null;
}

/**
 * What is still missing from this shop's storefront, named the way an admin
 * would say it on the phone to the owner.
 *
 * Derived from the list columns alone — no extra query — so the catalogue can
 * show it on every card. It answers the question the admin vendors page exists
 * for: not "who is on the platform" but "who is not finished yet", which is the
 * difference between a listing that converts and one customers scroll past.
 *
 * Deliberately not the same list as the vendor's own profile checklist
 * (`getVendorProfileSummary`): that one can see taglines, cuisines and opening
 * hours, and this one is working from a directory row. Fewer items, all of them
 * things an admin can actually chase.
 */
export function storefrontGaps(v: VendorListItem): string[] {
  const gaps: string[] = [];
  if (!v.imageUrl) gaps.push("photo");
  if (!v.category) gaps.push("category");
  if (!v.address) gaps.push("address");
  if (!v.ownerMobile) gaps.push("phone");
  // Listed FIRST in severity terms even though it is appended last: a missing
  // photo costs a shop some orders, a missing pin stops it taking any. Without
  // one the delivery radius cannot be checked (so `createOrder` refuses), the
  // delivery time cannot be estimated, and the customer's map has no origin.
  // 68 of 70 shops were in this state and nothing on this page said so.
  if (!isPinned(v)) gaps.push("map pin");
  return gaps;
}

/** Storefront completeness as a percentage, from the same five checks. */
export function storefrontScore(v: VendorListItem): number {
  const CHECKS = 5;
  return Math.round(((CHECKS - storefrontGaps(v).length) / CHECKS) * 100);
}

export interface VendorDetail extends VendorListItem {
  ownerId: string;
  tagline: string | null;
  description: string | null;
  ownerAltMobile: string | null;
  cuisines: string[];
  minOrder: number;
  deliveryAvailable: boolean;
  selfPickup: boolean;
  openingTime: string | null;
  closingTime: string | null;
  weeklyOff: string[];
  landmark: string | null;
  pincode: string | null;
  lat: number | null;
  lng: number | null;
  upiId: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  fssaiNumber: string | null;
  gstNumber: string | null;
  panNumber: string | null;
  tcAcceptedAt: string | null;
  tcVersion: string | null;
  /* ---- payment rules & payout terms (0034) ---- */
  /** This shop takes cash on delivery. */
  acceptCod: boolean;
  /** This shop takes online payment (still ANDed with the platform switch). */
  acceptOnline: boolean;
  /** Highest order total payable in cash, whole rupees. 0 = no limit. */
  codMaxOrder: number;
  /** Fixed per-order deduction from the payout, whole rupees. */
  otherChargesPerOrder: number;
  /** How often this vendor is paid out. */
  settlementCycle: SettlementCycle;
  menuItemCount: number;
  /** When an admin last issued a login password — see resetVendorPassword. */
  passwordResetAt: string | null;
  ownerPhoneVerified: boolean;
}

/** The admin-editable business fields (not slug, not status, not the account). */
export interface VendorInput {
  name: string;
  category: string | null;
  ownerName: string | null;
  ownerMobile: string | null;
  ownerAltMobile: string | null;
  ownerEmail: string | null;
  tagline: string | null;
  description: string | null;
  commissionPct: number | null;
  minOrder: number;
  deliveryAvailable: boolean;
  selfPickup: boolean;
  openingTime: string | null;
  closingTime: string | null;
  weeklyOff: string[];
  address: string | null;
  landmark: string | null;
  pincode: string | null;
  upiId: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  fssaiNumber: string | null;
  gstNumber: string | null;
  panNumber: string | null;
  acceptCod: boolean;
  acceptOnline: boolean;
  codMaxOrder: number;
  otherChargesPerOrder: number;
  settlementCycle: SettlementCycle;
}

export type VendorSort = "recent" | "oldest" | "name" | "status";

export interface ListVendorsOptions {
  q?: string;
  status?: VendorStatus | "all";
  category?: string;
  sort?: VendorSort;
  page?: number;
  pageSize?: number;
}

export interface ListVendorsResult {
  items: VendorListItem[];
  total: number;
  page: number;
  pageSize: number;
}

const LIST_SELECT = `
  id, slug, name, owner_name, owner_mobile, owner_email, category, address,
  commission_pct, status, is_open, image_url, accent_tint, created_at,
  rating, rating_count, lat, lng
`;

const DETAIL_SELECT = `
  id, slug, name, owner_id, tagline, description,
  owner_name, owner_mobile, owner_alt_mobile, owner_email, category, cuisines,
  commission_pct, min_order, delivery_available, self_pickup,
  opening_time, closing_time, weekly_off,
  address, landmark, pincode, lat, lng,
  upi_id, bank_account_name, bank_account_number, bank_ifsc, bank_name,
  fssai_number, gst_number, pan_number,
  status, is_open, image_url, accent_tint, rating, rating_count,
  tc_accepted_at, tc_version, created_at,
  password_reset_at, owner_phone_verified
`;

/**
 * The 0034 columns, asked for separately.
 *
 * Not folded into DETAIL_SELECT because `getVendorDetail` treats a missing
 * column as "return null", i.e. a 404 on the vendor page. A database that has
 * 0017 but not 0034 would lose the entire vendor screen over a payment toggle,
 * which is a far worse outcome than showing the defaults. Probed once and
 * remembered, so the cost is one extra round trip on a cold process.
 */
const PAYMENT_RULE_COLUMNS = "restaurants.settlement_cycle";
const PAYMENT_RULE_SELECT =
  "accept_cod, accept_online, cod_max_order, other_charges_per_order, settlement_cycle";

interface VendorRow {
  id: string;
  slug: string;
  name: string;
  owner_id?: string;
  tagline?: string | null;
  description?: string | null;
  owner_name: string | null;
  owner_mobile: string | null;
  owner_alt_mobile?: string | null;
  owner_email?: string | null;
  category: string | null;
  cuisines?: string[] | null;
  commission_pct: number | null;
  min_order?: number | null;
  delivery_available?: boolean | null;
  self_pickup?: boolean | null;
  opening_time?: string | null;
  closing_time?: string | null;
  weekly_off?: string[] | null;
  address: string | null;
  rating?: number | null;
  rating_count?: number | null;
  landmark?: string | null;
  pincode?: string | null;
  lat?: number | null;
  lng?: number | null;
  upi_id?: string | null;
  bank_account_name?: string | null;
  bank_account_number?: string | null;
  bank_ifsc?: string | null;
  bank_name?: string | null;
  fssai_number?: string | null;
  gst_number?: string | null;
  pan_number?: string | null;
  status: VendorStatus;
  is_open: boolean;
  image_url: string | null;
  accent_tint: string | null;
  tc_accepted_at?: string | null;
  tc_version?: string | null;
  created_at: string;
  password_reset_at?: string | null;
  owner_phone_verified?: boolean | null;
  // 0034 — read through a separate probe, see PAYMENT_RULE_SELECT.
  accept_cod?: boolean | null;
  accept_online?: boolean | null;
  cod_max_order?: number | null;
  other_charges_per_order?: number | null;
  settlement_cycle?: SettlementCycle | null;
}

/** Table missing (42P01/PGRST205) or a 0017 column missing (42703). */
function isMissingSchema(
  error: { code?: string; message?: string } | null
): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const msg = (error.message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST205" ||
    code === "PGRST204" ||
    msg.includes("schema cache") ||
    msg.includes("does not exist")
  );
}

function mapListItem(row: VendorRow, platformDefault = 0): VendorListItem {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    ownerName: row.owner_name,
    ownerMobile: row.owner_mobile,
    ownerEmail: row.owner_email ?? null,
    category: row.category,
    address: row.address,
    // null means "inherit the platform rate" — see migration 0032. Preserved as
    // null rather than coerced to 0, which would read as "this vendor is free".
    commissionPct:
      row.commission_pct === null ? null : Number(row.commission_pct),
    // What this vendor is actually billed, with the platform rate already
    // resolved — every screen that just prints a percentage wants this one.
    effectiveCommissionPct: effectiveCommissionPct(
      row.commission_pct === null ? null : Number(row.commission_pct),
      platformDefault
    ),
    inheritsPlatformRate: row.commission_pct === null,
    status: row.status,
    isOpen: row.is_open,
    imageUrl: row.image_url,
    accentTint: row.accent_tint,
    createdAt: row.created_at,
    rating: Number(row.rating ?? 0),
    ratingCount: Number(row.rating_count ?? 0),
    // Coerced through Number() like the other numerics: PostgREST can hand back
    // a double precision column as a string, and `isPinned` correctly refuses a
    // string — which would report every pinned shop as unpinned.
    lat: row.lat === null || row.lat === undefined ? null : Number(row.lat),
    lng: row.lng === null || row.lng === undefined ? null : Number(row.lng),
    // Filled in by the caller from the resilient positions read (0021).
    sortPosition: null,
    // Filled in by the caller from the service-role credentials read (0039).
    loginPassword: null,
  };
}

function mapDetail(
  row: VendorRow,
  menuItemCount: number,
  platformDefault = 0
): VendorDetail {
  return {
    ...mapListItem(row, platformDefault),
    ownerId: row.owner_id ?? "",
    tagline: row.tagline ?? null,
    description: row.description ?? null,
    ownerAltMobile: row.owner_alt_mobile ?? null,
    cuisines: (row.cuisines ?? []) as string[],
    minOrder: Number(row.min_order ?? 0),
    deliveryAvailable: row.delivery_available ?? true,
    selfPickup: row.self_pickup ?? false,
    openingTime: row.opening_time ?? null,
    closingTime: row.closing_time ?? null,
    weeklyOff: (row.weekly_off ?? []) as string[],
    landmark: row.landmark ?? null,
    pincode: row.pincode ?? null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    upiId: row.upi_id ?? null,
    bankAccountName: row.bank_account_name ?? null,
    bankAccountNumber: row.bank_account_number ?? null,
    bankIfsc: row.bank_ifsc ?? null,
    bankName: row.bank_name ?? null,
    fssaiNumber: row.fssai_number ?? null,
    gstNumber: row.gst_number ?? null,
    panNumber: row.pan_number ?? null,
    tcAcceptedAt: row.tc_accepted_at ?? null,
    tcVersion: row.tc_version ?? null,
    // Absent columns (pre-0034) read as the permissive defaults, which is how
    // the app behaved before the feature existed. A missing migration must not
    // start refusing payment methods.
    acceptCod: row.accept_cod ?? true,
    acceptOnline: row.accept_online ?? true,
    codMaxOrder: Math.max(0, Math.round(Number(row.cod_max_order ?? 0))),
    otherChargesPerOrder: Math.max(
      0,
      Math.round(Number(row.other_charges_per_order ?? 0))
    ),
    settlementCycle: isSettlementCycle(row.settlement_cycle)
      ? row.settlement_cycle
      : DEFAULT_SETTLEMENT_CYCLE,
    menuItemCount,
    passwordResetAt: row.password_reset_at ?? null,
    ownerPhoneVerified: row.owner_phone_verified ?? false,
    // Attached by getVendorDetail from the resilient positions read (0021).
    sortPosition: null,
  };
}

/**
 * Cheap probe: has 0017 been applied? Selecting the `status` column head-only
 * costs nothing; a missing-column error means the migration hasn't run.
 */
export async function vendorsBackendReady(): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("restaurants")
    .select("id, status", { head: true, count: "exact" })
    .limit(1);
  if (error) return !isMissingSchema(error);
  return true;
}

/** A `.or()`-safe ilike needle — strip the chars that break PostgREST filters. */
function ilikeNeedle(q: string): string {
  const cleaned = q.replace(/[,()%*\\]/g, " ").trim();
  return `%${cleaned}%`;
}

const SORT_MAP: Record<VendorSort, { column: string; ascending: boolean }> = {
  recent: { column: "created_at", ascending: false },
  oldest: { column: "created_at", ascending: true },
  name: { column: "name", ascending: true },
  status: { column: "status", ascending: true },
};

export async function listVendors(
  opts: ListVendorsOptions = {}
): Promise<ListVendorsResult> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // LIST_SELECT includes owner_mobile, which 0022 revokes from `authenticated`
  // along with the rest of the vendor PII. Service-role; admin-gated upstream.
  const supabase = createAdminClient();
  let query = supabase
    .from("restaurants")
    .select(LIST_SELECT, { count: "exact" });

  if (opts.status && opts.status !== "all") {
    query = query.eq("status", opts.status);
  }
  if (opts.category) {
    query = query.eq("category", opts.category);
  }
  if (opts.q && opts.q.trim()) {
    const needle = ilikeNeedle(opts.q);
    query = query.or(
      `name.ilike.${needle},owner_name.ilike.${needle},owner_mobile.ilike.${needle},slug.ilike.${needle}`
    );
  }

  const sort = SORT_MAP[opts.sort ?? "recent"];
  const { data, error, count } = await query
    .order(sort.column, { ascending: sort.ascending })
    .order("name", { ascending: true })
    .range(from, to);

  if (error) {
    // Pre-migration or empty: don't crash the page.
    if (isMissingSchema(error)) return { items: [], total: 0, page, pageSize };
    throw error;
  }

  const platformDefault = await getVendorCommissionDefault();
  const items = ((data as VendorRow[] | null) ?? []).map((r) =>
    mapListItem(r, platformDefault)
  );
  // Attach manual featured slots (0021); resilient if the column is absent.
  const { byId } = await getVendorPositions();
  for (const item of items) item.sortPosition = byId.get(item.id) ?? null;

  // Attach the hand-off passwords (0039) in one query for the whole page, so
  // the admin list can show the credential column without N round trips.
  const credentials = await listVendorCredentials(items.map((i) => i.id));
  for (const item of items) {
    item.loginPassword = credentials.get(item.id) ?? null;
  }

  return { items, total: count ?? 0, page, pageSize };
}

// `listAwaitingApproval` lived here: it re-queried `status = 'pending'` with
// the full list columns to feed a separate card grid above the catalogue. The
// Approvals tab is now `listVendors({ status: "pending" })` — same predicate,
// same mapper, paged and sorted like every other tab — so the second query and
// the second layout are both gone. `counts.pending` is what the badge reads.

/** The six dashboard cards. A failing sub-count reads as 0, never blank. */
export async function getVendorCounts(): Promise<VendorCounts> {
  const supabase = await createClient();

  const countOf = async (
    build: () => PromiseLike<{ count: number | null; error: unknown }>
  ): Promise<number> => {
    try {
      const { count, error } = await build();
      return error ? 0 : count ?? 0;
    } catch {
      return 0;
    }
  };

  const byStatus = (status: VendorStatus) =>
    countOf(() =>
      supabase
        .from("restaurants")
        .select("id", { count: "exact", head: true })
        .eq("status", status)
    );

  const [total, active, inactive, pending, suspended, categories, unpinned] =
    await Promise.all([
      countOf(() =>
        supabase.from("restaurants").select("id", { count: "exact", head: true })
      ),
      byStatus("active"),
      byStatus("inactive"),
      byStatus("pending"),
      byStatus("suspended"),
      countOf(() =>
        supabase
          .from("vendor_categories")
          .select("id", { count: "exact", head: true })
      ),
      // Shops with no map pin, across the whole roster rather than the page in
      // hand — this is the one gap worth a query of its own. A missing photo
      // costs a shop some orders; a missing pin stops it taking any, because
      // `createOrder` refuses what it cannot range-check. `or` rather than a
      // single `is` so a half-set pin counts too.
      countOf(() =>
        supabase
          .from("restaurants")
          .select("id", { count: "exact", head: true })
          .or("lat.is.null,lng.is.null")
      ),
    ]);

  return { total, active, inactive, pending, suspended, categories, unpinned };
}

export async function getVendorDetail(id: string): Promise<VendorDetail | null> {
  // DETAIL_SELECT reaches the payout / KYC columns (bank account, IFSC, PAN,
  // GST). Migration 0022 revokes column-level SELECT on those from `anon` and
  // `authenticated` — `restaurants` is publicly readable by row (the storefront
  // needs it) and RLS cannot filter columns, so privilege is the only lever.
  // That means the cookie-bound client can no longer read them and this must go
  // through the service role. The caller is already requireRole("admin")-gated.
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("restaurants")
    .select(DETAIL_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
  if (!data) return null;

  const { count } = await supabase
    .from("menu_items")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", id);

  const platformDefault = await getVendorCommissionDefault();
  const rules = await readPaymentRuleColumns(id);
  const detail = mapDetail(
    { ...(data as VendorRow), ...rules },
    count ?? 0,
    platformDefault
  );
  const { byId } = await getVendorPositions();
  detail.sortPosition = byId.get(id) ?? null;
  detail.loginPassword = (await getVendorCredential(id))?.password ?? null;
  return detail;
}

/**
 * The 0034 payment/payout columns for one vendor, or `{}` on a database that
 * predates them. Separated from DETAIL_SELECT so a missing migration costs the
 * five toggles rather than the whole vendor page — see PAYMENT_RULE_SELECT.
 */
async function readPaymentRuleColumns(id: string): Promise<Partial<VendorRow>> {
  if (columnKnownMissing(PAYMENT_RULE_COLUMNS)) return {};
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("restaurants")
    .select(PAYMENT_RULE_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (isMissingColumn(error) || isMissingSchema(error)) {
      rememberColumn(PAYMENT_RULE_COLUMNS, false);
      return {};
    }
    throw error;
  }
  rememberColumn(PAYMENT_RULE_COLUMNS, true);
  return (data ?? {}) as Partial<VendorRow>;
}

/** Input → DB columns. `updated_at` isn't on restaurants, so it isn't written. */
function toRow(input: VendorInput) {
  return {
    name: input.name,
    category: input.category,
    owner_name: input.ownerName,
    owner_mobile: input.ownerMobile,
    owner_alt_mobile: input.ownerAltMobile,
    owner_email: input.ownerEmail,
    tagline: input.tagline,
    description: input.description,
    commission_pct: input.commissionPct,
    min_order: input.minOrder,
    delivery_available: input.deliveryAvailable,
    self_pickup: input.selfPickup,
    opening_time: input.openingTime,
    closing_time: input.closingTime,
    weekly_off: input.weeklyOff,
    address: input.address,
    landmark: input.landmark,
    pincode: input.pincode,
    upi_id: input.upiId,
    bank_account_name: input.bankAccountName,
    bank_account_number: input.bankAccountNumber,
    bank_ifsc: input.bankIfsc,
    bank_name: input.bankName,
    fssai_number: input.fssaiNumber,
    gst_number: input.gstNumber,
    pan_number: input.panNumber,
  };
}

/** The 0034 half of the write, kept separate for the same reason the read is. */
function toPaymentRuleRow(input: VendorInput) {
  return {
    accept_cod: input.acceptCod,
    accept_online: input.acceptOnline,
    cod_max_order: Math.max(0, Math.trunc(input.codMaxOrder)),
    other_charges_per_order: Math.max(
      0,
      Math.trunc(input.otherChargesPerOrder)
    ),
    settlement_cycle: input.settlementCycle,
  };
}

export async function updateVendor(id: string, input: VendorInput): Promise<void> {
  // Writes the payout / KYC columns, which 0022 revokes from `authenticated`
  // (see getVendorDetail). Service-role; the calling action re-gates on admin.
  const supabase = createAdminClient();

  const write = (withRules: boolean) =>
    supabase
      .from("restaurants")
      .update(
        withRules ? { ...toRow(input), ...toPaymentRuleRow(input) } : toRow(input)
      )
      .eq("id", id);

  const asked = !columnKnownMissing(PAYMENT_RULE_COLUMNS);
  const { error } = await write(asked);

  if (asked && error && isMissingColumn(error)) {
    // Pre-0034. Save the rest of the form rather than losing an operator's
    // edit to a set of toggles this database cannot store anyway.
    rememberColumn(PAYMENT_RULE_COLUMNS, false);
    const { error: retry } = await write(false);
    if (retry) throw retry;
    return;
  }

  if (error) throw error;
}

/**
 * Flip lifecycle status. The 0017 trigger keeps `approved` in step.
 *
 * Going ACTIVE requires a map pin — see `lib/vendors/readiness.ts` for the
 * three things an unpinned shop breaks. Checked here on the transition only, so
 * the 49 shops already active without one can still be edited and closed;
 * migration 0050 enforces the same rule in the database, for writes that never
 * come through this function.
 *
 * Every other transition (suspend, deactivate, back to pending) is unguarded:
 * taking a shop OFF the storefront is always allowed, and refusing to suspend a
 * badly-configured vendor would be precisely backwards.
 */
export async function setVendorStatus(
  id: string,
  status: VendorStatus
): Promise<void> {
  const supabase = await createClient();

  if (status === "active") {
    const { data, error: readError } = await supabase
      .from("restaurants")
      .select("name, lat, lng")
      .eq("id", id)
      .maybeSingle();
    if (readError) throw readError;
    // No row is not "unpinned" — it is a missing vendor, and the update below
    // will report that properly rather than this throwing a confusing pin error.
    if (data) assertCanGoLive(data, data.name ?? "This shop");
  }

  const { error } = await supabase
    .from("restaurants")
    .update({ status })
    .eq("id", id);
  if (error) throw error;
}

export interface DeleteVendorResult {
  softDeleted: boolean;
}

/**
 * Delete a vendor. `orders.restaurant_id` is `on delete restrict`, so a vendor
 * that has ever taken an order can't be hard-deleted — we soft-delete it to
 * 'inactive' instead (its order history stays intact). Only an order-free vendor
 * is hard-removed: the restaurant row (menu cascades), and the owner's auth
 * account too when they own nothing else.
 */
export async function deleteVendor(id: string): Promise<DeleteVendorResult> {
  const supabase = await createClient();

  const { count: orderCount } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", id);

  if ((orderCount ?? 0) > 0) {
    await setVendorStatus(id, "inactive");
    return { softDeleted: true };
  }

  const { data: owned } = await supabase
    .from("restaurants")
    .select("owner_id")
    .eq("id", id)
    .maybeSingle();
  const ownerId = (owned as { owner_id: string } | null)?.owner_id;

  // Service-role: the restaurant row + a possible auth-account cleanup.
  const admin = createAdminClient();
  const { error: delErr } = await admin.from("restaurants").delete().eq("id", id);
  if (delErr) throw delErr;

  if (ownerId) {
    const { count: remaining } = await admin
      .from("restaurants")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", ownerId);
    if ((remaining ?? 0) === 0) {
      // Owner has no other shop — remove the orphaned vendor login too.
      await admin.auth.admin.deleteUser(ownerId);
    }
  }

  return { softDeleted: false };
}

export interface ResetPasswordResult {
  tempPassword: string;
}

/** The owner's auth user id for a shop, or null when the shop has no login. */
async function vendorOwnerId(restaurantId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("restaurants")
    .select("owner_id")
    .eq("id", restaurantId)
    .maybeSingle();
  if (error) throw error;
  return (data as { owner_id: string } | null)?.owner_id ?? null;
}

/**
 * Set a vendor's login password to `password` and keep an admin-readable copy.
 *
 * Two writes, in this order, and the order matters: Supabase Auth is the thing
 * that authenticates, so if it refuses (weak password, deleted user) nothing is
 * stored and the operator sees a failure rather than a credential that doesn't
 * work. The copy in `vendor_login_credentials` is best-effort on top — see that
 * module for why a plaintext copy exists at all and what contains it.
 *
 * `setBy` is the admin's profile id, recorded as the audit trail on the copy.
 */
async function applyVendorPassword(
  restaurantId: string,
  password: string,
  setBy: string | null
): Promise<void> {
  const ownerId = await vendorOwnerId(restaurantId);
  if (!ownerId) throw new Error("vendor_not_found");

  const admin = createAdminClient();
  const { error: upErr } = await admin.auth.admin.updateUserById(ownerId, {
    password,
    email_confirm: true,
  });
  if (upErr) throw upErr;

  await storeVendorCredential(restaurantId, ownerId, password, setBy);

  // Record THAT a reset happened as well as the value, so the audit trail
  // survives even if the credential row is later cleared.
  await admin
    .from("restaurants")
    .update({ password_reset_at: new Date().toISOString() })
    .eq("id", restaurantId);
}

/**
 * Issue a fresh legible password for a vendor and return it.
 *
 * The value is also stored, admin-visible, in `vendor_login_credentials`
 * (migration 0039). That is a deliberate reversal of audit finding C-2, which
 * dropped the old `restaurants.temp_password`: shop owners here are onboarded
 * in person and phone the admin desk when they lose their login, and rotating a
 * working credential mid-service is the wrong answer to "what was my password".
 * What made the old column unacceptable was that it sat on a row anon and
 * authenticated could read; the replacement is a service-role-only table with
 * RLS on and no policies. Read the 0039 header before touching this.
 */
export async function resetVendorPassword(
  id: string,
  setBy: string | null = null
): Promise<ResetPasswordResult> {
  const password = legiblePassword();
  await applyVendorPassword(id, password, setBy);
  return { tempPassword: password };
}

/**
 * Set a vendor's password to one the operator typed, rather than a generated
 * one. Same storage and the same audit trail; the caller validates the length.
 */
export async function setVendorPassword(
  id: string,
  password: string,
  setBy: string | null = null
): Promise<void> {
  await applyVendorPassword(id, password, setBy);
}

export interface VerifyPhoneResult {
  ok: boolean;
  error?: string;
}

/**
 * Confirm a vendor's mobile with an OTP code entered later, from the Edit
 * screen. On success the phone is stored in E.164 (so OTP login resolves this
 * owner) and `owner_phone_verified` is flipped on. The code is validated with
 * `checkOtp`, which never mints a session — the admin stays logged in.
 */
export async function verifyVendorPhone(
  id: string,
  phone: string,
  code: string
): Promise<VerifyPhoneResult> {
  const e164 = toE164(phone);
  if (!e164) return { ok: false, error: "invalid_phone" };

  const check = await checkOtp(e164, code);
  if (!check.ok) return { ok: false, error: check.error };

  const supabase = await createClient();
  const { data } = await supabase
    .from("restaurants")
    .select("owner_id")
    .eq("id", id)
    .maybeSingle();
  const ownerId = (data as { owner_id: string } | null)?.owner_id;

  // Store E.164 on the row + profile so OTP login resolves this owner. We don't
  // touch auth.users.phone (globally unique — a customer's OTP number could
  // collide); resolveUser() keys off profiles.phone.
  const admin = createAdminClient();
  await admin
    .from("restaurants")
    .update({ owner_mobile: e164, owner_phone_verified: true })
    .eq("id", id);
  if (ownerId) {
    const { error: profErr } = await admin
      .from("profiles")
      .update({ phone: e164 })
      .eq("id", ownerId);
    // profiles.phone is globally unique (0005). Without this check a collision
    // would be discarded and we'd report success while the number was never
    // stored — leaving OTP login for this owner silently broken.
    if (profErr) {
      if ((profErr as { code?: string }).code === "23505") {
        return { ok: false, error: "phone_taken" };
      }
      throw profErr;
    }
  }

  return { ok: true };
}
