/**
 * What a rider can be told about, and which of it they may switch off (§11).
 *
 * Pure and import-free: `notifyUser` asks `pushAllowed` before every rider
 * push, the rider app's Settings lists the same categories, and the QA script
 * runs the table directly.
 *
 * Preferences live in `rider_profiles.notification_prefs` (Phase 6), a JSON
 * object of `{ <category>: false }` for each category the rider switched off.
 * Only an explicit `false` mutes: a missing key, a missing column (Phase 6 not
 * applied) or a malformed value all mean "on" — the failure direction that
 * cannot hide an alert. Muting suppresses the PUSH only; the inbox row is
 * always written, so the record is never lost.
 */

export const NOTIFICATION_CATEGORIES = [
  "offers",
  "cancellations",
  "safety",
  "pickup_reminders",
  "delivery_updates",
  "payouts",
  "incentives",
  "announcements",
  "support",
  "cash",
  "documents",
  "high_demand",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Never muted: a missed offer is a missed job, a missed cancellation sends a
 * rider to a shop for nothing, and safety is safety.
 */
export const LOCKED_CATEGORIES = ["offers", "cancellations", "safety"] as const;

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === "string" && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

export function isLockedCategory(category: string): boolean {
  return (LOCKED_CATEGORIES as readonly string[]).includes(category);
}

function asObject(prefs: unknown): Record<string, unknown> | null {
  return prefs && typeof prefs === "object" && !Array.isArray(prefs) ? (prefs as Record<string, unknown>) : null;
}

/** Whether a push in `category` may be sent, given the rider's stored preferences. */
export function pushAllowed(prefs: Record<string, unknown> | null | undefined, category: string): boolean {
  if (isLockedCategory(category)) return true;
  const p = asObject(prefs);
  return !(p && p[category] === false);
}

/** Every category with its effective switch — what the Settings screen shows. */
export function effectivePrefs(prefs: unknown): Record<NotificationCategory, boolean> {
  const p = asObject(prefs);
  return Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((c) => [c, pushAllowed(p, c)])
  ) as Record<NotificationCategory, boolean>;
}

/**
 * The stored object after applying a rider's changes: `false` switches a
 * category off, `true` removes its key (on is the default, so only the off
 * switches are stored). Categories not mentioned keep their value, so two
 * requests for different categories never undo each other.
 *
 * Stored `false` entries for categories this build does not know are KEPT
 * (ruling P7-R6): after a rollback or during a rolling deploy an older server
 * must not silently unmute a newer category the rider switched off. Dropped:
 * anything that is not `false` (on is the default), a locked category (it is
 * never muted, so a stored `false` means nothing) and `__proto__`.
 */
export function mergeNotificationPrefs(
  stored: unknown,
  changes: Partial<Record<string, boolean>>
): Record<string, false> {
  const next: Record<string, false> = {};
  const p = asObject(stored);
  if (p) {
    for (const [key, value] of Object.entries(p)) {
      if (value !== false || key === "__proto__") continue;
      if (isNotificationCategory(key) && (isLockedCategory(key) || key in changes)) continue;
      next[key] = false;
    }
  }
  for (const [key, on] of Object.entries(changes)) {
    if (!isNotificationCategory(key) || isLockedCategory(key)) continue;
    if (on === false) next[key] = false;
  }
  return next;
}
