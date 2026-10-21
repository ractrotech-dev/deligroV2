import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlausibleFix } from "@/lib/geo/fix";
import {
  nextAvailability,
  type AvailabilityAction,
  type AvailabilityResult,
  type RiderAvailability,
} from "@/lib/rider/availability";
import { reportDriverLocation } from "@/lib/data-access/driver-orders";
import { EXCLUSIVE_OFFER_MS, offerStateFor, DISPATCH_COLUMNS } from "@/lib/dispatch/rider-dispatch";
import {
  columnKnownMissing,
  isMissingColumn,
  isMissingTable,
  rememberColumn,
} from "@/lib/data-access/schema-probe";

/**
 * A rider's availability: the database half of `lib/rider/availability.ts`.
 *
 * Every function takes the rider's id and trusts it, because every one runs on
 * the service-role client (the four tables are service-role-write only, 0081).
 * The authorization is therefore the caller's: `/api/rider/*` derive the id from
 * the session behind `requireRiderApi()`, and `/auth/signout` derives it from
 * the signed-in profile. No id ever comes from a request body.
 *
 * ## Before 0081 is applied
 *
 * Reads degrade: a database without the tables has no rider online, which is
 * the truth, so `getRiderAvailability` answers "offline" and `getRiderCode`
 * answers null. Writes fail closed: they throw `RiderSchemaPendingError`, which
 * the routes turn into 503 `migration_pending`. Nothing here pretends a shift
 * was opened when there is nowhere to record it.
 */

/** The 0081 tables are not in this database (yet). */
export class RiderSchemaPendingError extends Error {
  constructor() {
    super("migration_pending: rider_status / rider_shifts (0081) are not applied");
    this.name = "RiderSchemaPendingError";
  }
}

export function isRiderSchemaPending(error: unknown): error is RiderSchemaPendingError {
  return error instanceof RiderSchemaPendingError;
}

const OFFLINE: RiderAvailability = Object.freeze({
  isOnline: false,
  breakUntil: null,
  onlineSince: null,
  lastFixAt: null,
});

/** Throws RiderSchemaPendingError for a missing table, the raw error otherwise. */
function fail(error: { code?: string }): never {
  if (isMissingTable(error)) throw new RiderSchemaPendingError();
  throw error;
}

interface StatusRow {
  is_online: boolean;
  break_until: string | null;
  online_since: string | null;
  last_fix_at: string | null;
}

function toAvailability(row: StatusRow | null): RiderAvailability {
  if (!row || !row.is_online) return { ...OFFLINE };
  return {
    isOnline: true,
    breakUntil: row.break_until,
    onlineSince: row.online_since,
    lastFixAt: row.last_fix_at,
  };
}

async function loadStatus(driverId: string): Promise<RiderAvailability> {
  const { data, error } = await createAdminClient()
    .from("rider_status")
    .select("is_online, break_until, online_since, last_fix_at")
    .eq("driver_id", driverId)
    .maybeSingle()
    .overrideTypes<StatusRow>();
  if (error) fail(error);
  return toAvailability(data);
}

/**
 * Where the rider stands. A rider with no row — or on a database without the
 * table — is offline.
 */
export async function getRiderAvailability(driverId: string): Promise<RiderAvailability> {
  try {
    return await loadStatus(driverId);
  } catch (e) {
    if (isRiderSchemaPending(e)) return { ...OFFLINE };
    throw e;
  }
}

/** The rider ID (DR-0001, …), or null until 0081 has issued one. */
export async function getRiderCode(driverId: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("rider_profiles")
    .select("rider_code")
    .eq("driver_id", driverId)
    .maybeSingle()
    .overrideTypes<{ rider_code: string | null }>();
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  return data?.rider_code ?? null;
}

