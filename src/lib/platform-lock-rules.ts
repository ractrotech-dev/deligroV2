/**
 * The developer's platform lock (0177), as plain rules: pure, so scripts/qa can
 * check them.
 *
 *   off    — normal.
 *   orders — no new orders anywhere; everything else works.
 *   full   — no new orders, and the Admin console and Manager app show the
 *            paused screen. Shops and riders can finish orders already placed.
 */
export type PlatformLockLevel = "off" | "orders" | "full";

export interface PlatformLock {
  level: PlatformLockLevel;
  message: string;
  since?: string | null;
}

export const LOCK_LEVELS: readonly PlatformLockLevel[] = ["off", "orders", "full"];

export function isLockLevel(v: unknown): v is PlatformLockLevel {
  return typeof v === "string" && (LOCK_LEVELS as readonly string[]).includes(v);
}

/** Does the lock close this role's console? The developer is never locked out. */
export function lockBlocksConsole(lock: PlatformLock, role: string): boolean {
  return lock.level === "full" && (role === "admin" || role === "manager");
}

/** What the paused screen says. */
export function pausedText(lock: PlatformLock): string {
  return lock.message.trim() || "Deligro is paused by the platform developer. Please contact them to resume service.";
}
