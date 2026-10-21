/**
 * The customer's delivery instructions — a free-text note for the rider
 * ("ring twice, dog in the yard"), kept apart from the address.
 *
 * Pure and import-free on purpose (like `validate-lines.ts`) so the checkout
 * route, the phone-order path and `scripts/qa/order-instructions.ts` all apply
 * the one rule. The 300 here is `orders.delivery_instructions`' check
 * constraint (migration 0082); the database is the last line, this is the one
 * that answers with a reason.
 */

export const MAX_INSTRUCTIONS_LENGTH = 300;

export type InstructionsResult =
  | { ok: true; value: string | null }
  | { ok: false; error: "instructions_too_long" | "invalid_instructions" };

/** C0 controls (not tab/newline, which are folded below) and DEL. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * Trim, and decide. Blank (or absent) is `null` — no instructions, nothing
 * written. Over 300 characters is refused rather than cut: a truncated "the
 * gate code is 4821 and the…" is worse than being asked to shorten it.
 *
 * Counts characters the way Postgres's `char_length` does (code points), not
 * UTF-16 units, so a Hindi note or an emoji is not charged double. Control
 * characters become spaces — they have no business in a line a rider reads —
 * but newlines are kept.
 */
export function normalizeInstructions(raw: unknown): InstructionsResult {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "invalid_instructions" };

  const cleaned = raw.replace(CONTROL_CHARS, " ").replace(/[ \t]{2,}/g, " ").trim();
  if (!cleaned) return { ok: true, value: null };
  if (Array.from(cleaned).length > MAX_INSTRUCTIONS_LENGTH) {
    return { ok: false, error: "instructions_too_long" };
  }
  return { ok: true, value: cleaned };
}

/**
 * Where the note goes on a database that has nowhere to put it (0082 not
 * applied): the end of the address line, as every order did before the column
 * existed. The rider app shows that line, so the note is not lost.
 */
export function foldIntoAddressLine(
  line: string,
  instructions: string | null,
  separator = ", "
): string {
  const base = line.trim();
  if (!instructions) return base;
  return base ? `${base}${separator}${instructions}` : instructions;
}
