import "server-only";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  SUPABASE_SERVICE_ROLE_KEY,
  isSupabaseConfigured,
} from "@/lib/supabase/config";
import { isRazorpayConfigured } from "@/lib/payments/razorpay";
import { isMissingColumn } from "@/lib/data-access/schema-probe";
import { isPushConfigured } from "@/lib/notifications/onesignal";
import { smsConfigured } from "@/lib/sms/renflair";
import { rangeStart, previousWindow, type ObsRange } from "./read";
import type { ObsEnv } from "./types";

/**
 * Aggregates: the numbers, not the rows.
 *
 * Split from `read.ts` because it answers a different question with a different
 * source. `read.ts` reads individual events and issues; this reads
 * `obs_metrics_rollup` — which is the only thing that still exists past the
 * 14-day raw window — plus the platform's own tables for the order, payment and
 * delivery health that no telemetry system could infer.
 *
 * That last part is the whole argument for building this in Postgres. "Which 17
 * orders are stuck in Preparing" is a query against `orders`, joined to nothing
 * an error tracker can see.
 *
 * Same authorization contract as `read.ts`: `requireRole("developer")` above every
 * `createAdminClient()`, in the same path.
 */

const UNDEFINED_TABLE = "42P01";
const UNDEFINED_FUNCTION = "42883";

function isNotMigrated(error: { code?: string } | null): boolean {
  return error?.code === UNDEFINED_TABLE || error?.code === UNDEFINED_FUNCTION;
}

async function guard(): Promise<boolean> {
  await requireRole("developer");
  return Boolean(isSupabaseConfigured && SUPABASE_SERVICE_ROLE_KEY);
}

/* ============================================================
   Error KPIs
   ============================================================ */

export interface ErrorSummary {
  total: number;
  critical: number;
  unresolvedIssues: number;
  newIssues: number;
  regressedIssues: number;
  /** Signed % change against the immediately preceding window of equal length. */
  changePct: number | null;
  /** True when the pipeline could not be read — never presented as zero. */
  unavailable: boolean;
}

const NO_SUMMARY: ErrorSummary = {
  total: 0,
  critical: 0,
  unresolvedIssues: 0,
  newIssues: 0,
  regressedIssues: 0,
  changePct: null,
  unavailable: true,
};

export async function getErrorSummary(
  range: ObsRange = "24h",
  env: ObsEnv = "production"
): Promise<ErrorSummary> {
  if (!(await guard())) return NO_SUMMARY;

  const supabase = createAdminClient();
  const from = rangeStart(range).toISOString();
  const prev = previousWindow(range);

  try {
    const [current, previous, issues] = await Promise.all([
      supabase
        .from("obs_events")
        .select("id", { count: "exact", head: true })
        .eq("env", env)
        .gte("occurred_at", from)
        .in("level", ["error", "fatal"]),
      supabase
        .from("obs_events")
        .select("id", { count: "exact", head: true })
        .eq("env", env)
        .gte("occurred_at", prev.from.toISOString())
        .lt("occurred_at", prev.to.toISOString())
        .in("level", ["error", "fatal"]),
      supabase
        .from("obs_issues")
        .select("status, severity, first_seen")
        .eq("env", env)
        .in("status", ["open", "investigating", "regressed"]),
    ]);

    if (current.error) {
      if (isNotMigrated(current.error)) return NO_SUMMARY;
      throw current.error;
    }

    const rows = (issues.data ?? []) as Array<{
      status: string;
      severity: string;
      first_seen: string;
    }>;

    const total = current.count ?? 0;
    const before = previous.count ?? 0;

    return {
      total,
      critical: rows.filter((r) => r.severity === "critical").length,
      unresolvedIssues: rows.length,
      newIssues: rows.filter((r) => r.first_seen >= from).length,
      regressedIssues: rows.filter((r) => r.status === "regressed").length,
      // A rise from nothing is not an infinite percentage, and a window with no
      // history to compare against has no honest percentage at all — so it gets
      // null and the UI omits the comparison rather than printing "+0%".
      changePct: changePercent(total, before),
      unavailable: false,
    };
  } catch (err) {
    if (isNotMigrated(err as { code?: string })) return NO_SUMMARY;
    throw err;
  }
}

