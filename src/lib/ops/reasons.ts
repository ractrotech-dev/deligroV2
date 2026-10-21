/**
 * Quick reasons for a manager moving an order a step forward (design §6.10:
 * every manager status change carries a reason). The web /manager board and
 * the Manager app offer the same four, plus "Other" with free text, so the
 * audit trail reads the same whichever one was used. Pure.
 */
export const ADVANCE_QUICK_REASONS = [
  "Vendor confirmed by phone",
  "Rider confirmed by phone",
  "Customer confirmed",
  "System stuck",
] as const;

/** A reason the server accepts: 3–300 characters after trimming (order-actions.ts). */
export function isValidReason(raw: string | null | undefined): boolean {
  const t = (raw ?? "").trim();
  return t.length >= 3 && t.length <= 300;
}
