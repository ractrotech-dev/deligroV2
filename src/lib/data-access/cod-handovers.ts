import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readAllRows } from "@/lib/data-access/read-all";
import { istDateKey } from "@/lib/utils/ist-time";
import type { CashHandoverLeg } from "@/lib/cash-ledger-types";

/**
 * The digital half of the cash-on-delivery chain: Customer -> Rider ->
 * Manager -> Owner. The cash itself moves offline; every function here
 * records that a leg of that movement happened, so nothing financially
 * material is left untracked.
 *
 * Every write goes through the service role and is reached only from a
 * server action gated by requireRole(["manager", "admin"]) — the same shape
 * as vendor settlements (0028). Nobody's own session writes this table
 * directly.
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
  createdAt: string;
}

interface HandoverRecordInput {
  leg: CashHandoverLeg;
  fromUserId?: string | null;
  toUserId?: string | null;
  amount: number;
  note?: string | null;
  recordedBy: string;
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
  if (input.leg === "rider_to_manager" && !input.fromUserId) {
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
    })
    .select("id")
    .single()
    .overrideTypes<{ id: string }>();

  if (error || !data) return { ok: false, error: "That didn't save. Try again." };
  return { ok: true, id: data.id };
}

type ProfileRef = { full_name: string | null } | { full_name: string | null }[] | null;

function name(ref: ProfileRef): string | null {
  const one = Array.isArray(ref) ? (ref[0] ?? null) : ref;
  return one?.full_name?.trim() || null;
}

/** Recent handovers, newest first. Capped — this is an operator's working list, not an export. */
export async function listCodHandovers(limit = 50): Promise<CodHandoverRow[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("cod_handovers")
    .select(
      "id, leg, amount, handover_date, note, created_at, from:profiles!cod_handovers_from_user_fkey(full_name), to:profiles!cod_handovers_to_user_fkey(full_name), recorded:profiles!cod_handovers_recorded_by_fkey(full_name)"
    )
    .order("created_at", { ascending: false })
    .limit(limit)
    .overrideTypes<
      {
        id: string;
        leg: CashHandoverLeg;
        amount: number;
        handover_date: string;
        note: string | null;
        created_at: string;
        from: ProfileRef;
        to: ProfileRef;
        recorded: ProfileRef;
      }[]
    >();

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
  handedToOwnerToday: number;
}

export async function codDaySummary(): Promise<CodDaySummary> {
  const supabase = createAdminClient();
  const today = istDateKey();
  const startOfDay = `${today}T00:00:00+05:30`;
  const endOfDay = `${today}T23:59:59.999+05:30`;

  const [collected, handovers] = await Promise.all([
    supabase
      .from("deliveries")
      .select("cod_collected_amount")
      .gte("cod_collected_at", startOfDay)
      .lte("cod_collected_at", endOfDay)
      .not("cod_collected_amount", "is", null)
      .overrideTypes<{ cod_collected_amount: number | null }[]>(),
    supabase
      .from("cod_handovers")
      .select("leg, amount")
      .eq("handover_date", today)
      .overrideTypes<{ leg: CashHandoverLeg; amount: number }[]>(),
  ]);

  const collectedToday = (collected.data ?? []).reduce(
    (sum, row) => sum + (row.cod_collected_amount ?? 0),
    0
  );
  const handedToManagerToday = (handovers.data ?? [])
    .filter((row) => row.leg === "rider_to_manager")
    .reduce((sum, row) => sum + row.amount, 0);
  const handedToOwnerToday = (handovers.data ?? [])
    .filter((row) => row.leg === "manager_to_owner")
    .reduce((sum, row) => sum + row.amount, 0);

  return { collectedToday, handedToManagerToday, handedToOwnerToday };
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
  /** collected - handedToManager. Negative means more was handed over than this rider is recorded as having collected — also worth asking about, not just a positive gap. */
  outstanding: number;
}

export interface CodLedgerSummary {
  totalCollected: number;
  totalHandedToManager: number;
  totalHandedToOwner: number;
  /** Cash still with riders, collectively: totalCollected - totalHandedToManager. */
  outstandingWithRiders: number;
  /** Cash still with managers, collectively: totalHandedToManager - totalHandedToOwner. */
  outstandingWithManagers: number;
  /** Per rider, for the ones with any recorded activity — sorted by outstanding, highest first. */
  byRider: RiderCodOutstanding[];
  /** Collected cash whose delivery has no driver on record, or handovers with no rider named — cannot be attributed to a person. Still counted in the totals above. */
  unattributedCollected: number;
  unattributedHandedToManager: number;
}

export async function codOutstandingSummary(): Promise<CodLedgerSummary> {
  const supabase = createAdminClient();

  const [collectedRows, handoverRows, riderRows] = await Promise.all([
    readAllRows<{ driver_id: string | null; cod_collected_amount: number | null }>(
      (from, to) =>
        supabase
          .from("deliveries")
          .select("driver_id, cod_collected_amount")
          .not("cod_collected_amount", "is", null)
          .order("id")
          .range(from, to)
          .overrideTypes<{ driver_id: string | null; cod_collected_amount: number | null }[]>()
    ),
    readAllRows<{ leg: CashHandoverLeg; amount: number; from_user: string | null }>(
      (from, to) =>
        supabase
          .from("cod_handovers")
          .select("leg, amount, from_user")
          .order("id")
          .range(from, to)
          .overrideTypes<
            { leg: CashHandoverLeg; amount: number; from_user: string | null }[]
          >()
    ),
    supabase
      .from("profiles")
      .select("id, full_name")
      .eq("role", "driver")
      .overrideTypes<{ id: string; full_name: string | null }[]>(),
  ]);

  if (collectedRows.error) throw collectedRows.error;
  if (handoverRows.error) throw handoverRows.error;
  if (riderRows.error) throw riderRows.error;

  const riderNames = new Map(
    (riderRows.data ?? []).map((r) => [r.id, r.full_name?.trim() || "Rider"])
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
  let unattributedHandedToManager = 0;
  let totalHandedToManager = 0;
  let totalHandedToOwner = 0;
  for (const row of handoverRows.data) {
    if (row.leg === "rider_to_manager") {
      totalHandedToManager += row.amount;
      if (row.from_user) {
        handedByRider.set(row.from_user, (handedByRider.get(row.from_user) ?? 0) + row.amount);
      } else {
        unattributedHandedToManager += row.amount;
      }
    } else {
      totalHandedToOwner += row.amount;
    }
  }

  const riderIds = new Set([...collectedByRider.keys(), ...handedByRider.keys()]);
  const byRider: RiderCodOutstanding[] = [...riderIds].map((riderId) => {
    const collected = collectedByRider.get(riderId) ?? 0;
    const handedToManager = handedByRider.get(riderId) ?? 0;
    return {
      riderId,
      riderName: riderNames.get(riderId) ?? "Former rider",
      collected,
      handedToManager,
      outstanding: collected - handedToManager,
    };
  });
  byRider.sort((a, b) => b.outstanding - a.outstanding);

  return {
    totalCollected,
    totalHandedToManager,
    totalHandedToOwner,
    outstandingWithRiders: totalCollected - totalHandedToManager,
    outstandingWithManagers: totalHandedToManager - totalHandedToOwner,
    byRider,
    unattributedCollected,
    unattributedHandedToManager,
  };
}
