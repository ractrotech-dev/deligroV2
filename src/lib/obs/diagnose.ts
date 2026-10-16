import type { ObsSeverity } from "./types";

/**
 * "Possible root cause" and "what should I do", without inventing either.
 *
 * ## The rule this file exists to obey
 *
 * An observability tool that writes a confident narrative is wrong often
 * enough to be overruled once — and after that nobody reads it again, including
 * on the day it happens to be right. So nothing here composes a story. It
 * checks a fixed set of relations, reports each as a labelled claim with the
 * evidence that supports it, and says **Unknown** when nothing matches.
 *
 * Four confidence levels, and the distinction between them is not decorative:
 *
 *   * **Confirmed** — the evidence *is* the cause. Only used where the failure
 *     names its own reason: a missing migration, a rejected signature.
 *   * **Likely** — a strong, specific correlation with a known mechanism.
 *   * **Possible** — a correlation with a plausible mechanism and alternatives.
 *   * **Unknown** — nothing matched. Shown as a checklist, not as a shrug.
 *
 * ## Why it is a lookup and not a model
 *
 * The failures this platform has are enumerable — there are about fifteen of
 * them, listed in `docs/OBSERVABILITY_PLAN.md` §4 — and each has a known first
 * move. A table of those is more useful than a generated paragraph, is
 * reviewable in a diff, and cannot hallucinate a subsystem that does not exist.
 * Where the table has nothing, it says so.
 *
 * Pure and free of `server-only`, so the QA suite can assert the table.
 */

export type Confidence = "confirmed" | "likely" | "possible" | "unknown";

export interface Diagnosis {
  confidence: Confidence;
  /** One sentence. What is believed to have happened. */
  statement: string;
  /** Facts that support it. Each is something the operator can go and check. */
  evidence: string[];
  /** Ordered first moves. Concrete, and specific to this platform. */
  nextSteps: string[];
  /** Who is at fault, when that is knowable. Drives the "us or them" line. */
  attribution?: "deligro" | "provider" | "configuration" | "unknown";
}

export interface DiagnoseInput {
  kind: string;
  source: string;
  errorType: string | null;
  message: string;
  provider: string | null;
  httpRoute: string | null;
  httpStatus: number | null;
  severity: ObsSeverity;
  /** A release landed shortly before this issue was first seen. */
  deployMinutesBefore: number | null;
  /** The provider's failure rate over the same window, when one is known. */
  providerErrorRate: number | null;
}

/** Which PostgREST code, if any, gave the missing migration away. */
function schemaEvidence(errorType: string | null): string {
  if (errorType === "pg_42P01") return "PostgREST returned 42P01 (undefined table)";
  if (errorType === "pg_42703") return "PostgREST returned 42703 (undefined column)";
  return "The failure names a missing migration";
}

/**
 * A missing migration names itself. PostgREST answers 42P01 for a missing table
 * and 42703 for a missing column, and this codebase already turns the second
 * into deliberate degradation (`schema-probe.ts`) — so when one reaches an
 * issue, the diagnosis is not a guess.
 */
function schemaDiagnosis(input: DiagnoseInput): Diagnosis | null {
  const isSchema =
    input.errorType === "pg_42P01" ||
    input.errorType === "pg_42703" ||
    input.source === "schema.degraded" ||
    /not migrated|does not exist|migration/i.test(input.message);

  if (!isSchema) return null;

  return {
    confidence: "confirmed",
    attribution: "configuration",
    statement:
      "A table or column this code reads does not exist on this database — a migration has not been applied.",
    evidence: [
      schemaEvidence(input.errorType),
      "This is a deployment state, not a code fault — the same build works against a migrated database",
    ],
    nextSteps: [
      "Compare supabase/migrations against what has been applied to this project",
      "Apply the missing migration in the Supabase SQL editor, or `supabase db push`",
      "Check whether the column needs a GRANT as well as an ALTER — migration 0032/0034/0044 re-run an explicit column allowlist, and a column added without re-running it is invisible to anon and authenticated",
      "Re-check this issue afterwards: it should stop recurring, and will show as regressed if it does not",
    ],
  };
}

