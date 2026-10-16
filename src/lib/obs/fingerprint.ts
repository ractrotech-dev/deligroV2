/**
 * Turning a thousand identical failures into one issue.
 *
 * The whole value of this is in `normaliseMessage`. "Order 9f3c… not found" and
 * "Order 71ab… not found" are the same bug reported twice; a log viewer shows
 * them as two lines and an issue tracker must show them as one row with a count
 * of two. Everything else here is plumbing around that idea.
 *
 * Pure, sync, and free of `server-only` and of any `node:` import, for three
 * reasons: `scripts/qa/obs-telemetry.ts` asserts against it directly;
 * `instrumentation.ts` may run in the Edge runtime, where `node:crypto` is not
 * available; and a fingerprint that could differ between two runtimes would
 * split one issue in half, which is precisely the failure this file exists to
 * prevent.
 */

/**
 * A 64-bit hash built from two independent 32-bit FNV-1a passes.
 *
 * Not a cryptographic hash and does not need to be: nothing here is a secret,
 * and the only property required is that the same input always produces the
 * same 16 hex characters. Over 64 bits, a platform carrying even ten thousand
 * distinct issues has a collision probability around 3 in 10^12 — far below the
 * rate at which `normaliseMessage` will merge two genuinely different bugs,
 * which is the real accuracy limit here.
 *
 * Two 32-bit passes rather than one 64-bit BigInt pass, and `Math.imul` rather
 * than `*`: this project targets ES2017 (tsconfig), where BigInt literals are
 * unavailable, and `Math.imul` is the only way to get a wrapping 32-bit
 * multiply out of a JS number. The second pass walks the string backwards from
 * a different basis, so the two halves respond differently to the same input.
 *
 * Also why this is not `node:crypto` — `instrumentation.ts` may run in the Edge
 * runtime, and a fingerprint that differed between runtimes would split one
 * issue in two, which is exactly the failure this file exists to prevent.
 */
/**
 * The UTF-16 code unit at `i` — exactly what `charCodeAt` returns. The hash is
 * defined over code units, so an astral character's code point is split back
 * into its high surrogate; a low surrogate or lone surrogate is already a unit.
 * Changing this would change every stored fingerprint with an emoji in it.
 */
function codeUnitAt(input: string, i: number): number {
  const cp = input.codePointAt(i) ?? 0;
  return cp > 0xffff ? 0xd800 + ((cp - 0x10000) >> 10) : cp;
}

function fnv1a32(input: string, basis: number, reverse: boolean): number {
  const PRIME = 0x01000193;
  let hash = basis;
  const n = input.length;

  for (let i = 0; i < n; i++) {
    const code = codeUnitAt(input, reverse ? n - 1 - i : i);
    // Fold both bytes of the code unit in, so two strings differing only above
    // U+00FF cannot collide.
    hash = Math.imul(hash ^ (code & 0xff), PRIME);
    hash = Math.imul(hash ^ (code >>> 8), PRIME);
  }
  return hash >>> 0;
}

function hash64(input: string): string {
  const lo = fnv1a32(input, 0x811c9dc5, false);
  const hi = fnv1a32(input, 0x0c9dc5f3, true);
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/**
 * Strip the parts of a message that vary per occurrence.
 *
 * Each replacement is a typed placeholder rather than an empty string, so the
 * grouped title still reads as a sentence: "Order <uuid> not found" is
 * comprehensible in a list; "Order  not found" is not.
 *
 * Order matters — UUIDs before hex, hex before plain numbers — or a UUID gets
 * dismantled into fragments by the narrower rules first.
 */
export function normaliseMessage(message: string): string {
  return (
    message
      .toLowerCase()
      // UUIDs — order ids, profile ids, restaurant ids.
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
        "<uuid>"
      )
      // The console's own short order handle (shortOrderId: 8 uppercase hex).
      .replace(/\b[0-9a-f]{8}\b/g, "<hex>")
      // Longer hex or base-ish blobs: Razorpay ids, digests, request ids.
      .replace(/\b[0-9a-z]{16,}\b/g, "<id>")
      // ISO timestamps.
      .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/g, "<time>")
      // Anything the redactor already replaced keeps its placeholder, but the
      // brackets vary in case; normalise them so they group.
      .replace(/\[(redacted|email|phone|card|jwt|key)\]/g, "<$1>")
      // Quoted fragments — column names, values, provider strings.
      .replace(/'[^']*'/g, "'<v>'")
      .replace(/"[^"]*"/g, '"<v>"')
      // Bare numbers last, so nothing above is eaten before it is recognised.
      .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300)
  );
}

