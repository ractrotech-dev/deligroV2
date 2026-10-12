/**
 * Phone-number normalisation. The app is India-first (matches the legacy site),
 * so a bare 10-digit number is assumed +91. Everything is stored/compared in
 * E.164 so lookups are unambiguous.
 */

/** Returns E.164 (e.g. "+919876543210") or null if it isn't a usable number. */
export function toE164(raw: string): string | null {
  const digits = (raw || "").replace(/\D/g, "");
  if (!digits) return null;

  // Already has a country code.
  if (raw.trim().startsWith("+")) {
    return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
  }
  // 10-digit local Indian number.
  if (digits.length === 10) return `+91${digits}`;
  // 91XXXXXXXXXX
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  // 0-prefixed local
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;

  return null;
}

/**
 * An Indian mobile number in E.164: +91 then a 10-digit number starting 6-9.
 *
 * Gate for anything that SENDS an SMS. toE164() accepts any +country number of
 * 10-15 digits, which is right for storing and matching but wrong for paying a
 * gateway to text it: launch is one Indian city, and an open international
 * range is how a login form becomes a toll-fraud pump.
 */
export function isIndianMobile(e164: string): boolean {
  return /^\+91[6-9]\d{9}$/.test(e164);
}

/** The bare national number Renflair expects (10 digits for India). */
export function toLocal10(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Synthetic email for phone-only users, so they live in Supabase auth. */
export function phoneToSyntheticEmail(e164: string): string {
  return `p${e164.replace(/\D/g, "")}@phone.deligro.app`;
}
