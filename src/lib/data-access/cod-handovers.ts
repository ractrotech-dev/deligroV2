import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readAllRows } from "@/lib/data-access/read-all";
import { istDateKey } from "@/lib/utils/ist-time";
import { scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { isMissingColumn } from "@/lib/data-access/schema-probe";
import type { CashHandoverLeg } from "@/lib/cash-ledger-types";

/**
 * The digital half of the cash-on-delivery chain: Customer -> Rider ->
 * Manager -> Owner, or Rider -> Owner directly (0195). The cash itself moves
 * offline; every function here records that a leg of that movement happened,
 * so nothing financially material is left untracked. Who received the cash
 * confirms it, one confirmation is enough, and `confirmed_by` says who.
 *
 * Every write goes through the service role and is reached only from a
 * server action gated by requireRole(["manager", "admin"]) — the same shape
 * as vendor settlements (0028). Nobody's own session writes this table
 * directly.
 *
 * Since 0141 every row belongs to a zone, and every read here takes the
 * caller's `ManagerScope`: the service role bypasses RLS, so the zone filter
 * has to be applied in the query (`applyZoneScope`), never assumed.
 */

export type { CashHandoverLeg };

export interface CodHandoverRow {
  id: string;
  leg: CashHandoverLeg;
  fromUserName: string | null;
  toUserName: string | null;
  amount: number;
  handoverDate: string;
  note: string | null;
  recordedByName: string | null;
  /**
   * Who confirmed they received this cash. Null only on a manager's own
   * manager → owner row that the owner has not confirmed yet.
   */
  confirmedByName: string | null;
  createdAt: string;
}

interface HandoverRecordInput {
  leg: CashHandoverLeg;
  fromUserId?: string | null;
  toUserId?: string | null;
  amount: number;
  note?: string | null;
  recordedBy: string;
  /** From `resolveRecordZone`; null only for an admin (the default zone). */
  zoneId: string | null;
}

/** Record one handover leg. Never updates an existing row — a correction is a new row. */
export async function recordCodHandover(
  input: HandoverRecordInput
): Promise<{ ok: boolean; error?: string; id?: string }> {
  // Whole rupees above zero. `Number("")` is 0, so an empty box used to save a
  // ₹0 row, and `Math.round` below used to turn a typo like 500.5 into 501
  // without telling anyone; neither is a handover anybody meant to record.
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return { ok: false, error: "Enter the amount in whole rupees, more than zero." };
  }
  // A rider handing cash to a manager has to name the rider, or the cash can
  // never be taken off anyone's outstanding balance.
  if (input.leg !== "manager_to_owner" && !input.fromUserId) {
    return { ok: false, error: "Pick the rider who handed over the cash." };
  }

  const supabase = createAdminClient();
  // The new row's id comes back so a confirmed rider deposit (rider-cash.ts)
  // can link to the handover it produced; the row is still only ever inserted.
  const { data, error } = await supabase
    .from("cod_handovers")
    .insert({
      leg: input.leg,
      from_user: input.fromUserId ?? null,
      to_user: input.toUserId ?? null,
      amount: Math.round(input.amount),
      handover_date: istDateKey(),
      note: input.note?.trim() || null,
      recorded_by: input.recordedBy,
      // Omitted for an admin's unspecified zone: the 0141 trigger fills it.
      ...(input.zoneId ? { zone_id: input.zoneId } : {}),
    })
    .select("id")
    .single()
    .overrideTypes<{ id: string }>();

  if (error && /deposit_exists/.test(error.message ?? "")) {
    // 0085 / 0152: the rider declared a deposit for that day, which is that
    // cash's record; a second, hand-written leg would count it twice.
    return {
      ok: false,
      error: "This rider declared a deposit for that day. Confirm or dispute the deposit instead of recording it here.",
    };
  }
  if (error && /handover_exists/.test(error.message ?? "")) {
    return { ok: false, error: HANDOVER_EXISTS };
  }
  if (error || !data) return { ok: false, error: "That didn't save. Try again." };
  return { ok: true, id: data.id };
}

