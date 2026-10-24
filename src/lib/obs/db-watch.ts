/**
 * Quiet database refusals (OBSERVABILITY_V2.md, phase 2).
 *
 * Most database errors are not thrown: supabase-js hands the caller
 * `{ error }`, the screen says "Could not save", and nothing is recorded unless
 * that caller remembered to. This `fetch` is given to the server's Supabase
 * clients and looks at every PostgREST answer on the way past: a status of 300
 * (PostgREST's "ambiguous embed or function", a real error) or anything from
 * 400 up is recorded as a `db` event.
 *
 * It never changes the request or the answer and never makes the caller wait:
 * the answer is cloned and read later, and every step swallows its own errors.
 * It never records itself: anything named `obs_*` (the telemetry tables and
 * `rpc/obs_ingest`) is skipped, or one failing telemetry write would report
 * itself forever.
 */

/** "No rows" from `.single()`: an answer, not a failure. */
const NO_ROWS = new Set(["PGRST116"]);

/**
 * "This database has not had that migration yet". The app is built to fall
 * back when a column, table or function is missing (it probes for them), so
 * these are kept as info lines in Logs, not raised as issues.
 */
const SCHEMA_PROBES = new Set(["42703", "42P01", "42883", "PGRST200", "PGRST202", "PGRST204", "PGRST205"]);

/** One detailed row per kind of refusal per 10 seconds per server instance; the issue still counts each. */
const lastSent = new Map<string, number>();
const BURST_MS = 10_000;

const VERB: Record<string, string> = { GET: "read", HEAD: "count", POST: "insert into", PATCH: "update", PUT: "upsert into", DELETE: "delete from" };

export interface DbTarget {
  /** Table or function name. */
  name: string;
  isRpc: boolean;
}

/** `https://x.supabase.co/rest/v1/orders?…` → `{ name: "orders" }`; null for anything that is not PostgREST. */
export function dbTarget(url: string): DbTarget | null {
  const at = url.indexOf("/rest/v1/");
  if (at === -1) return null;
  const rest = url.slice(at + 9).split("?")[0] ?? "";
  if (rest.startsWith("rpc/")) return { name: rest.slice(4), isRpc: true };
  return rest ? { name: rest.split("/")[0], isRpc: false } : null;
}

/** Whether an answer is a refusal worth looking at: 300, or 400 and up. */
export function isRefusal(status: number): boolean {
  return status === 300 || status >= 400;
}

export function describeRefusal(method: string, target: DbTarget, status: number, code: string | null, message: string | null): string {
  const doing = target.isRpc ? `run ${target.name}` : `${VERB[method] ?? method.toLowerCase()} ${target.name}`;
  const detail = [code, message].filter(Boolean).join(" ");
  return `Database refused to ${doing}${detail ? `: ${detail}` : ` (status ${status})`}`;
}

async function inspect(method: string, target: DbTarget, response: Response): Promise<void> {
  let code: string | null = null;
  let message: string | null = null;
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    code = typeof body.code === "string" ? body.code : null;
    message = typeof body.message === "string" ? body.message : null;
  } catch {
    // Not JSON: the status is still worth recording.
  }
  if (code && NO_ROWS.has(code)) return;

  const key = `${method} ${target.name} ${code ?? response.status}`;
  const now = Date.now();
  if ((lastSent.get(key) ?? 0) > now - BURST_MS) return;
  lastSent.set(key, now);
  if (lastSent.size > 500) lastSent.clear();

  const probe = code !== null && SCHEMA_PROBES.has(code);
  const auth = response.status === 401 || response.status === 403;
  const { emit } = await import("./emit");
  const { currentEnv } = await import("./ids");
  emit({
    env: currentEnv(),
    kind: "db",
    level: probe ? "info" : auth ? "warn" : "error",
    source: "supabase",
    message: describeRefusal(method, target, response.status, code, message),
    errorType: code ? `pg_${code}` : `http_${response.status}`,
    // Grouped per table and verb: stable across deploys, and the place to look.
    culprit: `db:${target.isRpc ? "rpc " : ""}${target.name}`,
    httpStatus: response.status,
    attrs: { table: target.name, verb: method, code: code ?? undefined },
  });
}

/**
 * The `fetch` handed to the server Supabase clients. Behaves exactly like
 * `fetch`; a refusal is looked at after the answer has gone back to the caller.
 */
export function watchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init).then((response) => {
    try {
      if (isRefusal(response.status)) {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const target = dbTarget(url);
        if (target && !target.name.startsWith("obs_")) {
          const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
          void inspect(method, target, response.clone()).catch(() => {});
        }
      }
    } catch {
      // Watching must never cost the caller its answer.
    }
    return response;
  });
}
