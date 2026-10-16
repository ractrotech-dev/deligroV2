import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingColumn } from "@/lib/data-access/schema-probe";

/**
 * The platform-wide vendor commission — the rate every vendor pays unless it has
 * a negotiated override in `restaurants.commission_pct`.
 *
 * Deliberately NOT part of `PlatformSettings`. That type is client-safe by
 * design (`settings-defaults.ts` says so, and the cart imports it), and what the
 * platform charges its merchants is a commercial term, not storefront config.
 * Migration 0032 revokes the column from anon/authenticated for the same
 * reason, which is also why every function here uses `createAdminClient()`:
 * the cookie-bound client genuinely cannot see the column.
 *
 * Caller MUST already be admin-gated — the service-role client bypasses RLS,
 * so these are only as safe as the `requireRole("admin")` above them.
 */

/** Matches the platform_settings check constraint added in 0032. */
const MIN_COMMISSION_PCT = 0;
const MAX_COMMISSION_PCT = 100;

/**
 * Falls back to 0 rather than throwing, so an un-migrated database bills no
 * commission instead of failing a settlement run. Reducing what we charge is
 * the safe direction for a config we cannot read.
 */
const COMMISSION_FALLBACK_PCT = 0;

/**
 * A missing column looks different on a read than on a write. A SELECT fails
 * with Postgres' own 42703, which `isMissingColumn` covers; an UPDATE never
 * reaches Postgres, because PostgREST rejects it against its cached schema
 * first and returns PGRST204. Only checking 42703 meant a save against an
 * un-migrated database reported "couldn't save the vendor commission" instead
 * of naming the migration that was missing.
 */
function isMissingCommissionColumn(
  error: { code?: string; message?: string } | null
): boolean {
  if (!error) return false;
  if (isMissingColumn(error)) return true;
  if (error.code === "PGRST204") return true;
  const msg = (error.message ?? "").toLowerCase();
  return (
    (msg.includes("vendor_commission_pct") ||
      msg.includes("commission_gst_pct")) &&
    (msg.includes("schema cache") || msg.includes("does not exist"))
  );
}

export function clampCommissionPct(pct: number): number {
  if (!Number.isFinite(pct)) return COMMISSION_FALLBACK_PCT;
  return Math.min(MAX_COMMISSION_PCT, Math.max(MIN_COMMISSION_PCT, pct));
}

/**
 * The effective rate for one vendor. `override` is
 * `restaurants.commission_pct`: null means "inherit", and an explicit 0 means
 * "this vendor is free" — which is why this is a null check and not `||`.
 */
export function effectiveCommissionPct(
  override: number | null | undefined,
  platformDefault: number
): number {
  return clampCommissionPct(
    override ?? platformDefault
  );
}

/** Is migration 0032 applied? Drives the "run migration" notice on Settings. */
async function commissionBackendReady(): Promise<boolean> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("platform_settings")
    .select("vendor_commission_pct", { head: true, count: "exact" })
    .limit(1);
  return !error;
}

export async function getVendorCommissionDefault(): Promise<number> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("platform_settings")
    .select("vendor_commission_pct")
    .eq("id", true)
    .maybeSingle();

  // Pre-0032 database: no column, so nothing is configured yet. ONLY that case
  // may fall back to 0. Any other failure (a timeout, a dropped connection) is
  // "we could not read the rate", not "the rate is zero" — returning 0 for it
  // froze settlement drafts and reports with no commission at all. Throw, so the
  // screen or the draft fails visibly and can be retried.
  if (error) {
    if (isMissingCommissionColumn(error)) return COMMISSION_FALLBACK_PCT;
    throw error;
  }
  if (!data) return COMMISSION_FALLBACK_PCT;
  return clampCommissionPct(Number(data.vendor_commission_pct));
}

/**
 * GST charged on the platform commission (18% in India), whole percent.
 *
 * Same visibility rules as the commission itself — 0035 keeps it off the
 * anon/authenticated grant list — and the same fallback direction: a database
 * that cannot tell us the rate charges none, rather than guessing 18 and
 * deducting a tax nobody configured from a vendor's payout.
 */
export async function getCommissionGstPct(): Promise<number> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("platform_settings")
    .select("commission_gst_pct")
    .eq("id", true)
    .maybeSingle();

  // Same rule as the commission rate above: only an un-migrated database may
  // read as "no GST"; a transient failure must not silently drop the tax.
  if (error) {
    if (isMissingCommissionColumn(error)) return 0;
    throw error;
  }
  if (!data) return 0;
  return clampCommissionPct(Number(data.commission_gst_pct));
}

/** Loud on failure, for the same reason setVendorCommissionDefault is. */
export async function setCommissionGstPct(pct: number): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("platform_settings")
    .update({
      commission_gst_pct: clampCommissionPct(pct),
      updated_at: new Date().toISOString(),
    })
    .eq("id", true);

  if (error) {
    if (isMissingCommissionColumn(error)) throw new CommissionNotMigratedError();
    throw error;
  }
}

export class CommissionNotMigratedError extends Error {
  constructor() {
    super("commission_not_migrated");
    this.name = "CommissionNotMigratedError";
  }
}

/**
 * Unlike the read, a failed write is loud: silently dropping a commission
 * change would leave the admin believing every vendor moved to a new rate when
 * none of them had.
 */
export async function setVendorCommissionDefault(pct: number): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("platform_settings")
    .update({
      vendor_commission_pct: clampCommissionPct(pct),
      updated_at: new Date().toISOString(),
    })
    .eq("id", true);

  if (error) {
    if (isMissingCommissionColumn(error)) throw new CommissionNotMigratedError();
    throw error;
  }
}

/**
 * How many vendors actually track the platform rate, and how many hold an
 * override — the two numbers that tell an admin what "18%" is about to mean
 * before they save it.
 */
export async function getCommissionCoverage(): Promise<{
  inheriting: number;
  overridden: number;
  /**
   * False before 0032, where `commission_pct` is still NOT NULL and every row
   * therefore counts as an override. The numbers are arithmetically true but
   * tell the admin the opposite of what they mean, so the UI shows the
   * migration notice instead of the counts.
   */
  migrated: boolean;
}> {
  const migrated = await commissionBackendReady();
  if (!migrated) return { inheriting: 0, overridden: 0, migrated: false };

  const supabase = createAdminClient();
  const [inherit, override] = await Promise.all([
    supabase
      .from("restaurants")
      .select("id", { head: true, count: "exact" })
      .is("commission_pct", null),
    supabase
      .from("restaurants")
      .select("id", { head: true, count: "exact" })
      .not("commission_pct", "is", null),
  ]);

  return {
    inheriting: inherit.count ?? 0,
    overridden: override.count ?? 0,
    migrated: true,
  };
}
