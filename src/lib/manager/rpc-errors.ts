/**
 * Telling "this database function is not there" apart from "the call failed".
 *
 * The two need different answers. A function that does not exist yet (its
 * migration not applied) or cannot reach what it needs on this host (the owner
 * without rights on `auth.sessions`) is a capability the screen should say is
 * unavailable. A call that exists and failed is an error — reporting it as
 * "unavailable" hides a real fault behind a shrug (Phase 2 review, finding 14).
 */
export interface RpcError {
  code?: string;
  message?: string;
}

const MISSING_CODES = new Set([
  "PGRST202", // PostgREST: no function with this name/signature in the schema cache
  "42883", // Postgres: undefined function
  "42501", // Postgres: insufficient privilege (the owner cannot touch auth.sessions)
]);

export function isRpcMissing(error: RpcError | null | undefined): boolean {
  return !!error && MISSING_CODES.has(error.code ?? "");
}

/**
 * May a feature switch be written without its audit entry? Only on a database
 * that has no audit log to write to (before 0141). A "missing" RPC on a
 * database whose audit log exists is PostgREST's schema cache being stale —
 * writing unaudited then would be exactly the silent gap the RPC exists to
 * close, so it is refused, as is a probe that itself failed.
 */
export function unauditedFallbackAllowed(
  rpcError: RpcError | null | undefined,
  auditProbeError: RpcError | null | undefined
): boolean {
  // PGRST205 / 42P01: no such table — the same test as schema-probe's
  // isMissingTable, repeated here so this module stays importable offline.
  const auditLogMissing = auditProbeError?.code === "PGRST205" || auditProbeError?.code === "42P01";
  return isRpcMissing(rpcError) && rpcError?.code !== "42501" && auditLogMissing;
}
