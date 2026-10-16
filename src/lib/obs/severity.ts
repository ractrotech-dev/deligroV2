/**
 * How bad is this, on first sight.
 *
 * Two different questions get answered in two different places, and conflating
 * them is how monitoring systems end up either screaming or silent:
 *
 *   * **Here** — what a SINGLE event is worth, knowing nothing about rate. This
 *     is a lookup, deliberately: it must be readable, reviewable and the same
 *     every time, because it decides what shows up red in the issue list.
 *   * **`obs_evaluate_alerts` (migration 0046)** — whether a RATE has crossed a
 *     line. Only the database can answer that; it needs a window, a sample
 *     floor and history.
 *
 * So "one push failed" is medium here and never pages anyone, while "a quarter
 * of pushes are failing" is an alert rule. Neither can be expressed as the
 * other.
 *
 * An operator's manual severity always wins and is never recomputed — enforced
 * in SQL by the `severity_source = 'manual'` branch in `obs_ingest`, so it
 * holds even for a caller that bypasses this module.
 *
 * Pure and free of `server-only` so the QA suite can assert the table directly.
 */

import type { ObsEvent, ObsSeverity } from "./types";

/**
 * Failures that mean money or access is already broken for real people, at any
 * rate above zero.
 *
 * The bar for this list is deliberately high — a critical that fires on
 * something recoverable teaches everyone to scroll past criticals. Each entry
 * below is here because a single occurrence is already a customer with a
 * problem no retry will fix:
 *
 *   * `payment.settle` — Razorpay took the money and we failed to record it.
 *     The order reads unpaid while the customer's statement says otherwise, and
 *     nothing in the app will reconcile that on its own.
 *   * `payment.webhook` — the authority on whether an order is paid. A failure
 *     here is the same money, one step earlier.
 *   * `auth.otp` — the only way a customer signs in. A failure is a locked
 *     door, not a degraded experience.
 */
const CRITICAL_DOMAIN_EVENTS = new Set([
  "payment.settle",
  "payment.webhook",
  "auth.otp",
]);

/**
 * Failures that break an order's journey but leave the money and the account
 * intact. Serious, actionable, and not worth waking anyone for one instance.
 */
const HIGH_DOMAIN_EVENTS = new Set([
  "order.created",
  "payment.initiate",
  "payment.refund",
  "dispatch.assign",
  /**
   * The rate limiter falling back to its in-memory store. Not an error anyone
   * sees — which is exactly why it is on this list. Every serverless instance
   * then keeps its own counter, so the OTP cap silently multiplies by the
   * number of instances and the protection quietly stops being a protection.
   * `lib/rate-limit.ts` logs this once per process and then goes quiet forever.
   */
  "ratelimit.degraded",
]);

/**
 * Which provider outages matter most.
 *
 * Razorpay and Renflair gate money and sign-in. OneSignal is a notification: a
 * customer who is not told their order moved can still open the app and see it,
 * so it is medium however loudly it fails.
 */
const CRITICAL_PROVIDERS = new Set(["razorpay", "renflair"]);

export function classifySeverity(event: ObsEvent): ObsSeverity {
  const { kind, level, source } = event;

  // A fatal is a fatal. Nothing below should be able to talk it down.
  if (level === "fatal") return "critical";

  if (kind === "domain") {
    if (level === "error") {
      if (CRITICAL_DOMAIN_EVENTS.has(source)) return "critical";
      if (HIGH_DOMAIN_EVENTS.has(source)) return "high";
      return "medium";
    }
    // `schema.degraded` arrives as a warning and stays low. It is a feature
    // quietly serving less than it should, which needs to be visible and does
    // not need to be urgent — see `lib/data-access/schema-probe.ts`.
    return level === "warn" ? "low" : "info";
  }

  if (kind === "provider") {
    // `fatal` was already answered above, so `error` is the whole failure case.
    if (level === "error") {
      return event.provider && CRITICAL_PROVIDERS.has(event.provider)
        ? "high"
        : "medium";
    }
    return "low";
  }

  if (kind === "http" || kind === "error") {
    const status = event.httpStatus ?? 0;

    // 5xx is ours. 4xx is the caller's and is not an issue at all — a customer
    // sending an invalid body, or a rate limit doing its job, is the system
    // working. Recording those as errors would bury the real ones under
    // thousands of rows that need no action.
    if (status >= 500) return "high";
    if (status >= 400) return "low";

    // A throw with no HTTP status: a Server Component, a Server Action, a
    // background write. It reached `onRequestError`, so it was not handled.
    return level === "error" ? "high" : "medium";
  }

  // Browser errors. Real and worth grouping — a checkout that white-screens is
  // a lost order — but they cannot be triaged from the server, their stacks are
  // minified (no Sentry, per the decision log), and one broken extension can
  // produce hundreds. Low, and found by looking rather than by being told.
  if (kind === "client") return "low";

  if (kind === "db") return level === "error" ? "high" : "low";

  return level === "error" ? "medium" : "info";
}

export const SEVERITY_LABEL: Record<ObsSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};