/** The same cash, written down by a second person. The first one stands. */
const HANDOVER_EXISTS = "Someone else already recorded this amount from this person today. It isn't counted twice.";

/** Why a confirmation or a record of cash received was refused, in plain words. */
function cashReceivedError(message: string): string {
  if (/handover_exists/.test(message)) return HANDOVER_EXISTS;
  if (/deposit_exists/.test(message)) {
    return "This rider declared a deposit today. Confirm or dispute the deposit instead.";
  }
  if (/already_confirmed/.test(message)) return "Already confirmed.";
  if (/invalid_amount/.test(message)) return "Enter the amount in whole rupees, more than zero.";
  if (/note_too_long/.test(message)) return "That note is too long.";
  if (/could not find the function|does not exist/i.test(message)) return "This needs migration 0195.";
  return "That didn't go through. Try again.";
}

/**
 * The owner records cash received directly, from a rider or a manager (0195).
 * One audited function. Authorization is the caller's `requireRole("admin")`,
 * and the function re-checks that the actor is an admin.
 */
export async function recordCashReceived(input: {
  actorId: string;
  kind: "rider" | "manager";
  fromUserId: string;
  amount: number;
  note?: string | null;
  clientActionId?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return { ok: false, error: "Enter the amount in whole rupees, more than zero." };
  }
  const { error } = await createAdminClient().rpc("ops_record_cash_received", {
    p_actor: input.actorId,
    p_from: input.fromUserId,
    p_kind: input.kind,
    p_amount: input.amount,
    p_note: input.note?.trim() || null,
    p_client_action_id: input.clientActionId ?? null,
  });
  return error ? { ok: false, error: cashReceivedError(error.message ?? "") } : { ok: true };
}

/**
 * The owner confirms a manager's own "I gave it to the owner" row (0195). Adds
 * no money: the row already counts. The first confirmation wins, and the second
 * is told who got there first.
 */
export async function confirmManagerHandover(
  actorId: string,
  handoverId: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = createAdminClient();
  const { error } = await supabase.rpc("ops_confirm_manager_handover", {
    p_actor: actorId,
    p_handover: handoverId,
    p_client_action_id: null,
  });
  if (!error) return { ok: true };
  if (/already_confirmed/.test(error.message ?? "")) {
    const { data } = await supabase
      .from("cod_handovers")
      .select("confirmed:profiles!cod_handovers_confirmed_by_fkey(full_name)")
      .eq("id", handoverId)
      .maybeSingle()
      .overrideTypes<{ confirmed: ProfileRef }>();
    const who = name(data?.confirmed ?? null);
    return { ok: false, error: who ? `Already confirmed by ${who}.` : "Already confirmed." };
  }
  return { ok: false, error: cashReceivedError(error.message ?? "") };
}

type ProfileRef = { full_name: string | null } | { full_name: string | null }[] | null;

function name(ref: ProfileRef): string | null {
  const one = Array.isArray(ref) ? (ref[0] ?? null) : ref;
  return one?.full_name?.trim() || null;
}

