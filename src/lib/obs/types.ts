/**
 * The telemetry vocabulary, in one place.
 *
 * Deliberately free of `server-only` and of any I/O: everything here is a type
 * or a constant, so `scripts/qa/obs-telemetry.ts` can import it and assert
 * against the same names the server uses. Same reasoning as
 * `lib/releases/app-version.ts` — the rules worth testing should not be locked
 * inside a module that needs a database to load.
 *
 * These strings are mirrored by CHECK constraints in migration 0046. Changing
 * one here without changing the migration produces a runtime insert failure,
 * not a type error, so keep the two together.
 */

/** Which deployment produced this. Never mixed in a view without saying so. */
export type ObsEnv = "production" | "preview" | "development";

/**
 * What sort of thing happened. `kind` answers "what is this row", `level`
 * answers "how bad".
 *
 *  - `http`     one request through a route handler
 *  - `error`    a throw, from anywhere
 *  - `provider` a call out to Razorpay / OneSignal / Renflair / Maps
 *  - `db`       a database operation worth timing
 *  - `domain`   a named business checkpoint (order.created, payment.settle)
 *  - `client`   reported by a browser
 *  - `log`      a deliberate message that is none of the above
 */
type ObsKind =
  | "http"
  | "error"
  | "provider"
  | "db"
  | "domain"
  | "client"
  | "log";

export type ObsLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type ObsSeverity = "critical" | "high" | "medium" | "low" | "info";

export type ObsIssueStatus =
  | "open"
  | "investigating"
  | "resolved"
  | "ignored"
  /** Came back after being resolved — a distinct and more urgent fact. */
  | "regressed";

export type ObsIncidentStatus =
  | "detected"
  | "investigating"
  | "identified"
  | "mitigating"
  | "resolved"
  | "closed";

/**
 * The external services this platform depends on. Named as a closed set so a
 * typo cannot quietly create a second series for the same provider — which
 * would split its failure rate in half and hide an outage.
 */
export const OBS_PROVIDERS = [
  "razorpay",
  "onesignal",
  "renflair",
  "supabase",
  "maps",
] as const;

export type ObsProvider = (typeof OBS_PROVIDERS)[number];

/**
 * Named business checkpoints. A closed set for the same reason as the
 * providers, and because these are what the default alert rules in migration
 * 0046 are keyed on — a renamed checkpoint silently disarms its alert, so the
 * names live here and the migration quotes them.
 */
export type ObsDomainEvent =
  | "order.created"
  | "order.refused"
  | "order.cancelled"
  | "order.status"
  | "payment.initiate"
  | "payment.settle"
  | "payment.webhook"
  | "payment.refund"
  | "dispatch.assign"
  | "dispatch.accept"
  | "notify.push"
  | "notify.sms"
  | "auth.otp"
  | "schema.degraded"
  | "ratelimit.degraded"
  /** The dispatch sweep deleting 90-day-old proof-of-delivery photos (ruling P8-R4). */
  | "retention.proof_photo";

/**
 * One row, as the emitter builds it and `obs_ingest` stores it.
 *
 * Every free-text field here has already been through `redact()` by the time it
 * reaches the database. There is no field for a request body, a response body
 * or a header bag, and that is not an oversight — see `redact.ts`.
 */
export interface ObsEvent {
  occurredAt?: string;
  env: ObsEnv;
  release?: string | null;

  kind: ObsKind;
  level: ObsLevel;
  /** Our module, e.g. `api/orders`, `lib/dispatch`, or a domain event name. */
  source: string;
  message: string;

  traceId?: string | null;
  requestId?: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  durationMs?: number | null;

  httpMethod?: string | null;
  /** TEMPLATED: `/api/orders/[id]`. Never the concrete path. */
  httpRoute?: string | null;
  httpStatus?: number | null;

  provider?: ObsProvider | null;

  errorType?: string | null;
  errorFingerprint?: string | null;
  stack?: string | null;

  actorRole?: string | null;
  /** A `profiles.id`. Never a name, phone or email. */
  actorId?: string | null;
  orderId?: string | null;
  restaurantId?: string | null;
  driverId?: string | null;

  attrs?: Record<string, unknown>;

  /* --- issue-grouping hints, used only when a fingerprint is present --- */
  title?: string;
  culprit?: string | null;
  severity?: ObsSeverity;
}

/** The snake_case shape `obs_ingest(jsonb)` expects. */
export interface ObsEventRow {
  occurred_at?: string;
  env: string;
  release?: string | null;
  kind: string;
  level: string;
  source: string;
  message: string;
  trace_id?: string | null;
  request_id?: string | null;
  span_id?: string | null;
  parent_span_id?: string | null;
  duration_ms?: number | null;
  http_method?: string | null;
  http_route?: string | null;
  http_status?: number | null;
  provider?: string | null;
  error_type?: string | null;
  error_fingerprint?: string | null;
  stack?: string | null;
  actor_role?: string | null;
  actor_id?: string | null;
  order_id?: string | null;
  restaurant_id?: string | null;
  driver_id?: string | null;
  attrs?: Record<string, unknown>;
  title?: string;
  culprit?: string | null;
  severity?: string;
}

/** Header names the emitter and the console agree on. */
export const OBS_REQUEST_ID_HEADER = "x-request-id";
export const OBS_TRACE_ID_HEADER = "x-trace-id";