function changePercent(total: number, before: number): number | null {
  if (before !== 0) return Math.round(((total - before) / before) * 1000) / 10;
  return total === 0 ? 0 : null;
}

/* ============================================================
   Rollup series
   ============================================================ */

export interface MetricRow {
  key: string;
  count: number;
  errorCount: number;
  errorRate: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/**
 * Per-key aggregates over a window, for the endpoint / provider / domain tables.
 *
 * Percentiles are aggregated as a MAX of the per-minute percentiles, not a
 * percentile of percentiles pretending to be exact. That over-reports slightly
 * — it is the worst minute's p95, not the window's — which is the right
 * direction to be wrong in for a latency figure, and the console labels it.
 */
export async function getMetricRows(
  dimension: "route" | "provider" | "domain",
  range: ObsRange = "24h",
  env: ObsEnv = "production"
): Promise<{ rows: MetricRow[]; unavailable: boolean }> {
  if (!(await guard())) return { rows: [], unavailable: true };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("obs_metrics_rollup")
    .select("key, count, error_count, p50_ms, p95_ms, p99_ms")
    .eq("env", env)
    .eq("dimension", dimension)
    .gte("bucket", rangeStart(range).toISOString())
    .limit(20000);

  if (error) {
    if (isNotMigrated(error)) return { rows: [], unavailable: true };
    throw error;
  }

  const acc = new Map<string, MetricRow>();
  for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
    const key = String(raw.key);
    const row =
      acc.get(key) ??
      { key, count: 0, errorCount: 0, errorRate: 0, p50: null, p95: null, p99: null };

    row.count += Number(raw.count ?? 0);
    row.errorCount += Number(raw.error_count ?? 0);
    row.p50 = maxOrNull(row.p50, raw.p50_ms);
    row.p95 = maxOrNull(row.p95, raw.p95_ms);
    row.p99 = maxOrNull(row.p99, raw.p99_ms);
    acc.set(key, row);
  }

  const rows = [...acc.values()].map((r) => ({
    ...r,
    errorRate: r.count > 0 ? (r.errorCount / r.count) * 100 : 0,
  }));

  // Worst first: the operator opened this page because something is wrong, so
  // the thing that is wrong goes at the top. Volume breaks ties, because a 4%
  // failure rate on twelve thousand requests matters more than 100% on one.
  rows.sort((a, b) => b.errorRate - a.errorRate || b.count - a.count);
  return { rows, unavailable: false };
}

function maxOrNull(current: number | null, next: unknown): number | null {
  const n = next === null || next === undefined ? null : Number(next);
  if (n === null || Number.isNaN(n)) return current;
  return current === null ? n : Math.max(current, n);
}

/* ============================================================
   System health
   ============================================================ */

export type HealthState = "ok" | "degraded" | "down" | "unknown" | "off";

export interface HealthRow {
  label: string;
  state: HealthState;
  detail: string;
  /** Rendered as a footnote — where the state came from, or why it can't be known. */
  note?: string;
}

export interface SystemHealth {
  rows: HealthRow[];
  /** Worst state across the rows. `unknown` never rolls up as `ok`. */
  overall: HealthState;
}

/**
 * What is actually working.
 *
 * The rule: *"a health indicator that reports an invented figure is worse than
 * no health indicator at all: it is a green light wired to nothing."*
 *
 * So each row states what it knows and where it knows it from:
 *
 *   * **Configuration** rows (Razorpay, OneSignal, Renflair) are facts about
 *     env vars. They say "configured", never "operational" — a live key is not
 *     a working provider.
 *   * **Observed** rows come from the last hour of `obs_events`. Those are real
 *     liveness, and they are the only rows allowed to say "degraded".
 *   * **`off`** is its own state, distinct from `down`. A provider nobody
 *     configured is not an outage, and colouring it red would train an operator
 *     to ignore red.
 *   * **`unknown`** is what a failed probe reports. Never `ok`. Failing open on
 *     a health check is the same mistake as failing open on an auth check.
 *
 * Nothing here opens a socket to a provider. A synthetic probe would cost money
 * (Razorpay), send an SMS (Renflair) or push a notification to a real handset
 * (OneSignal) on every admin page load.
 */
