import "server-only";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
  isSupabaseConfigured,
} from "@/lib/supabase/config";
import { redactAttrs, redactText } from "./redact";
import { culpritFrame, fingerprint, issueTitle } from "./fingerprint";
import { classifySeverity } from "./severity";
import { currentEnv, currentRelease } from "./ids";
import type {
  ObsDomainEvent,
  ObsEvent,
  ObsEventRow,
  ObsLevel,
  ObsProvider,
} from "./types";

/**
 * The write side of observability.
 *
 * ## Three rules this module may never break
 *
 * 1. **It never throws into its caller.** Every public function here is
 *    wrapped. An order must not fail to be placed because the telemetry about
 *    placing it could not be written — that would make the monitoring a new and
 *    worse outage than the one it was installed to find. Every failure path
 *    below ends in a swallow.
 *
 * 2. **It never adds latency to a response.** Writes are handed to Next's
 *    `after()`, which runs them once the response has been flushed
 *    (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`).
 *    The customer waiting for their basket to become an order does not wait for
 *    a log row.
 *
 * 3. **It redacts before it builds the row.** `redact()` runs here, not in the
 *    console, so there is no path — including a future "debug mode" — that puts
 *    an unredacted string in the database. See `redact.ts`.
 *
 * ## Why the service-role client
 *
 * The `obs_*` tables have RLS on with no policies and every privilege revoked
 * from `anon` and `authenticated` (migration 0046). That is the containment the
 * project already uses for `rate_limits` and `vendor_login_credentials`, and it
 * means the only way in is the service role. Per AGENTS.md rule 5 this needs an
 * authorization check above it in the same path — and it has one, of an unusual
 * shape: this path only ever WRITES, and it writes a fixed row built from
 * already-redacted values. There is no user input that can steer it at a row it
 * should not touch, and nothing it can read back. The reading side, which is
 * where authorization actually matters, lives in `read.ts` behind
 * `requireRole("developer")`.
 */

/* ============================================================
   Buffer
   ============================================================ */

/**
 * Pending events, flushed once per request by `after()`.
 *
 * Module-level rather than per-request: a serverless instance may serve
 * concurrent requests, and mixing two requests' events into one insert is
 * harmless — every row is independent and carries its own `request_id`. What it
 * buys is one round trip instead of one per event, which matters on a function
 * billed by the millisecond.
 */
let buffer: ObsEventRow[] = [];
let flushScheduled = false;

/**
 * Hard ceiling on the buffer.
 *
 * A retry loop that emits an event per attempt could otherwise grow this until
 * the function runs out of memory — turning a recoverable provider failure into
 * a crashed instance. Past the ceiling we drop, and we say so: the drop is
 * itself recorded (once) so the console can show that telemetry was shed rather
 * than quietly showing a smaller number.
 */
const MAX_BUFFER = 200;
let droppedSinceFlush = 0;

/** Logged once per process, like the rate limiter's own fallback notice. */
let warnedUnconfigured = false;

function backendReady(): boolean {
  return Boolean(
    isSupabaseConfigured && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  );
}

/**
 * Push the buffer to `obs_ingest` in one call.
 *
 * Exported so `scripts/qa/obs-telemetry.ts` can force a flush and then assert on
 * what landed, rather than sleeping and hoping.
 */
async function flushObs(): Promise<number> {
  const batch = buffer;
  const dropped = droppedSinceFlush;
  buffer = [];
  droppedSinceFlush = 0;
  flushScheduled = false;

  if (!batch.length) return 0;
  if (!backendReady()) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        "[obs] SUPABASE_SERVICE_ROLE_KEY missing — telemetry is not being stored."
      );
    }
    return 0;
  }

  if (dropped > 0) {
    batch.push(
      buildRow({
        env: currentEnv(),
        kind: "log",
        level: "warn",
        source: "lib/obs",
        message: `Telemetry buffer overflowed — ${dropped} events dropped in this request`,
        attrs: { reason: "buffer_overflow", limit: MAX_BUFFER },
      })
    );
  }

  try {
    const supabase = createAdminClient();
    const { error } = await supabase.rpc("obs_ingest", { p_events: batch });
    if (error) {
      // The one place a telemetry failure is allowed to reach a real log: if
      // this is broken, nothing else in the system can report that it is.
      console.error("[obs] ingest failed:", error.message);
      return 0;
    }
    return batch.length;
  } catch (err) {
    console.error(
      "[obs] ingest threw:",
      err instanceof Error ? err.message : String(err)
    );
    return 0;
  }
}

