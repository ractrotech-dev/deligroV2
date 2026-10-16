/**
 * The one place telemetry is stripped of things it must never carry.
 *
 * ## Why this runs at write, not at display
 *
 * A redaction applied when the console renders a row is a redaction that has
 * already failed: the secret is in the database, in its indexes, in every
 * backup, and in the next PostgREST query anyone writes. `emit()` calls this
 * BEFORE it builds the row, so there is no code path — no "internal" helper, no
 * future debug flag — that reaches `obs_events` unredacted. Same shape as the
 * project's other security rules: enforce at the boundary that cannot be
 * bypassed, not at the surface that happens to be looking.
 *
 * ## Why `attrs` is an allowlist
 *
 * A deny-list is a promise to remember every sensitive field anyone will ever
 * add. It fails on the first one nobody thought of — which, in this codebase,
 * would be something like `vendorLoginPassword` (migration 0039 stores exactly
 * that, on purpose, in a table with no policies). Only named keys survive here,
 * so a new field is invisible to telemetry until someone decides otherwise.
 * That is the same default the `restaurants` column grant uses: a new column is
 * invisible until granted on purpose.
 *
 * ## What is not captured at all
 *
 * Request bodies, response bodies and IP addresses have no field on `ObsEvent`
 * and no branch here. They are not truncated or hashed — they are not
 * collected. Everything the investigation actually needs (method, templated
 * route, status, latency, actor role, order id) is present without them.
 *
 * Pure and free of `server-only` on purpose, so `scripts/qa/obs-telemetry.ts`
 * can assert against it directly. A redaction rule that is only claimed in a
 * comment is exactly the stale security doc AGENTS.md warns about.
 */

/** Replaces anything removed, so a redacted field reads as redacted. */
const MASK = "[REDACTED]";

/**
 * Key names that are never stored, whatever the allowlist says and however
 * they are nested.
 *
 * The key is normalised first — lowercased, then stripped of every separator —
 * so `apiKey`, `API_KEY`, `x-api-key` and `api.key` all collapse to `apikey`
 * and hit the same rule. Matching the raw string missed `x-api-key`, which is
 * exactly the shape a header-derived field arrives in; enumerating spellings
 * would have meant losing that race again on the next one.
 */
const DENIED_SUBSTRINGS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "session",
  "credential",
  "otp",
  "pepper",
  "signature",
  "cardnumber",
  "creditcard",
  "cvv",
  "cvc",
  "accountnumber",
  "aadhaar",
  "aadhar",
  "privatekey",
  "ifsc",
] as const;

/**
 * Short names that are only denied when they are the WHOLE key.
 *
 * `pan` and `auth` as substrings would deny `panel`, `expand`, `company` and
 * `author`. Over-denial fails closed and leaks nothing, but it also silently
 * eats fields an operator needs mid-incident and leaves no sign it did — so
 * the short, ambiguous names are matched exactly and the long, unambiguous
 * ones above are matched anywhere.
 */
const DENIED_EXACT = new Set([
  "auth",
  "key",
  "card",
  "pan",
  "upi",
  "vpa",
  "iban",
  "sig",
  "salt",
  "hash",
]);

/**
 * Value shapes scrubbed out of free text — messages and stack traces, where a
 * secret arrives interpolated into a sentence rather than under a key.
 *
 * Order matters: the longer, more specific patterns run first so a JWT is not
 * half-eaten by the generic long-token rule.
 */
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  // JWTs — Supabase access tokens and anything else three-part base64url.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[JWT]"],
  // Bearer / Basic credentials as they appear in a copied header line.
  [/\b(Bearer|Basic)\s+[A-Z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  // Razorpay and Stripe-style prefixed keys. `rzp_test_` and `rzp_live_` are
  // the ones this platform actually holds.
  [/\b(rzp|sk|pk|whsec|sbp)_[A-Z0-9_-]{8,}\b/gi, "[KEY]"],
  // Supabase service-role / publishable keys in their newer prefixed form.
  [/\bsb_(secret|publishable)_[A-Z0-9_-]{8,}\b/gi, "[KEY]"],
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]"],
  // Indian mobile numbers in every form this app stores or receives them:
  // +919876543210, 919876543210, 09876543210, 9876543210.
  [/(?:\+?91[\s-]?)?[6-9]\d{9}\b/g, "[PHONE]"],
];

/**
 * A digit run long enough to be a payment card, validated with Luhn before it
 * is masked.
 *
 * The Luhn check is the point: order totals, timestamps in milliseconds and
 * Razorpay's own numeric ids are all long digit runs, and masking them would
 * gut the diagnostic value of every payment message to guard against a number
 * that is not a card. Luhn is cheap and turns "13-19 digits" into "13-19 digits
 * that could actually be a card".
 */
const DIGIT_RUN = /\b\d[\d\s-]{11,21}\d\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = (digits.codePointAt(i) ?? 0) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function maskCardNumbers(text: string): string {
  return text.replace(DIGIT_RUN, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    return luhnValid(digits) ? "[CARD]" : match;
  });
}

