import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Promo codes, for the people who create them.
 *
 * The customer-facing half of this feature never comes through here — a
 * shopper reaches a coupon only by naming it, through `preview_coupon()` (see
 * `coupons.ts`), because 0041 revoked SELECT on the table. This module is the
 * management side, and it reads and writes under the caller's own session on
 * purpose: the "coupons — admin all" and "coupons — vendor …" policies decide
 * what an operator or a shop owner can see and change, so a vendor asking for
 * every promotion on the platform receives their own and nothing else.
 *
 * There is deliberately no `createAdminClient()` anywhere in this file. The
 * policies are the authorization, and routing around them would mean
 * re-implementing ownership in TypeScript — the failure AGENTS.md §5 is about.
 */

type PromotionKind = "percent" | "flat";
type PromotionFunding = "platform" | "vendor";

export interface Promotion {
  code: string;
  label: string | null;
  kind: PromotionKind;
  /** Percent (1–100) or rupees, per `kind`. */
  value: number;
  minOrder: number;
  /** Ceiling in rupees on a percentage code. Null = uncapped. */
  maxDiscount: number | null;
  active: boolean;
  expiresAt: string | null;
  /** Null = unlimited. Defaults to 1 at the column (0031). */
  maxPerCustomer: number | null;
  maxRedemptions: number | null;
  /** Null = works at every shop. */
  restaurantId: string | null;
  restaurantName: string | null;
  fundedBy: PromotionFunding;
  createdAt: string;
  /** Times redeemed, from the 0031 ledger. */
  redemptions: number;
  /** Rupees given away across those redemptions. */
  discountGiven: number;
}

export interface PromotionInput {
  code: string;
  label: string | null;
  kind: PromotionKind;
  value: number;
  minOrder: number;
  maxDiscount: number | null;
  active: boolean;
  expiresAt: string | null;
  maxPerCustomer: number | null;
  maxRedemptions: number | null;
  restaurantId: string | null;
  fundedBy: PromotionFunding;
}

const SELECT = `
  code, label, kind, value, min_order, max_discount, active, expires_at,
  max_per_customer, max_redemptions, restaurant_id, funded_by, created_at,
  restaurants ( name )
`;

interface PromotionRow {
  code: string;
  label: string | null;
  kind: string;
  value: number | string;
  min_order: number | string;
  max_discount: number | string | null;
  active: boolean;
  expires_at: string | null;
  max_per_customer: number | null;
  max_redemptions: number | null;
  restaurant_id: string | null;
  funded_by: string;
  created_at: string;
  restaurants: { name: string } | { name: string }[] | null;
}

/**
 * Thrown when 0041 hasn't been applied — the columns this module reads don't
 * exist yet. The pages treat it the way the campaigns screen treats a missing
 * `banners` table: show the notice, not a stack trace.
 */
export class PromotionsNotMigratedError extends Error {
  constructor() {
    super("promotions_not_migrated");
    this.name = "PromotionsNotMigratedError";
  }
}

function isMissingSchema(
  error: { code?: string; message?: string } | null
): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const msg = (error.message ?? "").toLowerCase();
  // 42703 = undefined_column, 42P01 = undefined_table, PGRST204/205 = the
  // schema cache hasn't heard of the column/relation.
  return (
    code === "42703" ||
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    msg.includes("schema cache") ||
    msg.includes("does not exist")
  );
}

function restaurantName(row: PromotionRow): string | null {
  const r = row.restaurants;
  if (!r) return null;
  return Array.isArray(r) ? (r[0]?.name ?? null) : r.name;
}

function mapPromotion(
  row: PromotionRow,
  stats: Map<string, { count: number; total: number }>
): Promotion {
  const s = stats.get(row.code);
  return {
    code: row.code,
    label: row.label,
    kind: (row.kind as PromotionKind) ?? "percent",
    value: Number(row.value),
    minOrder: Number(row.min_order),
    maxDiscount: row.max_discount == null ? null : Number(row.max_discount),
    active: row.active,
    expiresAt: row.expires_at,
    maxPerCustomer: row.max_per_customer,
    maxRedemptions: row.max_redemptions,
    restaurantId: row.restaurant_id,
    restaurantName: restaurantName(row),
    fundedBy: (row.funded_by as PromotionFunding) ?? "platform",
    createdAt: row.created_at,
    redemptions: s?.count ?? 0,
    discountGiven: s?.total ?? 0,
  };
}

/**
 * Redemption counts for the codes we are about to list.
 *
 * Counted in TypeScript rather than by a grouped query because PostgREST
 * cannot group, and the alternative — an RPC per screen — would be a third
 * function to keep in step with the ledger. Scoped to the codes on the page,
 * so this stays proportional to what is being shown and not to how many orders
 * the platform has taken.
 *
 * RLS decides what comes back: an admin sees every redemption, a vendor sees
 * the ones against their own codes (0041), and a shopper would see only their
 * own — which is why this is never used to enforce a limit. `price_coupon()`
 * does that, inside the database, where the count is complete.
 */