/**
 * Ask for a flush after the response goes out.
 *
 * `after()` throws when called outside a request scope — a module top level, a
 * script, `register()` in instrumentation. That is not an error worth
 * propagating, so the fallback is a detached promise: less reliable (the
 * instance may be frozen before it settles) but strictly better than losing the
 * event, and the only contexts that hit it are ones with no response to wait
 * for anyway.
 */
function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  try {
    after(async () => {
      await flushObs();
    });
  } catch {
    void flushObs();
  }
}

/* ============================================================
   Row construction
   ============================================================ */

function buildRow(event: ObsEvent): ObsEventRow {
  const message = redactText(event.message ?? "").slice(0, 2000) || "(no message)";
  const stack = event.stack ? redactText(event.stack).slice(0, 8000) : null;

  // The culprit is whatever the caller named, else the first frame of ours in
  // the stack, else the route. Order matters: an explicit culprit is a
  // deliberate grouping decision and must win.
  const culprit =
    event.culprit ?? culpritFrame(stack) ?? event.httpRoute ?? event.source;

  // Only failures are grouped into issues. Grouping `info` would fill the issue
  // list with things nobody has to do anything about, which is how an issue
  // list stops being read.
  const groupable =
    event.level === "warn" || event.level === "error" || event.level === "fatal";

  const fp = groupable
    ? (event.errorFingerprint ??
      fingerprint({
        env: event.env,
        kind: event.kind,
        errorType: event.errorType,
        message,
        culprit,
        httpMethod: event.httpMethod,
        httpRoute: event.httpRoute,
        httpStatus: event.httpStatus,
      }))
    : null;

  return {
    occurred_at: event.occurredAt ?? new Date().toISOString(),
    env: event.env,
    release: event.release ?? currentRelease(),
    kind: event.kind,
    level: event.level,
    source: event.source,
    message,
    trace_id: event.traceId ?? null,
    request_id: event.requestId ?? null,
    span_id: event.spanId ?? null,
    parent_span_id: event.parentSpanId ?? null,
    duration_ms:
      typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
        ? Math.round(event.durationMs)
        : null,
    http_method: event.httpMethod ?? null,
    http_route: event.httpRoute ?? null,
    http_status: event.httpStatus ?? null,
    provider: event.provider ?? null,
    error_type: event.errorType ?? null,
    error_fingerprint: fp,
    stack,
    actor_role: event.actorRole ?? null,
    actor_id: event.actorId ?? null,
    order_id: event.orderId ?? null,
    restaurant_id: event.restaurantId ?? null,
    driver_id: event.driverId ?? null,
    attrs: redactAttrs(event.attrs),
    title: issueTitle(event.errorType, message),
    culprit,
    severity: event.severity ?? classifySeverity(event),
  };
}

/**
 * Sampling.
 *
 * Successful, fast requests are the overwhelming majority of the stream and the
 * least informative row in it. Keeping one in ten preserves the shape of the
 * traffic — which is all the rollups need, since they aggregate — at a tenth of
 * the storage.
 *
 * Nothing that failed, nothing that was slow, and nothing from a provider or a
 * domain checkpoint is ever sampled. The console displays the sample rate
 * beside request counts, so a sampled figure is never read as a total.
 */
export const OBS_HTTP_SAMPLE_RATE = 0.1;
const SLOW_MS = 1000;

function shouldSample(event: ObsEvent): boolean {
  if (event.kind !== "http") return true;
  if (event.level !== "info" && event.level !== "debug") return true;
  if ((event.httpStatus ?? 200) >= 400) return true;
  if ((event.durationMs ?? 0) >= SLOW_MS) return true;
  // Web Crypto rather than Math.random: the same uniform [0, 1) draw, and it
  // exists in both the Node and edge runtimes.
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 < OBS_HTTP_SAMPLE_RATE;
}

/* ============================================================
   Public surface
   ============================================================ */

/**
 * Record one event. Never throws, never awaits, never blocks a response.
 *
 * The whole body is inside a try/catch including the redaction and
 * fingerprinting — a malformed `attrs` object with a getter that throws would
 * otherwise take down the request it was describing.
 */
export function emit(event: ObsEvent): void {
  try {
    if (!shouldSample(event)) return;

    if (buffer.length >= MAX_BUFFER) {
      droppedSinceFlush += 1;
      return;
    }

    buffer.push(buildRow(event));
    scheduleFlush();
  } catch {
    // Telemetry that fails to record itself is a lost row, not an outage.
  }
}

