import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingColumn, isMissingTable } from "@/lib/data-access/schema-probe";
import { istDay } from "@/lib/rider/earnings-math";
import { dispatchBlockedByDocuments } from "@/lib/rider/profile-rules";

/**
 * `block_dispatch_on_expired_docs` (migration 0086): which riders an expired
 * document keeps off the road. Read by dispatch (`loadCandidates`) and by
 * `acceptDelivery` — the one accept path the rider app and the web portal
 * share — so no way of taking an order skips it.
 *
 * Kept apart from `rider-profile.ts` on purpose: `driver-orders.ts` imports
 * this, and `rider-profile.ts` sits above `rider-status.ts`, which imports
 * `driver-orders.ts` (no import cycle).
 *
 * Service role; callers authorise first (AGENTS.md rule 5).
 */

type PgError = { code?: string; message?: string };
const schemaPending = (e: PgError | null | undefined) => !!e && (isMissingTable(e) || isMissingColumn(e));

const CHUNK = 100;

/**
 * Riders in `ids` that dispatch must skip because of an expired document —
 * empty unless the admin setting `block_dispatch_on_expired_docs` is on
 * (default off, Review Focus 4), and empty on a database without 0086 (there
 * is no setting to be on). With the setting off nothing else is read.
 *
 * Any other read failure throws: dispatch must not treat "could not read" as
 * "nobody blocked" while the setting may be on.
 */
export async function loadDocumentBlockedRiders(ids: readonly string[], now: Date = new Date()): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  const supabase = createAdminClient();
  const { data: setting, error: settingError } = await supabase
    .from("platform_settings")
    .select("block_dispatch_on_expired_docs")
    .eq("id", true)
    .maybeSingle()
    .overrideTypes<{ block_dispatch_on_expired_docs: boolean | null }>();
  if (settingError) {
    if (schemaPending(settingError)) return out;
    throw settingError;
  }
  if (setting?.block_dispatch_on_expired_docs !== true) return out;

  const today = istDay(now);
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const [docs, owners] = await Promise.all([
      supabase
        .from("rider_documents")
        .select("driver_id, doc_type, status, expires_on")
        .in("driver_id", slice)
        .lt("expires_on", today)
        .not("status", "in", "(replaced,rejected)")
        .overrideTypes<{ driver_id: string; doc_type: string; status: string; expires_on: string | null }[]>(),
      supabase
        .from("rider_profiles")
        .select("driver_id, vehicle_owner")
        .in("driver_id", slice)
        .overrideTypes<{ driver_id: string; vehicle_owner: string | null }[]>(),
    ]);
    if (docs.error) {
      if (schemaPending(docs.error)) return out;
      throw docs.error;
    }
    if (owners.error) throw owners.error;
    const ownerOfRider = new Map((owners.data ?? []).map((o) => [o.driver_id, o.vehicle_owner]));
    const byRider = new Map<string, { type: string; status: string; expiresOn: string | null }[]>();
    for (const d of docs.data ?? []) {
      const list = byRider.get(d.driver_id) ?? [];
      list.push({ type: d.doc_type, status: d.status, expiresOn: d.expires_on });
      byRider.set(d.driver_id, list);
    }
    for (const [rider, list] of byRider) {
      if (dispatchBlockedByDocuments(list, ownerOfRider.get(rider) ?? null, today, true)) out.add(rider);
    }
  }
  return out;
}

/** One rider, for the accept path. */
export async function riderBlockedByDocuments(driverId: string, now: Date = new Date()): Promise<boolean> {
  return (await loadDocumentBlockedRiders([driverId], now)).has(driverId);
}