export async function getSystemHealth(
  env: ObsEnv = "production"
): Promise<SystemHealth> {
  await requireRole("developer");

  const rows: HealthRow[] = [];

  // ---------- Database ----------
  // The one true liveness check available for free: if this query answers, the
  // database is up. Deliberately NOT read from telemetry — during a database
  // outage nothing can be written, so a telemetry-derived answer would be
  // silence, and silence must not read as health.
  let dbUp = false;
  if (isSupabaseConfigured) {
    try {
      const supabase = createAdminClient();
      const { error } = await supabase
        .from("platform_settings")
        .select("id", { head: true, count: "exact" })
        .limit(1);
      dbUp = !error;
    } catch {
      dbUp = false;
    }
  }
  let dbState: HealthState = "off";
  let dbDetail = "Not configured";
  if (isSupabaseConfigured) {
    dbState = dbUp ? "ok" : "down";
    dbDetail = dbUp ? "Answering" : "Not answering";
  }
  rows.push({
    label: "Database",
    state: dbState,
    detail: dbDetail,
    note: dbUp ? undefined : "Checked directly, not via telemetry",
  });

  // ---------- Telemetry pipeline ----------
  // The monitor monitoring itself. If this is stale, every other observed row
  // below is stale too, and the console has to say so rather than showing an
  // hour-old all-clear.
  const pipeline = await getPipelineHealth(env);
  rows.push(...pipeline);

  // ---------- Observed provider health ----------
  const observed = dbUp ? await observedProviders(env) : new Map<string, MetricRow>();

  rows.push(
    providerRow("Payments (Razorpay)", "razorpay", isRazorpayConfigured, observed),
    providerRow("Push (OneSignal)", "onesignal", isPushConfigured, observed),
    providerRow("SMS / OTP (Renflair)", "renflair", smsConfigured, observed),

    // ---------- What this deployment cannot see ----------
    // Stated as a row rather than omitted. An operator scanning a health page for
    // "is the queue backed up" needs to find the answer "there is no queue", not
    // an absence they will read as "fine".
    {
      label: "Host & connection pool",
      state: "unknown",
      detail: "Not observable from the app",
      note: "CPU, memory and pool usage belong to Vercel and Supabase — see their dashboards",
    }
  );

  const worst = rows.reduce<HealthState>((acc, r) => {
    const rank: Record<HealthState, number> = {
      down: 0,
      degraded: 1,
      unknown: 2,
      off: 3,
      ok: 4,
    };
    return rank[r.state] < rank[acc] ? r.state : acc;
  }, "ok");

  return { rows, overall: worst };
}

function providerRow(
  label: string,
  key: string,
  configured: boolean,
  observed: Map<string, MetricRow>
): HealthRow {
  if (!configured) {
    return {
      label,
      state: "off",
      detail: "Not configured",
      note: "No credentials on this deployment",
    };
  }
  const seen = observed.get(key);
  if (!seen || seen.count === 0) {
    // Configured but silent. That is genuinely unknown — it could be a quiet
    // hour or a dead integration — and saying "operational" would be a guess.
    return {
      label,
      state: "unknown",
      detail: "Configured, no calls in the last hour",
      note: "Nothing to measure yet",
    };
  }
  const rate = seen.errorRate;
  return {
    label,
    state: errorRateState(rate),
    detail:
      rate === 0
        ? `${seen.count} calls, all succeeded`
        : `${rate.toFixed(1)}% of ${seen.count} calls failed`,
    note: "Observed over the last hour",
  };
}

function errorRateState(rate: number): HealthState {
  if (rate >= 25) return "down";
  if (rate >= 5) return "degraded";
  return "ok";
}