/** An RLS refusal is the database enforcing something. Usually correct. */
function rlsDiagnosis(input: DiagnoseInput): Diagnosis | null {
  if (input.errorType !== "pg_42501" && !/row-level security/i.test(input.message)) {
    return null;
  }
  return {
    confidence: "confirmed",
    attribution: "deligro",
    statement:
      "Row-level security refused the write. The policy and the caller's role disagree about who may do this.",
    evidence: [
      "PostgREST returned 42501 (insufficient privilege)",
      "RLS refusals are the database working — the question is whether the policy or the caller is wrong",
    ],
    nextSteps: [
      "Identify the caller's role from the event's `actor_role`",
      "Find the policy for that table and check whether the role belongs on it — migration 0040 had to add `admin` to the customer-insert policy for exactly this reason",
      "If the policy is right, the fix is in the app: the wrong client or the wrong account is being used",
      "Do NOT widen the policy to make the error stop without establishing which side is wrong",
    ],
  };
}

/** Provider failures: the "is it them or is it us" answer. */
function providerDiagnosis(input: DiagnoseInput): Diagnosis | null {
  if (input.kind !== "provider" || !input.provider) return null;

  const rate = input.providerErrorRate;
  const theirs = rate !== null && rate >= 20;

  const commonSteps: Record<string, string[]> = {
    razorpay: [
      "Check Razorpay's own status page and dashboard before changing anything here",
      "Confirm RAZORPAY_KEY_ID / KEY_SECRET have not been rotated on one side only",
      "Check the Payments tab: a high failure rate with a normal success rate on settled orders means the failures are being retried successfully",
      "If webhook signature failures are also present, RAZORPAY_WEBHOOK_SECRET is the likelier cause than an outage",
    ],
    onesignal: [
      "Confirm ONESIGNAL_REST_API_KEY is present and has not been rotated",
      "A high rate of failures with no timeouts usually means a rejected payload, not an outage",
      "Customers can still see order state in the app — this degrades notification, not ordering",
    ],
    renflair: [
      "This blocks sign-in entirely: check first whether RENFLAIR_API_KEY is set and the account has credit",
      "Renflair returns a JSON body with a reason — it is on the event as `detail`",
      "Confirm the phone numbers being sent are 10-digit local form (`toLocal10`), not E.164",
    ],
    supabase: [
      "Check the Supabase project dashboard for an incident or a paused project",
      "Check connection limits — the app opens a client per request",
    ],
    maps: [
      "Check the Google Cloud console for quota and for the HTTP-referrer restriction on the browser key",
    ],
  };

  return {
    confidence: theirs ? "likely" : "possible",
    attribution: theirs ? "provider" : "unknown",
    statement: theirs
      ? `${input.provider} is failing a large share of calls — this looks like their outage rather than our bug.`
      : `Calls to ${input.provider} are failing intermittently. That can be their side, our payload, or our credentials.`,
    evidence: [
      rate !== null
        ? `${rate.toFixed(1)}% of calls to ${input.provider} failed in the last hour`
        : "No rate available for this window",
      theirs
        ? "A failure rate this high is rarely caused by one malformed request"
        : "A partial failure rate usually means specific requests, not the service",
    ],
    nextSteps: commonSteps[input.provider] ?? [
      `Check ${input.provider}'s status and this deployment's credentials for it`,
    ],
  };
}

/** Payment settlement — the worst failure the platform has. */
function settlementDiagnosis(input: DiagnoseInput): Diagnosis | null {
  if (input.source !== "payment.settle" && input.source !== "payment.webhook") {
    return null;
  }
  if (/signature/i.test(input.message)) {
    return {
      confidence: "likely",
      attribution: "configuration",
      statement:
        "Razorpay webhook deliveries are failing signature verification. Either the shared secret no longer matches, or something is posting forged events.",
      evidence: [
        "The signature check runs over the raw request body before any JSON parse, so a mismatch is not a serialisation artefact",
        "If this began at a deploy or a key rotation, a stale RAZORPAY_WEBHOOK_SECRET is far likelier than forgery",
        "Every rejected delivery means an order that will NOT be marked paid — the customer has been charged",
      ],
      nextSteps: [
        "Compare RAZORPAY_WEBHOOK_SECRET in this environment against the value in the Razorpay dashboard → Webhooks",
        "Check the Payments tab for orders paid at the provider but unpaid here — those are the affected customers",
        "If the secret matches, treat the source as untrusted and check where the deliveries are coming from",
        "Razorpay retries: once the secret is fixed, previously rejected deliveries should settle themselves",
      ],
    };
  }
  return {
    confidence: "likely",
    attribution: "deligro",
    statement:
      "Razorpay took the payment and this platform failed to record it against the order. The customer has been charged and their order reads unpaid.",
    evidence: [
      "The failure is on our write path, after a signature-verified delivery",
      "Razorpay will retry, so some of these may settle on their own — but not the ones that exhausted their retries",
    ],
    nextSteps: [
      "Open the Payments tab and read the 'paid at provider, unpaid here' figure — that is the list of affected customers",
      "Check whether the payments migration (0025) is applied on this database",
      "Reconcile each affected order manually before Razorpay's retry window closes",
      "This is the failure that most needs an incident opening — it involves real money and a customer who already knows",
    ],
  };
}

