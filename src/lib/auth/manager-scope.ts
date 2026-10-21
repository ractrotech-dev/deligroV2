/**
 * The zones a manager may see, and the one way every manager read applies them.
 *
 * Pure and browser-safe: no I/O, exercised offline by scripts/qa/manager-scope.ts.
 * The database enforces the same rule (manager_can_see_zone, migration 0141);
 * this is the half that applies to service-role reads, which bypass RLS.
 *
 * Fail closed: a manager with no zones is `{ all: false, zoneIds: [] }`, and
 * that filters to a sentinel id no row has — never to "no filter".
 */

export type ManagerScope = { all: true } | { all: false; zoneIds: string[] };

/** A uuid no zone has. Filtering on it returns nothing. */
export const NO_ZONE = "00000000-0000-0000-0000-000000000000";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Whether a row in `zoneId` is visible. A row without a zone is admin-only. */
export function scopeAllows(scope: ManagerScope, zoneId: string | null | undefined): boolean {
  if (scope.all) return true;
  return !!zoneId && scope.zoneIds.includes(zoneId);
}

/** The bit of a Supabase query builder this needs. */
interface InFilterable<Q> {
  in(column: string, values: readonly string[]): Q;
}

/**
 * Filter a query to the scope's zones. Admin scope adds nothing; every other
 * scope adds `column in (…)`, using {@link NO_ZONE} when the list is empty.
 */
export function applyZoneScope<Q extends InFilterable<Q>>(
  query: Q,
  scope: ManagerScope,
  column = "zone_id"
): Q {
  if (scope.all) return query;
  return query.in(column, scope.zoneIds.length > 0 ? scope.zoneIds : [NO_ZONE]);
}

/**
 * A screen's "this zone only" filter. Never widens: a zone outside the scope,
 * or anything that is not a uuid, narrows to nothing.
 */
export function narrowScope(scope: ManagerScope, zoneId: string | null | undefined): ManagerScope {
  if (zoneId === null || zoneId === undefined || zoneId === "") return scope;
  if (!isUuid(zoneId) || !scopeAllows(scope, zoneId)) return { all: false, zoneIds: [] };
  return { all: false, zoneIds: [zoneId] };
}

export interface ZoneInput {
  name: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
}

/** The same limits the delivery_zones CHECK constraints apply (0141). */
export function validateZoneInput(
  input: ZoneInput
): { ok: true; value: ZoneInput } | { ok: false; error: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Name must be 2–60 characters." };
  const { centerLat, centerLng, radiusKm } = input;
  if (!Number.isFinite(centerLat) || centerLat < -90 || centerLat > 90) {
    return { ok: false, error: "Latitude must be between -90 and 90." };
  }
  if (!Number.isFinite(centerLng) || centerLng < -180 || centerLng > 180) {
    return { ok: false, error: "Longitude must be between -180 and 180." };
  }
  if (!Number.isFinite(radiusKm) || radiusKm < 0.5 || radiusKm > 50) {
    return { ok: false, error: "Radius must be between 0.5 and 50 km." };
  }
  return { ok: true, value: { name, centerLat, centerLng, radiusKm: Math.round(radiusKm * 10) / 10 } };
}

/** "Bemetara West" → "bemetara-west". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "zone";
}
