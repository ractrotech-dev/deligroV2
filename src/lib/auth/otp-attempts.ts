/**
 * Spending an OTP attempt, atomically.
 *
 * The old flow read `attempts`, compared the code, and on a wrong guess wrote
 * `attempts + 1`. Parallel guesses all read the same value, all passed the
 * `< MAX` check, and all wrote the same increment — so N concurrent wrong
 * guesses cost one attempt, and the five-try lock was a suggestion.
 *
 * Here the attempt is claimed BEFORE the code is compared, by a conditional
 * write that only one caller can win per count (`attempts = expected`). A caller
 * that loses re-reads and tries again, so N parallel guesses spend N attempts
 * and the sixth never reaches the comparison.
 *
 * The store is injected so this stays pure and testable
 * (scripts/qa/otp-attempts.ts); lib/data-access/otp.ts supplies the Supabase
 * one.
 */

export interface AttemptStore {
  /** Set attempts to `expected + 1` only if it is still `expected`. True when this call won. */
  bump(id: string, expected: number): Promise<boolean>;
  /** Current attempts, or null when the code row no longer exists. */
  read(id: string): Promise<number | null>;
}

/**
 * Try to spend one attempt on code `id`, which the caller last saw at `seen`.
 * Resolves true when an attempt was spent (go on and compare the code), false
 * when none are left or the code is gone.
 */
export async function claimAttempt(
  store: AttemptStore,
  id: string,
  seen: number,
  max: number
): Promise<boolean> {
  let attempts = seen;
  // Every pass either wins or observes someone else's win, so `max + 1` passes
  // is enough for the count to reach `max` and this to return false.
  for (let pass = 0; pass <= max; pass++) {
    if (attempts >= max) return false;
    if (await store.bump(id, attempts)) return true;
    const fresh = await store.read(id);
    if (fresh === null) return false;
    attempts = fresh;
  }
  return false;
}
