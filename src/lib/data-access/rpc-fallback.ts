/**
 * Prefer a database function; fall back to reading the table while the function
 * does not exist yet.
 *
 * Why: the app and its migrations ship separately. 0058 moves the handover codes
 * behind functions, and the app that calls them must keep working on a database
 * that has not had 0058 applied (and the other way round), or the order of
 * deploys becomes a way to blank the kitchen board.
 *
 * Only a "function does not exist" answer triggers the fallback. Any other error
 * (permission denied, a timeout) is returned as it is: falling back would hide
 * the real problem and, after 0058, would just fail again on the revoked column.
 *
 * Pure so scripts/qa/rpc-fallback.ts can check it.
 */

export interface Reply<T> {
  data: T | null;
  error: { code?: string } | null;
}

/** PostgREST says PGRST202 for an unknown function; Postgres itself says 42883. */
export function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/** Remembers, per function, that it is absent so a bare database is asked once. */
export interface FallbackState {
  missing: boolean;
}

export async function preferRpc<T>(
  state: FallbackState,
  viaRpc: () => PromiseLike<Reply<T>>,
  viaTable: () => PromiseLike<Reply<T>>
): Promise<Reply<T>> {
  if (state.missing) return viaTable();
  const reply = await viaRpc();
  if (!reply.error) return reply;
  if (isMissingFunction(reply.error)) {
    state.missing = true;
    return viaTable();
  }
  return reply;
}