/** True when a key name must never be stored, at any depth. */
export function isDeniedKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (DENIED_EXACT.has(k)) return true;
  return DENIED_SUBSTRINGS.some((p) => k.includes(p));
}

/**
 * Scrub free text. Applied to `message` and `stack`, which is where a secret
 * arrives already interpolated and no key name exists to catch it.
 */
export function redactText(value: string): string {
  let out = maskCardNumbers(value);
  for (const [pattern, replacement] of VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Keys permitted in `attrs`. Everything else is dropped silently — dropped, not
 * masked, because a row full of `[REDACTED]` placeholders for fields nobody
 * meant to send is noise that makes the useful keys harder to find.
 *
 * Add to this list deliberately, and only with a value that is safe in a table
 * an operator will screenshot into a chat.
 */
const ALLOWED_ATTR_KEYS = new Set<string>([
  // request shape
  "method",
  "route",
  "status",
  "statusText",
  "durationMs",
  "retryCount",
  "attempt",
  "cached",
  "sampled",
  // outcome codes — our own vocabulary, never a provider's raw payload
  "reason",
  "code",
  "errorCode",
  "outcome",
  "refusal",
  "degraded",
  "column",
  "backend",
  // domain context, all ids or enum values
  "orderStatus",
  "paymentStatus",
  "paymentMethod",
  "provider",
  "providerOrderId",
  "providerPaymentId",
  "event",
  "riderCount",
  "offerAgeMs",
  "fixAgeMs",
  "distanceKm",
  "queueDepth",
  "itemCount",
  // client context
  "platform",
  "browser",
  "os",
  "appVersion",
  "viewport",
  "connection",
  "digest",
  "componentStack",
  // rate limiting
  "limit",
  "remaining",
  "retryAfter",
]);

/** How deep to walk before giving up. Guards against a cyclic or absurd object. */
const MAX_DEPTH = 3;
/** Longest string kept in `attrs`. Long text belongs in `message`. */
const MAX_ATTR_STRING = 300;

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    return redactText(value).slice(0, MAX_ATTR_STRING);
  }
  if (typeof value === "number") {
    // NaN and Infinity are not valid JSON and would fail the insert.
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[array(${value.length})]`;
    return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  }

  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "[object]";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // The deny-list applies at every depth, not just the top level.
      if (isDeniedKey(k)) {
        out[k] = MASK;
        continue;
      }
      out[k] = redactValue(v, depth + 1);
    }
    return out;
  }

  // Functions, symbols, bigints — nothing a telemetry row should carry.
  return null;
}

/**
 * Filter and scrub an attribute bag.
 *
 * A denied key that also appears in the allowlist is still denied: the
 * deny-list is checked first, deliberately, so adding a name like `authToken`
 * to `ALLOWED_ATTR_KEYS` by mistake cannot open a hole.
 */
export function redactAttrs(
  attrs: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!attrs) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (isDeniedKey(key)) continue;
    if (!ALLOWED_ATTR_KEYS.has(key)) continue;
    const clean = redactValue(value, 0);
    if (clean !== null) out[key] = clean;
  }
  return out;
}

/**
 * Headers worth keeping. An allowlist of four, none of which can carry a
 * credential.
 *
 * `cookie`, `authorization` and `x-razorpay-signature` are absent on purpose
 * and must stay absent: the signature header in particular is the whole
 * authentication of the payment webhook (see the route's own comment — "the
 * signature IS the authentication"), so logging it would put a replayable
 * credential in a table an operator browses.
 */
const ALLOWED_HEADERS = new Set([
  "user-agent",
  "content-type",
  "x-request-id",
  "x-vercel-id",
]);

export function redactHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (!ALLOWED_HEADERS.has(k)) continue;
    const flat = Array.isArray(value) ? value.join(", ") : value;
    if (flat) out[k] = redactText(flat).slice(0, MAX_ATTR_STRING);
  }
  return out;
}

/**
 * A URL reduced to the part that is safe to store.
 *
 * The path is kept, the query string is not: `?phone=`, `?next=` and
 * `?email=` all appear in this app's own URLs, and a search param is the
 * easiest accidental route from a form field into a log line. Which parameters
 * were present is often worth knowing, so the NAMES survive and the values do
 * not.
 */
export function redactUrl(raw: string): string {
  try {
    // The base only resolves a relative path; nothing is fetched from it.
    const url = new URL(raw, "https://local");
    const keys = [...url.searchParams.keys()];
    if (!keys.length) return url.pathname;
    // Code-unit order, not `localeCompare`: the result is grouped and compared
    // as a key, so it must not shift with the runtime's ICU locale data.
    keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `${url.pathname}?${keys.join(",")}=…`;
  } catch {
    return redactText(raw.split("?")[0] ?? "").slice(0, MAX_ATTR_STRING);
  }
}