/** Recent handovers, newest first. Capped — this is an operator's working list, not an export. */
export async function listCodHandovers(
  scope: ManagerScope,
  limit = 50
): Promise<CodHandoverRow[]> {
  const supabase = createAdminClient();
  const columns =
    "id, leg, amount, handover_date, note, created_at, from:profiles!cod_handovers_from_user_fkey(full_name), to:profiles!cod_handovers_to_user_fkey(full_name), recorded:profiles!cod_handovers_recorded_by_fkey(full_name)";
  type Row = {
    id: string;
    leg: CashHandoverLeg;
    amount: number;
    handover_date: string;
    note: string | null;
    created_at: string;
    from: ProfileRef;
    to: ProfileRef;
    recorded: ProfileRef;
    confirmed?: ProfileRef;
  };
  // The plain id list rather than applyZoneScope: a select built from a string is
  // too deep for that generic to type.
  const zoneIds = scopeZoneIds(scope);
  const read = (select: string) => {
    let q = supabase.from("cod_handovers").select(select);
    if (zoneIds) q = q.in("zone_id", zoneIds);
    return q.order("created_at", { ascending: false }).limit(limit).overrideTypes<Row[]>();
  };
  let { data, error } = await read(`${columns}, confirmed:profiles!cod_handovers_confirmed_by_fkey(full_name)`);
  // A database before 0195 has no confirmed_by: the list still reads, and whoever
  // recorded a row is who confirmed it.
  if (error && (isMissingColumn(error) || error.code === "PGRST200")) {
    ({ data, error } = await read(columns));
    if (!error) data = (data ?? []).map((row) => ({ ...row, confirmed: row.recorded }));
  }

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    leg: row.leg,
    fromUserName: name(row.from),
    toUserName: name(row.to),
    amount: row.amount,
    handoverDate: row.handover_date,
    note: row.note,
    recordedByName: name(row.recorded),
    confirmedByName: name(row.confirmed ?? null),
    createdAt: row.created_at,
  }));
}

/**
 * COD collected today per `deliveries.cod_collected_amount`, against COD
 * handed over today. Shown side by side so a manager can see whether today's
 * collections have actually been handed on — not enforced, not blocked, just
 * visible. Reconciling the two is an operator's own judgement call, same as
 * every other manual step in this flow.
 */
export interface CodDaySummary {
  collectedToday: number;
  handedToManagerToday: number;
  /** Rider straight to owner. */
  riderToOwnerToday: number;
  /** Manager to owner. */
  handedToOwnerToday: number;
}

export async function codDaySummary(scope: ManagerScope): Promise<CodDaySummary> {
  const supabase = createAdminClient();
  const today = istDateKey();
  const startOfDay = `${today}T00:00:00+05:30`;
  const endOfDay = `${today}T23:59:59.999+05:30`;

  // Deliveries carry no zone of their own: the order's, through an inner join.
  let collectedQuery = supabase
    .from("deliveries")
    .select("cod_collected_amount, orders!inner(zone_id)")
    .gte("cod_collected_at", startOfDay)
    .lte("cod_collected_at", endOfDay)
    .not("cod_collected_amount", "is", null);
  const zoneIds = scopeZoneIds(scope);
  if (zoneIds) collectedQuery = collectedQuery.in("orders.zone_id", zoneIds);
  let handoverQuery = supabase.from("cod_handovers").select("leg, amount").eq("handover_date", today);
  if (zoneIds) handoverQuery = handoverQuery.in("zone_id", zoneIds);
  const [collected, handovers] = await Promise.all([
    collectedQuery.overrideTypes<{ cod_collected_amount: number | null }[]>(),
    handoverQuery.overrideTypes<{ leg: CashHandoverLeg; amount: number }[]>(),
  ]);

  const collectedToday = (collected.data ?? []).reduce(
    (sum, row) => sum + (row.cod_collected_amount ?? 0),
    0
  );
  const handedToManagerToday = (handovers.data ?? [])
    .filter((row) => row.leg === "rider_to_manager")
    .reduce((sum, row) => sum + row.amount, 0);
  const riderToOwnerToday = (handovers.data ?? [])
    .filter((row) => row.leg === "rider_to_owner")
    .reduce((sum, row) => sum + row.amount, 0);
  const handedToOwnerToday = (handovers.data ?? [])
    .filter((row) => row.leg === "manager_to_owner")
    .reduce((sum, row) => sum + row.amount, 0);

  return { collectedToday, handedToManagerToday, riderToOwnerToday, handedToOwnerToday };
}

/**
 * COD collected minus COD handed on, all-time and identifiable — not reset
 * daily, and not a single lump figure.
 *
 * codDaySummary() above answers "did today balance"; this answers "is
 * anything still outstanding, and with whom", which a day-scoped view cannot:
 * a shortfall from three days ago that nobody has handed over yet must not
 * quietly drop off the picture once the calendar day changes. Nothing here
 * is enforced or auto-resolved — a positive figure is a prompt to ask, not a
 * blocked action.
 */