/** Dispatch failures show up as orders that sit. */
function dispatchDiagnosis(input: DiagnoseInput): Diagnosis | null {
  if (input.source !== "dispatch.assign") return null;
  return {
    confidence: "possible",
    attribution: "unknown",
    statement:
      "Rider assignment is failing. Orders will sit at 'ready' with food going cold and no rider on the way.",
    evidence: [
      "Dispatch is best-effort by design and swallows its own failures, so this is the only signal it produces",
      "A rider with no recent position fix is treated as having no position — a fleet that has not granted location looks like an empty fleet",
    ],
    nextSteps: [
      "Check the Delivery tab for unassigned deliveries and riders online",
      "If riders are online but nothing is assigned, check whether their devices are reporting location (`deliveries.driver_lat/lng`)",
      "If nobody is online, this is an operations problem, not a software one",
      "Check the Orders tab for orders stuck at 'ready' — that is the customer-visible half of this",
    ],
  };
}

/** The security control that fails quietly. */
function rateLimitDiagnosis(input: DiagnoseInput): Diagnosis | null {
  if (input.source !== "ratelimit.degraded") return null;
  return {
    confidence: "confirmed",
    attribution: "configuration",
    statement:
      "The rate limiter lost its shared store and every serverless instance is now counting on its own. Caps are effectively multiplied by the number of running instances.",
    evidence: [
      "The Postgres `check_rate_limit` RPC did not answer, so the limiter fell back to per-instance memory",
      "This is a security degradation, not a performance one: the OTP cap in particular is no longer what it says it is",
      "It is loudest exactly when it matters least visible — more traffic means more instances means a higher effective ceiling",
    ],
    nextSteps: [
      "Check that migration 0027_rate_limits.sql is applied and `check_rate_limit` is executable by service_role",
      "Check whether the database is reachable at all — this is often the first symptom of a wider outage",
      "Until it is fixed, treat OTP and write-endpoint limits as unenforced",
    ],
  };
}

/** Deploy adjacency — reported as adjacency, never as cause. */
function deployNote(input: DiagnoseInput): string | null {
  if (input.deployMinutesBefore === null) return null;
  return `A release was deployed ${input.deployMinutesBefore} minute${input.deployMinutesBefore === 1 ? "" : "s"} before this issue was first seen. That is adjacency, not attribution — most deploys are innocent, and the way to tell is whether the changed code touches this path.`;
}

/**
 * The whole diagnosis for one issue.
 *
 * Rules are tried in order of specificity and the first match wins. Where none
 * matches, the fallback is honest — Unknown, with a checklist scoped to the
 * kind of failure rather than a generic one.
 */
export function diagnose(input: DiagnoseInput): Diagnosis {
  const rules = [
    schemaDiagnosis,
    rlsDiagnosis,
    settlementDiagnosis,
    rateLimitDiagnosis,
    dispatchDiagnosis,
    providerDiagnosis,
  ];

  let result: Diagnosis | null = null;
  for (const rule of rules) {
    result = rule(input);
    if (result) break;
  }

  result ??= {
    confidence: "unknown",
    attribution: "unknown",
    statement:
      "Nothing in the evidence matches a known failure mode. This needs reading rather than triaging.",
    evidence: [],
    nextSteps: [
      "Read the stack trace below and open the first frame inside src/",
      "Open one of the traces linked in the timeline to see what the request was doing on either side of the failure",
      input.httpRoute
        ? `Check the API tab for ${input.httpRoute} — a rise in latency alongside the errors points at a dependency rather than at the handler`
        : "Check the API tab for a matching rise in latency or error rate",
      "Check whether the same fingerprint appears in preview or development — one that does is reproducible without touching production",
    ],
  };

  const note = deployNote(input);
  if (note) {
    // Appended as evidence rather than folded into the statement, so it is
    // always read as a separate fact the operator can weigh.
    return { ...result, evidence: [...result.evidence, note] };
  }
  return result;
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  confirmed: "Confirmed",
  likely: "Likely",
  possible: "Possible",
  unknown: "Unknown",
};