/**
 * The first stack frame inside our own source — what to open first.
 *
 * Frames from `node_modules`, `node:` internals and the Next.js runtime are
 * skipped: "the error happened inside @supabase/supabase-js" is true of a great
 * many different bugs and groups none of them usefully. If no frame is ours,
 * the first frame of any kind is returned rather than nothing, because a throw
 * entirely inside a dependency is still worth locating.
 */
export function culpritFrame(stack: string | null | undefined): string | null {
  if (!stack) return null;

  const lines = stack.split("\n").slice(1);
  let firstAny: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;

    // `at fn (/path/file.ts:12:5)` or `at /path/file.ts:12:5`
    const match = line.match(/(?:^|[\s()])([^\s()]+\.(?:ts|tsx|js|jsx|mjs|cjs):\d+:\d+)\)?$/);
    if (!match) continue;
    const location = match[1];

    firstAny ??= shortenFrame(location);

    if (
      location.includes("node_modules") ||
      location.startsWith("node:") ||
      location.includes("/.next/") ||
      location.includes("/next/dist/")
    ) {
      continue;
    }
    return shortenFrame(location);
  }
  return firstAny;
}

/** `/var/task/src/lib/data-access/payments.ts:88:11` → `lib/data-access/payments.ts:88`. */
function shortenFrame(location: string): string {
  const withoutColumn = location.replace(/:(\d+):\d+$/, ":$1");
  const srcIndex = withoutColumn.lastIndexOf("/src/");
  const trimmed =
    srcIndex >= 0 ? withoutColumn.slice(srcIndex + 5) : withoutColumn;
  return trimmed.slice(-160);
}

export interface FingerprintInput {
  env: string;
  kind: string;
  errorType?: string | null;
  message: string;
  /** Route or stack frame. Falls back to `source` when neither is known. */
  culprit?: string | null;
  /* HTTP failures with no exception group on shape rather than on text. */
  httpMethod?: string | null;
  httpRoute?: string | null;
  httpStatus?: number | null;
}

/**
 * The grouping key.
 *
 * `env` is part of it deliberately: a bug reproducing in development is not the
 * same row as the same bug in production. They have different urgencies,
 * different audiences and different retention, and merging them would let a
 * developer's deliberate test failures inflate a production issue's count —
 * exactly the "no fake data" line the plan draws.
 *
 * An HTTP failure with no exception is fingerprinted on method + route + status
 * instead of on message text, because its message ("Internal Server Error") is
 * identical across every unrelated 500 in the app.
 */
export function fingerprint(input: FingerprintInput): string {
  const parts =
    input.kind === "http" && !input.errorType
      ? [
          input.env,
          "http",
          input.httpMethod ?? "",
          input.httpRoute ?? "",
          String(input.httpStatus ?? ""),
        ]
      : [
          input.env,
          input.kind,
          input.errorType ?? "",
          normaliseMessage(input.message),
          input.culprit ?? "",
        ];

  return hash64(parts.join(" "));
}

/**
 * The one-line title an issue is listed under.
 *
 * The raw message, not the normalised one: normalisation exists to make two
 * occurrences group, and its placeholders (`<uuid>`, `<n>`) read as noise in a
 * list. The title comes from whichever occurrence was seen last, so it stays a
 * real sentence — the count beside it already says it happened more than once.
 */
export function issueTitle(
  errorType: string | null | undefined,
  message: string
): string {
  const text = message.trim().split("\n")[0] ?? message;
  const title = errorType ? `${errorType}: ${text}` : text;
  return title.slice(0, 300);
}
