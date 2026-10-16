/**
 * The app's own people. A phone here is treated as a developer/owner account and
 * gets the "Developer" badge + golden ring on the profile — the cosmetic half of
 * "the boss". The real access half (role = admin) lives in the DB and is applied
 * by scripts/seed-developer.ts; this list only drives the visual marker.
 *
 * Numbers are E.164. Kept in code (not the DB) on purpose — it's a tiny, static
 * allowlist that should be reviewable in the repo, not editable at runtime.
 */
const DEVELOPER_PHONES = [
  "+917987265706", // Gaurav — app owner / lead developer
];

/**
 * Is this the phone of one of ours? Compares on digits (and, as a fallback, the
 * last 10) so a stored "+91 79872 65706" or "7987265706" still matches.
 */
export function isDeveloperPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const d = phone.replace(/\D/g, "");
  if (!d) return false;
  return DEVELOPER_PHONES.some((p) => {
    const pd = p.replace(/\D/g, "");
    return d === pd || d.slice(-10) === pd.slice(-10);
  });
}
