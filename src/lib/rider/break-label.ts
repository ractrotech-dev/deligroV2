/**
 * How a break's end reads on a screen — pure, no clock, no locale.
 *
 * "Until I resume" is stored as a far-future `break_until`
 * (`BREAK_UNTIL_RESUMED`, 9999-12-31), so showing the stored instant would
 * print a year nobody can read as "no end". Anything past the year 9000 is
 * words instead; a real end is an India clock time.
 *
 * Hand-formatted rather than `toLocaleTimeString`: this renders on the server
 * and again on the phone, and two ICU builds disagree about "pm" vs "PM" —
 * which React reports as a hydration mismatch on a card the rider looks at.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60_000;
const FAR_FUTURE_MS = Date.UTC(9000, 0, 1);

/** "Until you resume", "Until 3:30 pm" (IST), or null when there is no break to describe. */
export function breakLabel(breakUntil: string | null): string | null {
  if (!breakUntil) return null;
  const ms = Date.parse(breakUntil);
  if (!Number.isFinite(ms)) return null;
  if (ms >= FAR_FUTURE_MS) return "Until you resume";

  const ist = new Date(ms + IST_OFFSET_MS);
  const hours24 = ist.getUTCHours();
  const minutes = String(ist.getUTCMinutes()).padStart(2, "0");
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `Until ${hours12}:${minutes} ${hours24 < 12 ? "am" : "pm"}`;
}
