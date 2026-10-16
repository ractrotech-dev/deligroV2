/**
 * Resolve a Supabase login email for a legacy shop row.
 * Uses shop.email when valid; otherwise phone-based synthetic email.
 */
import { phoneToSyntheticEmail, toE164 } from "../../src/lib/auth/phone";
import type { LegacyShop } from "./legacy-db";

/** local@domain, the domain holding a dot that is neither its first nor last
 * character. Pinned to the domain's first dot after its first character so the
 * regex never has to backtrack over where the dot is. */
const EMAIL_RE =/^[^\s@]+@[^\s@][^\s@.]*\.[^\s@]+$/i;

export function legacyShopLoginEmail(shop: LegacyShop): string | null {
  const email = shop.email?.trim();
  if (email && EMAIL_RE.test(email)) return email.toLowerCase();

  const phone = toE164(shop.phone ?? "");
  if (phone) return phoneToSyntheticEmail(phone);

  return null;
}

export function legacyShopPhone(shop: LegacyShop): string | null {
  return toE164(shop.phone ?? "");
}
