/**
 * The reason an admin or manager gives for changing a shop's status (design:
 * "a reason is mandatory on every status change"). It is recorded on the shop
 * and in the audit log by ops_admin_set_vendor_status / ops_set_vendor_status
 * (0145). Trimmed, 3–300 characters; null when it is not a reason.
 */
export function statusReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length >= 3 && t.length <= 300 ? t : null;
}
