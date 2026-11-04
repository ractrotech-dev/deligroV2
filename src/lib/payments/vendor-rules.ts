import "server-only";
import { createClient } from "@/lib/supabase/server";
import { onlinePaymentsEnabled } from "@/lib/payments/availability";
import { getSettings } from "@/lib/settings";
import {
  strictestCashLimit,
  type VendorPaymentRules,
} from "@/lib/payments/cod-rules";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";

/**
 * Resolve a shop's payment rules, with the platform gate already applied.
 *
 * `acceptOnline` that comes back from here is the AND of three facts — the
 * vendor's switch, the admin's platform switch, and the Razorpay keys being
 * present. Callers get one boolean and cannot accidentally honour the vendor's
 * half without the platform's: a shop that says "yes, online" on a keyless
 * environment would otherwise be offered a checkout that dead-ends, which is
 * the fail-open shape AGENTS.md §2 rules out.
 *
 * Cash works the same way (0194): `acceptCod` is the shop's switch AND the
 * platform's, and `codMaxOrder` is the stricter of the shop's limit and the
 * platform's.
 *
 * Before migration 0034 the shop columns do not exist, so the shop half reads as
 * "both methods, no ceiling" and only the platform's answer applies. A missing
 * migration must not start refusing orders.
 */

const RULE_COLUMNS = "restaurants.accept_cod";

interface RuleRow {
  accept_cod?: boolean | null;
  accept_online?: boolean | null;
  cod_max_order?: number | null;
}

interface PlatformCash {
  featureCashPayment: boolean;
  cashLimitPerOrder: number;
}

function mapRules(
  row: RuleRow | null,
  onlineOffered: boolean,
  platform: PlatformCash,
): VendorPaymentRules {
  return {
    acceptCod: platform.featureCashPayment && (row?.accept_cod ?? true),
    // The vendor switch can only ever narrow what the platform already offers.
    acceptOnline: onlineOffered && (row?.accept_online ?? true),
    codMaxOrder: strictestCashLimit(Number(row?.cod_max_order ?? 0), platform.cashLimitPerOrder),
  };
}

async function fetchRules(
  column: "id" | "slug",
  value: string
): Promise<VendorPaymentRules> {
  const [supabase, onlineOffered, platform] = await Promise.all([
    createClient(),
    onlinePaymentsEnabled(),
    getSettings(),
  ]);

  if (columnKnownMissing(RULE_COLUMNS)) {
    return mapRules(null, onlineOffered, platform);
  }

  const { data, error } = await supabase
    .from("restaurants")
    .select("accept_cod, accept_online, cod_max_order")
    .eq(column, value)
    .maybeSingle();

  if (error) {
    if (isMissingColumn(error)) {
      rememberColumn(RULE_COLUMNS, false);
      return mapRules(null, onlineOffered, platform);
    }
    throw error;
  }

  rememberColumn(RULE_COLUMNS, true);
  return mapRules(data as RuleRow | null, onlineOffered, platform);
}

export function getVendorPaymentRules(
  restaurantId: string
): Promise<VendorPaymentRules> {
  return fetchRules("id", restaurantId);
}

export function getVendorPaymentRulesBySlug(
  slug: string
): Promise<VendorPaymentRules> {
  return fetchRules("slug", slug);
}