export interface RiderCodOutstanding {
  riderId: string;
  riderName: string;
  collected: number;
  handedToManager: number;
  /** Given straight to the owner (0195). */
  handedToOwner: number;
  /** collected - handedToManager - handedToOwner. Negative means more was handed over than this rider is recorded as having collected — also worth asking about, not just a positive gap. */
  outstanding: number;
}

export interface ManagerCodOutstanding {
  managerId: string;
  managerName: string;
  received: number;
  handedOn: number;
  /** received - handedOn. */
  outstanding: number;
}

export interface CodLedgerSummary {
  totalCollected: number;
  totalHandedToManager: number;
  /** Manager → owner. */
  totalHandedToOwner: number;
  /** Rider → owner, directly (0195). */
  totalRiderToOwner: number;
  /** Cash still with riders, collectively: totalCollected - totalHandedToManager - totalRiderToOwner. */
  outstandingWithRiders: number;
  /** Cash still with managers, collectively: totalHandedToManager - totalHandedToOwner. */
  outstandingWithManagers: number;
  /** Per rider, for the ones with any recorded activity — sorted by outstanding, highest first. */
  byRider: RiderCodOutstanding[];
  /** Per manager with any recorded activity, highest first. */
  byManager: ManagerCodOutstanding[];
  /** Collected cash whose delivery has no driver on record, or handovers with no rider named — cannot be attributed to a person. Still counted in the totals above. */
  unattributedCollected: number;
  unattributedHandedToManager: number;
}

interface HandoverBalanceRow {
  leg: CashHandoverLeg;
  amount: number;
  from_user: string | null;
  to_user: string | null;
  recorded_by: string;
}