async function redemptionStats(
  codes: string[]
): Promise<Map<string, { count: number; total: number }>> {
  const out = new Map<string, { count: number; total: number }>();
  if (codes.length === 0) return out;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("coupon_redemptions")
    .select("code, discount")
    .in("code", codes);

  if (error || !data) return out;

  for (const row of data as { code: string; discount: number }[]) {
    const prev = out.get(row.code) ?? { count: 0, total: 0 };
    out.set(row.code, {
      count: prev.count + 1,
      total: prev.total + Number(row.discount ?? 0),
    });
  }
  return out;
}

async function list(restaurantId?: string): Promise<Promotion[]> {
  const supabase = await createClient();
  let query = supabase.from("coupons").select(SELECT);
  // Belt and braces over the vendor read policy: the policy is what makes this
  // safe, the filter is what makes a multi-shop owner's page show one shop.
  if (restaurantId) query = query.eq("restaurant_id", restaurantId);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) {
    if (isMissingSchema(error)) throw new PromotionsNotMigratedError();
    throw error;
  }

  const rows = (data ?? []) as unknown as PromotionRow[];
  const stats = await redemptionStats(rows.map((r) => r.code));
  return rows.map((r) => mapPromotion(r, stats));
}

/** Every promo code on the platform. Admin policy scopes it. */
export async function listPromotions(): Promise<Promotion[]> {
  return list();
}

/** One shop's own codes. */
export async function listVendorPromotions(
  restaurantId: string
): Promise<Promotion[]> {
  return list(restaurantId);
}

export async function getPromotion(code: string): Promise<Promotion | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("coupons")
    .select(SELECT)
    .eq("code", code.trim().toUpperCase())
    .maybeSingle();

  if (error) {
    if (isMissingSchema(error)) throw new PromotionsNotMigratedError();
    throw error;
  }
  if (!data) return null;

  const row = data as unknown as PromotionRow;
  return mapPromotion(row, await redemptionStats([row.code]));
}

/** Is 0041 applied? Used to show the preview notice rather than an error. */
export async function promotionsBackendReady(): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("coupons")
    .select("code, restaurant_id, funded_by")
    .limit(1);
  return !isMissingSchema(error);
}

function toRow(input: PromotionInput) {
  return {
    code: input.code,
    label: input.label,
    kind: input.kind,
    value: input.value,
    min_order: input.minOrder,
    max_discount: input.maxDiscount,
    active: input.active,
    expires_at: input.expiresAt,
    max_per_customer: input.maxPerCustomer,
    max_redemptions: input.maxRedemptions,
    restaurant_id: input.restaurantId,
    funded_by: input.fundedBy,
  };
}

/**
 * `created_by` is stamped from the session rather than the form. It is an
 * audit field: a value the person being audited can choose is not one.
 */
export async function createPromotion(input: PromotionInput): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("coupons")
    .insert({ ...toRow(input), created_by: user?.id ?? null });
  if (error) throw error;
}

/**
 * `code` is the primary key and is never updated — a live code is printed on
 * things and quoted to customers, and renaming it in place would silently
 * break every place it has already been shared. Retire it and make a new one.
 *
 * `restaurant_id` and `funded_by` are likewise fixed after creation: both are
 * snapshotted onto orders at redemption, and moving a campaign between shops
 * or between payers halfway through would make the ledger unreadable.
 */
export async function updatePromotion(
  code: string,
  input: PromotionInput
): Promise<void> {
  const supabase = await createClient();
  const row = toRow(input);
  const { error } = await supabase
    .from("coupons")
    .update({
      label: row.label,
      kind: row.kind,
      value: row.value,
      min_order: row.min_order,
      max_discount: row.max_discount,
      active: row.active,
      expires_at: row.expires_at,
      max_per_customer: row.max_per_customer,
      max_redemptions: row.max_redemptions,
    })
    .eq("code", code.trim().toUpperCase());
  if (error) throw error;
}

export async function setPromotionActive(
  code: string,
  active: boolean
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("coupons")
    .update({ active })
    .eq("code", code.trim().toUpperCase());
  if (error) throw error;
}

/**
 * Deleting a code does not rewrite history: `orders.coupon_code` is plain text
 * with no foreign key (0031) and `coupon_redemptions` keeps its rows, so what
 * past customers were charged stays exactly as it was.
 */
export async function deletePromotion(code: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("coupons")
    .delete()
    .eq("code", code.trim().toUpperCase());
  if (error) throw error;
}

export interface PromotableRestaurant {
  id: string;
  name: string;
}

/**
 * Shops an admin can scope a code to.
 *
 * Session-scoped rather than service-role: `id` and `name` are on 0024's
 * granted column list, so this needs no PII and no RLS bypass. `listVendors()`
 * exists and is richer, but it reads `owner_mobile` and therefore has to go
 * through `createAdminClient()` — the wrong tool for filling a dropdown.
 */
export async function listPromotableRestaurants(): Promise<
  PromotableRestaurant[]
> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("restaurants")
    .select("id, name")
    .order("name");

  if (error) return [];
  return (data ?? []) as PromotableRestaurant[];
}
