/**
 * The locality of a geocoded address line — "Berla, Bemetara, Chhattisgarh
 * 491335, India" → "Bemetara" — the part a person uses to say where they are.
 *
 * It is the segment just before the "State PIN" one. Taking the last two
 * segments instead ("Chhattisgarh 490020, India") is what the home header used
 * to do, which at 360px left "DELIVER TO H… · Chhattisgarh 4900…": neither the
 * label nor a place anyone would recognise. Falls back to the third-from-last
 * segment for a line with no PIN, and to null for a line too short to have one.
 */
export function addressLocality(line: string | null | undefined): string | null {
  if (!line) return null;
  const parts = line
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const pin = parts.findIndex((p) => /\d{6}/.test(p));
  if (pin > 0) return parts[pin - 1];
  return parts.at(-3) ?? null;
}