export async function codOutstandingSummary(scope: ManagerScope): Promise<CodLedgerSummary> {
  const supabase = createAdminClient();
  // The plain id list rather than applyZoneScope: these builders, with an
  // embedded join, are too deep for the generic to type.
  const zoneIds = scopeZoneIds(scope);

  const [collectedRows, handoverRows, riderRows] = await Promise.all([
    readAllRows<{ driver_id: string | null; cod_collected_amount: number | null }>(
      (from, to) => {
        let q = supabase
          .from("deliveries")
          .select("driver_id, cod_collected_amount, orders!inner(zone_id)")
          .not("cod_collected_amount", "is", null);
        if (zoneIds) q = q.in("orders.zone_id", zoneIds);
        return q
          .order("id")
          .range(from, to)
          .overrideTypes<{ driver_id: string | null; cod_collected_amount: number | null }[]>();
      }
    ),
    readAllRows<HandoverBalanceRow>(
      (from, to) => {
        let q = supabase.from("cod_handovers").select("leg, amount, from_user, to_user, recorded_by");
        if (zoneIds) q = q.in("zone_id", zoneIds);
        return q
          .order("id")
          .range(from, to)
          .overrideTypes<HandoverBalanceRow[]>();
      }
    ),
    supabase
      .from("profiles")
      .select("id, full_name, role")
      .in("role", ["driver", "manager"])
      .overrideTypes<{ id: string; full_name: string | null; role: string }[]>(),
  ]);

  if (collectedRows.error) throw collectedRows.error;
  if (handoverRows.error) throw handoverRows.error;
  if (riderRows.error) throw riderRows.error;

  const riderNames = new Map(
    (riderRows.data ?? []).filter((r) => r.role === "driver").map((r) => [r.id, r.full_name?.trim() || "Rider"])
  );
  const managerNames = new Map(
    (riderRows.data ?? []).filter((r) => r.role === "manager").map((r) => [r.id, r.full_name?.trim() || "Manager"])
  );

  const collectedByRider = new Map<string, number>();
  let unattributedCollected = 0;
  let totalCollected = 0;
  for (const row of collectedRows.data) {
    const amount = row.cod_collected_amount ?? 0;
    totalCollected += amount;
    if (row.driver_id) {
      collectedByRider.set(row.driver_id, (collectedByRider.get(row.driver_id) ?? 0) + amount);
    } else {
      unattributedCollected += amount;
    }
  }

  const handedByRider = new Map<string, number>();
  const ownerByRider = new Map<string, number>();
  const receivedByManager = new Map<string, number>();
  const handedOnByManager = new Map<string, number>();
  const add = (m: Map<string, number>, key: string, amount: number) => m.set(key, (m.get(key) ?? 0) + amount);
  let unattributedHandedToManager = 0;
  let totalHandedToManager = 0;
  let totalHandedToOwner = 0;
  let totalRiderToOwner = 0;
  for (const row of handoverRows.data) {
    if (row.leg === "rider_to_manager") {
      totalHandedToManager += row.amount;
      // The /manager/cash form never named these: whoever wrote the row received it.
      add(receivedByManager, row.to_user ?? row.recorded_by, row.amount);
      if (row.from_user) {
        add(handedByRider, row.from_user, row.amount);
      } else {
        unattributedHandedToManager += row.amount;
      }
    } else if (row.leg === "rider_to_owner") {
      totalRiderToOwner += row.amount;
      if (row.from_user) add(ownerByRider, row.from_user, row.amount);
    } else {
      totalHandedToOwner += row.amount;
      add(handedOnByManager, row.from_user ?? row.recorded_by, row.amount);
    }
  }

  const riderIds = new Set([...collectedByRider.keys(), ...handedByRider.keys(), ...ownerByRider.keys()]);
  const byRider: RiderCodOutstanding[] = [...riderIds].map((riderId) => {
    const collected = collectedByRider.get(riderId) ?? 0;
    const handedToManager = handedByRider.get(riderId) ?? 0;
    const handedToOwner = ownerByRider.get(riderId) ?? 0;
    return {
      riderId,
      riderName: riderNames.get(riderId) ?? "Former rider",
      collected,
      handedToManager,
      handedToOwner,
      outstanding: collected - handedToManager - handedToOwner,
    };
  });
  byRider.sort((a, b) => b.outstanding - a.outstanding);

  const managerIds = new Set([...receivedByManager.keys(), ...handedOnByManager.keys()]);
  const byManager: ManagerCodOutstanding[] = [...managerIds].map((managerId) => {
    const received = receivedByManager.get(managerId) ?? 0;
    const handedOn = handedOnByManager.get(managerId) ?? 0;
    return {
      managerId,
      // An old row an admin wrote: it is on the record under the owner.
      managerName: managerNames.get(managerId) ?? "Owner or former manager",
      received,
      handedOn,
      outstanding: received - handedOn,
    };
  });
  byManager.sort((a, b) => b.outstanding - a.outstanding);

  return {
    totalCollected,
    totalHandedToManager,
    totalHandedToOwner,
    totalRiderToOwner,
    outstandingWithRiders: totalCollected - totalHandedToManager - totalRiderToOwner,
    outstandingWithManagers: totalHandedToManager - totalHandedToOwner,
    byRider,
    byManager,
    unattributedCollected,
    unattributedHandedToManager,
  };
}

/** Who the owner can say they received cash from: riders and managers, by name. */
export async function listCashPeople(): Promise<{
  riders: { id: string; name: string }[];
  managers: { id: string; name: string }[];
}> {
  const { data, error } = await createAdminClient()
    .from("profiles")
    .select("id, full_name, role")
    .in("role", ["driver", "manager"])
    .order("full_name")
    .limit(1000)
    .overrideTypes<{ id: string; full_name: string | null; role: string }[]>();
  if (error) throw error;
  const of = (role: string, fallback: string) =>
    (data ?? []).filter((p) => p.role === role).map((p) => ({ id: p.id, name: p.full_name?.trim() || fallback }));
  return { riders: of("driver", "Rider"), managers: of("manager", "Manager") };
}