async function observedProviders(env: ObsEnv): Promise<Map<string, MetricRow>> {
  try {
    const { rows } = await getMetricRows("provider", "1h", env);
    return new Map(rows.map((r) => [r.key, r]));
  } catch {
    return new Map();
  }
}

/**
 * The scheduled jobs' heartbeats.
 *
 * Without `pg_cron` running these, ingest still works but nothing is rolled up,
 * nothing expires and no alert can ever fire — and every symptom of that is an
 * absence. This is what turns that absence into a sentence.
 */
export async function getPipelineHealth(env: ObsEnv): Promise<HealthRow[]> {
  if (!isSupabaseConfigured || !SUPABASE_SERVICE_ROLE_KEY) {
    return [
      {
        label: "Telemetry",
        state: "off",
        detail: "Service role key not set",
        note: "Nothing is being recorded",
      },
    ];
  }

  const supabase = createAdminClient();

  const [jobs, recent] = await Promise.all([
    supabase.from("obs_job_runs").select("*"),
    supabase
      .from("obs_events")
      .select("id", { count: "exact", head: true })
      .eq("env", env)
      .gte("occurred_at", new Date(Date.now() - 60 * 60_000).toISOString()),
  ]);

  if (isNotMigrated(jobs.error) || isNotMigrated(recent.error)) {
    return [
      {
        label: "Telemetry",
        state: "off",
        detail: "Migration 0046 not applied",
        note: "Run supabase/migrations/0046_observability.sql",
      },
    ];
  }

  const rows: HealthRow[] = [];
  const ingested = recent.count ?? 0;

  rows.push({
    label: "Event ingestion",
    state: ingested > 0 ? "ok" : "unknown",
    detail:
      ingested > 0
        ? `${ingested} events in the last hour`
        : "No events in the last hour",
    note:
      ingested > 0
        ? undefined
        : "Could be a quiet hour or a broken emitter — it cannot tell the two apart",
  });

  const byJob = new Map(
    ((jobs.data ?? []) as Array<Record<string, unknown>>).map((j) => [
      String(j.job),
      j,
    ])
  );

  // Each job's tolerance is its own cadence plus slack. The rollup runs every
  // minute, so 10 minutes of silence is broken; retention runs daily, so it is
  // measured in days.
  for (const [job, label, staleMin] of [
    ["rollup", "Metrics rollup", 10],
    ["alerts", "Alert evaluation", 10],
    ["partitions", "Partition maintenance", 60 * 36],
    ["retention", "Retention", 60 * 36],
  ] as const) {
    rows.push(jobRow(byJob.get(job), label, staleMin));
  }

  return rows;
}

/** One scheduled job's heartbeat, judged against its own cadence. */
function jobRow(
  row: Record<string, unknown> | undefined,
  label: string,
  staleMin: number
): HealthRow {
  if (!row) {
    return {
      label,
      state: "off",
      detail: "Never run",
      note: "pg_cron job not scheduled — see the footer of migration 0046",
    };
  }
  const lastOk =
    typeof row.last_ok_at === "string" && row.last_ok_at
      ? new Date(row.last_ok_at)
      : null;
  const ageMin = lastOk ? (Date.now() - lastOk.getTime()) / 60_000 : Infinity;
  return {
    label,
    state: ageMin <= staleMin ? "ok" : "degraded",
    detail: lastOk
      ? `Last ran ${formatAge(ageMin)} ago`
      : "Has never completed",
    note:
      ageMin <= staleMin
        ? undefined
        : "Stale — figures downstream of this job are out of date",
  };
}

