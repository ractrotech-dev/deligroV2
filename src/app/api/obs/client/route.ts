import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { emit } from "@/lib/obs/emit";
import { currentEnv, parseCorrelationId, templateRoute } from "@/lib/obs/ids";
import { redactUrl } from "@/lib/obs/redact";
import {
  OBS_REQUEST_ID_HEADER,
  OBS_TRACE_ID_HEADER,
} from "@/lib/obs/types";

/**
 * POST /api/obs/client — a browser reporting its own error.
 *
 * The one endpoint in this feature that anyone on the internet can call, which
 * makes it the one that needs the most suspicion. It is treated as hostile
 * input throughout:
 *
 *   * **Rate limited by IP** (AGENTS.md rule 6). There is often no session here
 *     — a crash on the login screen is exactly the crash worth hearing about —
 *     so `clientIp` is the key, and the cap is low. A browser that is genuinely
 *     broken emits a handful of errors, not hundreds; anything above the cap is
 *     a loop or an attack, and neither deserves a row.
 *   * **Nothing is trusted.** Every field is re-derived or clamped here. The
 *     caller cannot choose its own `level`, `kind`, `severity`, `env`, actor or
 *     order id — if it could, a script could write `critical` production issues
 *     into an operator's triage queue, or attribute its noise to somebody
 *     else's account.
 *   * **The actor comes from the session, never from the body.** If there is no
 *     session the row is anonymous, which is the honest answer.
 *   * **Redaction still applies.** `emit()` runs it regardless of where the
 *     event came from, so a page that puts a token in an error message cannot
 *     launder it through here.
 *
 * Answers 204 in every non-rate-limited case, including for a body it decided
 * to discard: telling a caller which of its payloads were rejected is a probing
 * oracle, and a browser can do nothing useful with the answer anyway.
 */

/** Shapes a page is allowed to report. Anything else is not from our code. */
const ALLOWED_KINDS = new Set(["error", "unhandledrejection", "boundary", "fetch", "notfound"]);

interface ClientReport {
  kind?: unknown;
  message?: unknown;
  stack?: unknown;
  /** `location.pathname` — query string is stripped before storage. */
  path?: unknown;
  digest?: unknown;
  componentStack?: unknown;
  appVersion?: unknown;
  /** The steps before the error ("13:59:02 clicked \"Save\""). Redacted like any text. */
  steps?: unknown;
}

/** The last 20 steps, each a short string; anything else is dropped. */
function cleanSteps(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, 160));
  return out.length ? out.slice(-20) : undefined;
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured) {
    // Nothing to write to. 204 rather than 503: this is a beacon, and a failing
    // beacon must not make a broken page look more broken.
    return new NextResponse(null, { status: 204 });
  }

  // 30 reports per 5 minutes per address. Generous enough for a page that is
  // genuinely falling over, tight enough that a loop cannot fill a partition.
  const limit = await rateLimit(`obs-client:${clientIp(request)}`, 30, 300_000);
  if (!limit.ok) return tooManyRequests(limit);

  let body: ClientReport;
  try {
    body = (await request.json()) as ClientReport;
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return new NextResponse(null, { status: 204 });

  const kind = typeof body.kind === "string" ? body.kind : "error";
  if (!ALLOWED_KINDS.has(kind)) return new NextResponse(null, { status: 204 });

  // The reporting user, from the session — never from the body. A crash on a
  // signed-out screen is anonymous, and that is the truth rather than a gap.
  let actorId: string | null = null;
  let actorRole: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      actorId = user.id;
      const { data } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      actorRole = (data as { role?: string } | null)?.role ?? null;
    }
  } catch {
    // An unreadable session is not a reason to drop the error report.
  }

  // A 404 is kept only for signed-in people: signed-out 404s are mostly robots.
  if (kind === "notfound" && !actorId) return new NextResponse(null, { status: 204 });

  const path = typeof body.path === "string" ? redactUrl(body.path) : null;

  emit({
    // Server-decided, all of it. See the header note.
    env: currentEnv(),
    kind: "client",
    // A missing page is worth knowing, not an outage.
    level: kind === "notfound" ? "warn" : "error",
    source: "client",
    message: message.slice(0, 1000),
    stack: typeof body.stack === "string" ? body.stack.slice(0, 8000) : null,
    // Named for what it is rather than reusing the browser's own class name:
    // grouping on `TypeError` would merge every unrelated frontend bug in the
    // app into one issue, and minified builds make the name near-meaningless
    // anyway (no source maps — see the decision log in the plan).
    errorType: `client_${kind}`,
    httpRoute: path ? templateRoute(path.split("?")[0] ?? path) : null,
    actorId,
    actorRole,
    traceId: parseCorrelationId(
      request.headers.get(OBS_TRACE_ID_HEADER),
      "trace"
    ),
    requestId: parseCorrelationId(
      request.headers.get(OBS_REQUEST_ID_HEADER),
      "req"
    ),
    attrs: {
      // `digest` is the bridge: the same string the user is looking at on the
      // error screen, and the same one `onRequestError` recorded for the server
      // throw underneath it. It is what turns two half-stories into one.
      digest: typeof body.digest === "string" ? body.digest : undefined,
      componentStack:
        typeof body.componentStack === "string"
          ? body.componentStack.slice(0, 300)
          : undefined,
      appVersion:
        typeof body.appVersion === "string" ? body.appVersion : undefined,
      browser: request.headers.get("user-agent")?.slice(0, 200) ?? undefined,
      route: path ?? undefined,
      steps: cleanSteps(body.steps),
    },
  });

  return new NextResponse(null, { status: 204 });
}
