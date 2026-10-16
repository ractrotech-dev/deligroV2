/**
 * Correlation ids, and the environment stamp every event carries.
 *
 * ## Two ids, because they answer two questions
 *
 *   * **`requestId`** — one HTTP request. Answers "what else happened while
 *     this call was being served".
 *   * **`traceId`** — one logical operation, which on this platform spans
 *     several requests and one inbound webhook: checkout → create Razorpay
 *     order → Razorpay redirect → webhook → settle → dispatch → push. Answers
 *     "show me this order's whole journey through the system".
 *
 * A single id cannot do both. Collapsing them would either break the trace at
 * every hop or make "this request" unqueryable.
 *
 * ## Where the trace survives the webhook
 *
 * Razorpay will not carry our header. The webhook leg rejoins its trace through
 * `payments.provider_order_id`, which the app already stores when it creates
 * the payment — so the join is a real column, not a guess. See
 * `docs/OBSERVABILITY_PLAN.md` §5.
 *
 * Runtime-agnostic on purpose: `proxy.ts` mints ids in the Edge runtime and the
 * route handlers read them in Node, so nothing here may import `node:crypto`.
 * `globalThis.crypto.getRandomValues` exists in both.
 */

import type { ObsEnv } from "./types";

/**
 * Crockford-ish base32 — no I, L, O or U, so an id read aloud from a phone
 * during an incident cannot be mistyped into a different id, and none of the
 * three-letter words that alphabet would otherwise produce appear.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 20 random characters ≈ 100 bits. Collision is not a thing we need to think about. */
function randomToken(length = 20): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % 32];
  return out;
}

export function newRequestId(): string {
  return `req_${randomToken()}`;
}

export function newTraceId(): string {
  return `trace_${randomToken()}`;
}

/**
 * Narrow an id that arrived from outside — a client header, a search box, a
 * pasted string in the console.
 *
 * Anything that is not our own shape is refused rather than passed through.
 * These ids are used in `LIKE`-free equality lookups, so this is not about
 * injection; it is about not letting a caller choose the correlation key. A
 * client that can set `x-trace-id: trace_A` for every request can bolt all of
 * its traffic onto one trace, and the "trace this order" view becomes useless
 * for everyone.
 */
export function parseCorrelationId(
  raw: string | null | undefined,
  prefix: "req" | "trace" | "span"
): string | null {
  if (!raw) return null;
  const value = raw.trim();
  const pattern = new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{12,24}$`);
  return pattern.test(value) ? value : null;
}

/**
 * Which deployment this is.
 *
 * `VERCEL_ENV` is the authority when present because it distinguishes a preview
 * deploy from production, which `NODE_ENV` cannot — both are `production` to
 * Node, and merging a preview branch's errors into the production issue list
 * would be the same category of mistake as seeding fake data.
 *
 * Defaults to `development`, not `production`: an unknown environment
 * mislabelled as production would put untrusted telemetry in front of an
 * operator as though it were real, and the console's default filter is
 * production. Guessing low keeps that filter honest.
 */
export function currentEnv(): ObsEnv {
  const vercel = process.env.VERCEL_ENV;
  if (vercel === "production") return "production";
  if (vercel === "preview") return "preview";
  if (vercel === "development") return "development";
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

/**
 * The release this code belongs to, for deploy correlation.
 *
 * Short SHA rather than the full 40 characters: it appears in a table column,
 * on a chart marker and in an issue header, and seven characters is what a
 * human actually matches against `git log`.
 *
 * Null when the platform did not supply one — a local `next dev`, or a
 * self-hosted build. Null is honest; a placeholder like "unknown" would become
 * a release in its own right on the deploy timeline.
 */
export function currentRelease(): string | null {
  const sha =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
    "";
  return sha ? sha.slice(0, 7) : null;
}

/**
 * Collapse a concrete path into the templated route the metrics are keyed on.
 *
 * `/api/orders/9f3c…/status` → `/api/orders/[id]/status`.
 *
 * Used only where Next has not already handed us `routePath` (it does inside
 * `onRequestError`). Without this, every order would get its own row in the
 * endpoint table and per-endpoint latency would be uncomputable — and the
 * concrete id would end up in an index, which is what `http_route` exists to
 * avoid.
 */
const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function templateRoute(pathname: string): string {
  return (
    "/" +
    pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        if (UUID_SEGMENT.test(segment)) return "[id]";
        // A long digit run or a hex blob is an id too — legacy order keys and
        // Razorpay's own ids both take this shape.
        if (/^\d{4,}$/.test(segment)) return "[id]";
        if (/^[0-9a-f]{16,}$/i.test(segment)) return "[id]";
        return segment;
      })
      .join("/")
  );
}