/** The rider's own delivery in flight, if any (assigned or picked up). */
export async function getActiveDeliveryId(driverId: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("deliveries")
    .select("id")
    .eq("driver_id", driverId)
    .in("status", ["assigned", "picked_up"])
    .order("assigned_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .overrideTypes<{ id: string }[]>();
  if (error) throw error;
  return data?.[0]?.id ?? null;
}

/**
 * Whether the rider is spoken for: carrying a delivery, or holding an offer
 * they have not answered and whose exclusive window has not run out.
 *
 * It is what stops "go offline" and "take a break" in the middle of a job, and
 * what stops a rider dodging an offer by going offline with it pending.
 *
 * The window is `offerStateFor`'s, the same function the job board and
 * `acceptDelivery` use, so "this offer is still mine" has one definition. An
 * offer past its window is open to everyone and commits nobody.
 */
export async function hasRiderCommitment(driverId: string): Promise<boolean> {
  if ((await getActiveDeliveryId(driverId)) !== null) return true;

  // No 0042: there are no offers, so nothing to be committed to.
  if (columnKnownMissing(DISPATCH_COLUMNS)) return false;

  const now = Date.now();
  const since = new Date(now - EXCLUSIVE_OFFER_MS).toISOString();
  const { data, error } = await createAdminClient()
    .from("deliveries")
    .select("offered_driver_id, offered_at")
    .eq("status", "unassigned")
    .eq("offered_driver_id", driverId)
    // Past the window the offer is open to the pool; don't read what can't count.
    .gt("offered_at", since)
    .overrideTypes<{ offered_driver_id: string | null; offered_at: string | null }[]>();
  if (error) {
    if (isMissingColumn(error)) {
      rememberColumn(DISPATCH_COLUMNS, false);
      return false;
    }
    // Cannot tell. Refusing to guess "free" is the safe side: the rider can
    // retry, and a wrong "free" would let them walk away from a job.
    throw error;
  }
  rememberColumn(DISPATCH_COLUMNS, true);

  return (data ?? []).some(
    (row) =>
      offerStateFor(
        driverId,
        { offeredDriverId: row.offered_driver_id, offeredAt: row.offered_at },
        now
      ) === "mine"
  );
}

/**
 * Apply an availability action: ask the rules, then write what they decided.
 *
 * `minutes` is only read for `break`. Returns the rules' refusal as a value
 * (`active_delivery`, `invalid_minutes`, `not_online`); infrastructure failures
 * throw, and a database without 0081 throws RiderSchemaPendingError.
 *
 * The commitment is checked at the moment of the action and not locked: an
 * offer landing a few milliseconds after the check is possible. It costs the
 * rider nothing they could not do next (decline it), and the offer's own window
 * releases it to the pool if ignored.
 */
export async function setRiderAvailability(
  driverId: string,
  action: AvailabilityAction,
  minutes?: number | null
): Promise<AvailabilityResult> {
  const current = await loadStatus(driverId);
  const now = new Date();

  // Only the actions that leave or pause a shift care. Skipping the queries for
  // `online` / `resume` keeps the tap that matters most the cheapest.
  const hasCommitment =
    action === "offline" || action === "break" ? await hasRiderCommitment(driverId) : false;

  const result = nextAvailability(current, action, { hasCommitment, now, minutes });
  if (!result.ok) return result;

  const supabase = createAdminClient();
  const nowIso = now.toISOString();

  // Shift first. An orphaned open shift (the status write below failing) is
  // closed by the next offline; a rider shown online with no shift would not be.
  if (result.shift === "open") {
    const { error } = await supabase
      .from("rider_shifts")
      .insert({ driver_id: driverId, started_at: result.next.onlineSince });
    // 23505: the one-open-shift index. A concurrent "go online" already opened
    // it, which is exactly the state wanted.
    if (error && error.code !== "23505") fail(error);
  }

  const patch: Record<string, unknown> = {
    driver_id: driverId,
    is_online: result.next.isOnline,
    break_until: result.next.breakUntil,
    online_since: result.next.onlineSince,
    updated_at: nowIso,
  };
  // The position is only touched when the rules cleared it (a new shift or
  // going offline). Otherwise a break would overwrite a fix that arrived while
  // this request was in flight with the older one it read.
  if (result.shift !== "none" || result.next.lastFixAt !== current.lastFixAt) {
    patch.last_fix_at = result.next.lastFixAt;
    patch.last_lat = null;
    patch.last_lng = null;
  }
  {
    const { error } = await supabase
      .from("rider_status")
      .upsert(patch, { onConflict: "driver_id" });
    if (error) fail(error);
  }

  if (result.shift === "close") {
    await closeOpenShifts(supabase, driverId, nowIso, "rider");
  }

  return result;
}

async function closeOpenShifts(
  supabase: ReturnType<typeof createAdminClient>,
  driverId: string,
  endedAt: string,
  endedBy: "rider" | "logout" | "ops" | "presence"
): Promise<void> {
  const { error } = await supabase
    .from("rider_shifts")
    .update({ ended_at: endedAt, ended_by: endedBy })
    .eq("driver_id", driverId)
    .is("ended_at", null);
  if (error) fail(error);
}

export type RiderFixResult =
  | { ok: true; online: boolean; active: boolean }
  | { ok: false; error: "invalid_position" };

/**
 * The rider's phone saying where it is.
 *
 * Two independent things happen, and either, both or neither may apply:
 *
 *   1. If the rider is ONLINE, `rider_status.last_*` is stamped. That is the
 *      presence signal dispatch reads. An offline rider's position is not
 *      stored at all — the `is_online` guard is in the UPDATE itself, so a fix
 *      racing a "go offline" cannot leave a position behind.
 *   2. Their delivery in flight, if any, gets the position through
 *      `reportDriverLocation` (customer tracking, arrival notice). That update
 *      matches nothing for a rider without a delivery, which is how `active`
 *      comes back false; it is passed through unchanged.
 *
 * Validation is `isPlausibleFix`, the same rule `reportDriverLocation` applies.
 */
export async function recordRiderFix(
  driverId: string,
  lat: number,
  lng: number
): Promise<RiderFixResult> {
  if (!isPlausibleFix(lat, lng)) return { ok: false, error: "invalid_position" };

  const stamp = async (): Promise<boolean> => {
    const at = new Date().toISOString();
    const { data, error } = await createAdminClient()
      .from("rider_status")
      .update({ last_lat: lat, last_lng: lng, last_fix_at: at, updated_at: at })
      .eq("driver_id", driverId)
      .eq("is_online", true)
      .select("driver_id")
      .overrideTypes<{ driver_id: string }[]>();
    if (error) fail(error);
    return (data ?? []).length > 0;
  };

  const [online, delivery] = await Promise.all([
    stamp(),
    reportDriverLocation(driverId, lat, lng),
  ]);
  if (!delivery.ok) return { ok: false, error: delivery.error };
  return { ok: true, online, active: delivery.active };
}

/**
 * Take a rider offline without asking: logout, an operator, or the presence
 * sweep. Unlike the rider's own `offline` it does not refuse for a delivery in
 * flight — the session is gone or the decision is staff's — and it is
 * idempotent (nothing online, nothing to do).
 */
export async function forceRiderOffline(
  driverId: string,
  endedBy: "logout" | "ops" | "presence"
): Promise<void> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  // Only an existing row can be online, so this is an UPDATE, never an upsert:
  // forcing a rider who never went online offline must not create a row.
  const { error } = await supabase
    .from("rider_status")
    .update({
      is_online: false,
      break_until: null,
      online_since: null,
      last_lat: null,
      last_lng: null,
      last_fix_at: null,
      updated_at: nowIso,
    })
    .eq("driver_id", driverId);
  if (error) fail(error);

  await closeOpenShifts(supabase, driverId, nowIso, endedBy);
}

/**
 * The privacy-policy and terms links admins have published (0081), https only.
 * Nothing is invented: unset, unreadable or not https is null and the app hides
 * the link. Chrome rather than access, so any failure degrades to null.
 */
export async function getRiderLegalLinks(): Promise<{
  privacyUrl: string | null;
  termsUrl: string | null;
}> {
  const none = { privacyUrl: null, termsUrl: null };
  try {
    const { data, error } = await createAdminClient()
      .from("platform_settings")
      .select("privacy_policy_url, terms_url")
      .eq("id", true)
      .maybeSingle()
      .overrideTypes<{ privacy_policy_url: string | null; terms_url: string | null }>();
    if (error || !data) return none;
    const link = (v: string | null) => {
      const s = (v ?? "").trim();
      return /^https:\/\//i.test(s) ? s : null;
    };
    return { privacyUrl: link(data.privacy_policy_url), termsUrl: link(data.terms_url) };
  } catch {
    return none;
  }
}
