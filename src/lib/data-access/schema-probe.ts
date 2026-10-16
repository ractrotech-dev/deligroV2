import "server-only";
import { recordDomain } from "@/lib/obs/emit";

/** PostgREST's "column does not exist". */
const UNDEFINED_COLUMN = "42703";

export function isMissingColumn(error: { code?: string } | null): boolean {
  return error?.code === UNDEFINED_COLUMN;
}

/**
 * A whole table/relation is missing, not just a column: PostgREST answers
 * with its own PGRST205 ("Could not find the table... in the schema cache")
 * rather than Postgres's 42P01, because it checks its introspected schema
 * cache before issuing SQL at all. Used the same way as isMissingColumn — a
 * query for a table whose migration hasn't landed yet should degrade, not
 * 500 the feature it's optional to.
 */
export function isMissingTable(error: { code?: string } | null): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

/**
 * Remembers, per column, whether the database has actually been migrated.
 *
 * Asking PostgREST for a column that doesn't exist is a hard 400, not a null —
 * so a query written for a migration that hasn't been applied yet takes the
 * whole feature down. Rather than let an un-migrated environment serve an empty
 * feed or a dead checkout, the queries here probe once and then serve a
 * degraded-but-honest version until the migration lands.
 *
 * Every entry is a promise to delete: once an environment is known-migrated, the
 * branch that reads it is dead weight.
 */
const known = new Map<string, boolean>();

export function columnKnownMissing(key: string): boolean {
  return known.get(key) === false;
}

/**
 * Confirmed present, as opposed to merely not-known-missing. The difference
 * matters when a caller wants to probe an unknown column deliberately rather
 * than discover it by having a real query fail.
 */
export function columnKnownPresent(key: string): boolean {
  return known.get(key) === true;
}

export function rememberColumn(key: string, present: boolean): void {
  const first = !known.has(key);
  known.set(key, present);

  // A missing column latches a feature into its degraded form for the life of
  // the process, and every degradation here is a real loss an operator would
  // want to know about: no tip on the order, no online payment, the settings
  // group silently serving defaults. Nothing said so before, which is how
  // migration 0044 shipped with an ungranted column that made every vendor hear
  // the wrong alert sound and produced no signal at all.
  //
  // Reported once per column per process — the probe is cached, so a second
  // report would only mean a new instance started, which is not news.
  if (first && !present) {
    recordDomain(
      "schema.degraded",
      "warn",
      `Column "${key}" is missing or ungranted — the feature that reads it is serving a degraded answer`,
      { attrs: { column: key, degraded: true } }
    );
  }
}