/** Fields every emitter in a request shares. Threaded through by the wrapper. */
export interface ObsContext {
  traceId?: string | null;
  requestId?: string | null;
  actorRole?: string | null;
  actorId?: string | null;
  orderId?: string | null;
  restaurantId?: string | null;
  driverId?: string | null;
}

/**
 * A named business checkpoint: `order.created`, `payment.settle`,
 * `dispatch.assign`.
 *
 * These are the series the Deligro-specific pages and most of the default alert
 * rules are built on, and they are the reason this system is in Postgres rather
 * than in an error tracker. `order.created` failing is not a stack trace
 * question — it is "how many, whose, and which restaurants".
 */
export function recordDomain(
  event: ObsDomainEvent,
  level: ObsLevel,
  message: string,
  ctx: ObsContext & {
    durationMs?: number;
    attrs?: Record<string, unknown>;
    error?: unknown;
  } = {}
): void {
  const err = ctx.error;
  emit({
    env: currentEnv(),
    kind: "domain",
    level,
    source: event,
    message,
    durationMs: ctx.durationMs,
    errorType: err instanceof Error ? err.name : errorCodeOf(err),
    stack: err instanceof Error ? (err.stack ?? null) : null,
    attrs: ctx.attrs,
    traceId: ctx.traceId,
    requestId: ctx.requestId,
    actorRole: ctx.actorRole,
    actorId: ctx.actorId,
    orderId: ctx.orderId,
    restaurantId: ctx.restaurantId,
    driverId: ctx.driverId,
  });
}

/**
 * A call out to somebody else's service.
 *
 * The single most valuable thing this system records, because it is the only
 * evidence that separates "Razorpay is down" from "we broke checkout" — which
 * is the first question of every payment incident and currently takes an
 * afternoon and a status page to answer.
 */
export function recordProvider(
  provider: ObsProvider,
  operation: string,
  outcome: { ok: boolean; durationMs: number; status?: number; detail?: string },
  ctx: ObsContext & { attrs?: Record<string, unknown> } = {}
): void {
  const detail = outcome.detail ? `: ${outcome.detail}` : "";
  emit({
    env: currentEnv(),
    kind: "provider",
    level: outcome.ok ? "info" : "error",
    source: `provider/${provider}`,
    provider,
    message: outcome.ok
      ? `${provider} ${operation} ok`
      : `${provider} ${operation} failed${detail}`,
    durationMs: outcome.durationMs,
    httpStatus: outcome.status ?? null,
    errorType: outcome.ok ? null : `${provider}_error`,
    attrs: { ...ctx.attrs, event: operation, status: outcome.status },
    traceId: ctx.traceId,
    requestId: ctx.requestId,
    actorRole: ctx.actorRole,
    actorId: ctx.actorId,
    orderId: ctx.orderId,
    restaurantId: ctx.restaurantId,
    driverId: ctx.driverId,
  });
}

/** An unhandled throw, from anywhere. */
export function captureError(
  err: unknown,
  ctx: ObsContext & {
    source: string;
    kind?: "error" | "client" | "db";
    httpMethod?: string | null;
    httpRoute?: string | null;
    httpStatus?: number | null;
    attrs?: Record<string, unknown>;
  }
): void {
  const isError = err instanceof Error;
  emit({
    env: currentEnv(),
    kind: ctx.kind ?? "error",
    level: "error",
    source: ctx.source,
    message: isError ? err.message : describeNonError(err),
    errorType: isError ? err.name : (errorCodeOf(err) ?? "UnknownError"),
    stack: isError ? (err.stack ?? null) : null,
    httpMethod: ctx.httpMethod,
    httpRoute: ctx.httpRoute,
    httpStatus: ctx.httpStatus,
    attrs: ctx.attrs,
    traceId: ctx.traceId,
    requestId: ctx.requestId,
    actorRole: ctx.actorRole,
    actorId: ctx.actorId,
    orderId: ctx.orderId,
    restaurantId: ctx.restaurantId,
    driverId: ctx.driverId,
  });
}

/**
 * PostgREST rejections arrive as plain objects, not `Error`s — which is exactly
 * why `api/orders/route.ts` has to `JSON.stringify(err)` to log anything
 * useful. Their `code` is the whole diagnosis (42501 is an RLS refusal, 42703 a
 * missing column, 23505 a unique violation), so it becomes the error type and
 * the thing the issue groups on.
 */
function errorCodeOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code ? `pg_${code}` : null;
}

function describeNonError(err: unknown): string {
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
    try {
      return JSON.stringify(err).slice(0, 500);
    } catch {
      return "Non-serialisable thrown value";
    }
  }
  return String(err);
}