function formatAge(minutes: number): string {
  if (!Number.isFinite(minutes)) return "never";
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / (60 * 24))} d`;
}

/* ============================================================
   Order health — from the platform's own tables
   ============================================================ */

export interface StuckOrder {
  id: string;
  status: string;
  createdAt: string;
  acceptedAt: string | null;
  readyAt: string | null;
  restaurantName: string | null;
  /** Minutes spent in the current status. */
  stuckMinutes: number;
  paymentStatus: string | null;
}

export interface OrderHealth {
  created: number;
  cancelled: number;
  awaitingAcceptance: StuckOrder[];
  stuckInKitchen: StuckOrder[];
  readyNoRider: StuckOrder[];
  unavailable: boolean;
}

/**
 * Orders that have stopped moving.
 *
 * Read from `orders` directly, using the lifecycle timestamps migration 0026
 * added — which are stamped by a database trigger, so they are correct whichever
 * path moved the order and cannot be forged by whoever holds the row. That
 * makes this the most trustworthy signal in the whole system, and it needed no
 * new instrumentation at all: it was already there and nothing was reading it.
 *
 * The thresholds are deliberately generous. A kitchen taking 40 minutes on a
 * Friday night is busy, not broken, and an alert that fires on busy is an alert
 * that gets muted before it ever fires on broken.
 */
const AWAITING_ACCEPTANCE_MIN = 10;
const IN_KITCHEN_MIN = 60;
const READY_NO_RIDER_MIN = 20;

function enteredStatusAt(
  r: Record<string, unknown>,
  status: string
): string | null {
  if (status === "ready") return r.ready_at as string | null;
  if (status === "kitchen") return r.accepted_at as string | null;
  return r.created_at as string;
}

export async function getOrderHealth(
  range: ObsRange = "24h"
): Promise<OrderHealth> {
  const empty: OrderHealth = {
    created: 0,
    cancelled: 0,
    awaitingAcceptance: [],
    stuckInKitchen: [],
    readyNoRider: [],
    unavailable: true,
  };
  if (!(await guard())) return empty;

  const supabase = createAdminClient();
  const from = rangeStart(range).toISOString();

  try {
    const [counts, live] = await Promise.all([
      supabase
        .from("orders")
        .select("status")
        .gte("created_at", from)
        .limit(20000),
      supabase
        .from("orders")
        .select(
          "id, status, created_at, accepted_at, ready_at, payment_status, restaurants(name)"
        )
        .in("status", ["placed", "kitchen", "ready"])
        .limit(500),
    ]);

    if (counts.error) throw counts.error;

    const statuses = (counts.data ?? []) as Array<{ status: string }>;
    const rows = (live.data ?? []) as Array<Record<string, unknown>>;
    const now = Date.now();

    const mapped = rows.map((r): StuckOrder => {
      const restaurant = r.restaurants as { name?: string } | { name?: string }[] | null;
      const one = Array.isArray(restaurant) ? restaurant[0] : restaurant;
      const status = String(r.status);
      // Time in the CURRENT status, not since the order was placed. An order 90
      // minutes old that entered the kitchen two minutes ago is not stuck.
      const since = enteredStatusAt(r, status);
      return {
        id: String(r.id),
        status,
        createdAt: String(r.created_at),
        acceptedAt: (r.accepted_at as string | null) ?? null,
        readyAt: (r.ready_at as string | null) ?? null,
        restaurantName: one?.name ?? null,
        paymentStatus: (r.payment_status as string | null) ?? null,
        stuckMinutes: since
          ? Math.round((now - new Date(since).getTime()) / 60_000)
          : 0,
      };
    });

    return {
      created: statuses.length,
      cancelled: statuses.filter((s) => s.status === "cancelled").length,
      awaitingAcceptance: mapped
        .filter((o) => o.status === "placed" && o.stuckMinutes >= AWAITING_ACCEPTANCE_MIN)
        .sort((a, b) => b.stuckMinutes - a.stuckMinutes),
      stuckInKitchen: mapped
        .filter((o) => o.status === "kitchen" && o.stuckMinutes >= IN_KITCHEN_MIN)
        .sort((a, b) => b.stuckMinutes - a.stuckMinutes),
      readyNoRider: mapped
        .filter((o) => o.status === "ready" && o.stuckMinutes >= READY_NO_RIDER_MIN)
        .sort((a, b) => b.stuckMinutes - a.stuckMinutes),
      unavailable: false,
    };
  } catch (err) {
    if (isNotMigrated(err as { code?: string })) return empty;
    throw err;
  }
}

/* ============================================================
   Payment health — from the payments table
   ============================================================ */

export interface PaymentHealth {
  attempts: number;
  paid: number;
  failed: number;
  pending: number;
  refunded: number;
  successRate: number | null;
  /** Paid at the provider but the order is not marked paid — money we owe an answer for. */
  orphaned: number;
  unavailable: boolean;
  /** Set when the payments migration (0025) is not applied. */
  notMigrated: boolean;
}

export async function getPaymentHealth(
  range: ObsRange = "24h"
): Promise<PaymentHealth> {
  const empty: PaymentHealth = {
    attempts: 0,
    paid: 0,
    failed: 0,
    pending: 0,
    refunded: 0,
    successRate: null,
    orphaned: 0,
    unavailable: true,
    notMigrated: false,
  };
  if (!(await guard())) return empty;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("payments")
    .select("status, order_id, orders(payment_status)")
    .gte("created_at", rangeStart(range).toISOString())
    .limit(20000);

  if (error) {
    if (isNotMigrated(error)) return { ...empty, notMigrated: true, unavailable: false };
    throw error;
  }

  const rows = (data ?? []) as Array<{
    status: string;
    order_id: string | null;
    orders: { payment_status?: string } | { payment_status?: string }[] | null;
  }>;

  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const paid = count("paid");
  const failed = count("failed");
  const attempts = rows.length;

  // The reconciliation that matters: a payment row says paid, the order does
  // not. That is the `payment.settle` failure seen from the other side — and
  // unlike the telemetry, this survives the 14-day window because it is derived
  // from the money, not from a log.
  const orphaned = rows.filter((r) => {
    if (r.status !== "paid") return false;
    const order = Array.isArray(r.orders) ? r.orders[0] : r.orders;
    return order ? order.payment_status !== "paid" : false;
  }).length;

  return {
    attempts,
    paid,
    failed,
    pending: count("created") + count("authorized"),
    refunded: count("refunded"),
    successRate: attempts > 0 ? (paid / attempts) * 100 : null,
    orphaned,
    unavailable: false,
    notMigrated: false,
  };
}

/* ============================================================
   Delivery health
   ============================================================ */

export interface DeliveryHealth {
  active: number;
  unassigned: number;
  offeredNotAccepted: number;
  ridersOnline: number;
  unavailable: boolean;
}

export async function getDeliveryHealth(): Promise<DeliveryHealth> {
  const empty: DeliveryHealth = {
    active: 0,
    unassigned: 0,
    offeredNotAccepted: 0,
    ridersOnline: 0,
    unavailable: true,
  };
  if (!(await guard())) return empty;

  const supabase = createAdminClient();
  const read = (cols: string) =>
    supabase.from("deliveries").select(cols).is("delivered_at", null).limit(1000);
  let { data, error } = await read("id, driver_id, offered_driver_id, delivered_at");
  // Before migration 0042 there is no dispatch offer to count. That used to
  // throw and take the whole Delivery tab down with a 500; without the column
  // every rider-less delivery is simply unassigned.
  if (error && isMissingColumn(error)) {
    ({ data, error } = await read("id, driver_id, delivered_at"));
  }

  if (error) {
    if (isNotMigrated(error)) return empty;
    throw error;
  }

  const rows = (data ?? []) as unknown as Array<{
    driver_id: string | null;
    offered_driver_id?: string | null;
  }>;

  return {
    active: rows.filter((r) => r.driver_id).length,
    // Nobody holds it and nobody has been asked. On a busy evening this should
    // be zero or near it; a number that stays high means dispatch is not finding
    // riders, which is the `dispatch.assign` failure with a different face.
    unassigned: rows.filter((r) => !r.driver_id && !r.offered_driver_id).length,
    offeredNotAccepted: rows.filter((r) => !r.driver_id && r.offered_driver_id)
      .length,
    ridersOnline: new Set(rows.map((r) => r.driver_id).filter(Boolean)).size,
    unavailable: false,
  };
}
