/**
 * A database timestamp as a contract string, with nothing lost.
 *
 * Postgres keeps microseconds and PostgREST sends all of them. `new Date(v)`
 * keeps milliseconds. That is fine for showing a time, and wrong for anything
 * that goes back to SQL to be compared: the edit tokens of ops_upsert_offer and
 * ops_update_campaign compare `updated_at` exactly, so a token passed through
 * Date never matched and every edit came back "stale". A keyset cursor passed
 * through Date skips the rows that fall inside the lost microseconds.
 *
 * Anything that goes back to SQL uses this. The output is UTC ISO 8601 with at
 * least three fractional digits, so a value with no sub-millisecond part reads
 * exactly as toISOString would, and it stands for the same instant as the input.
 * Pure: exercised by scripts/qa/manager-edit-tokens.ts.
 */
const STAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

function isoOffset(raw: string | undefined): string {
  if (!raw || raw === "Z" || raw === "z") return "Z";
  if (raw.length === 3) return `${raw}:00`;
  return raw.includes(":") ? raw : `${raw.slice(0, 3)}:${raw.slice(3)}`;
}

export function exactTimestamp(value: string): string {
  const m = STAMP.exec(value.trim());
  if (!m) return new Date(value).toISOString();
  const [, day, time, fraction = "", offset] = m;
  const seconds = new Date(`${day}T${time}${isoOffset(offset)}`).toISOString().slice(0, 19);
  return `${seconds}.${fraction.replace(/0+$/, "").padEnd(3, "0")}Z`;
}
