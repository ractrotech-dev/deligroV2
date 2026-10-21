import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { BackToBoard } from "@/components/manager/phone-order-composer";
import { formatINR } from "@/lib/utils/format";
import { listRiders, type ManagerRider } from "@/lib/data-access/manager-orders";
import {
  codDaySummary,
  codOutstandingSummary,
  listCodHandovers,
  type CodDaySummary,
  type CodHandoverRow,
  type CodLedgerSummary,
} from "@/lib/data-access/cod-handovers";
import {
  listOperationalExpenses,
  EXPENSE_CATEGORY_LABEL,
  type OperationalExpenseRow,
} from "@/lib/data-access/operational-expenses";
import { CashRecorder } from "@/components/manager/cash-recorder";
import { staffScopeFor } from "@/lib/auth/manager-api.server";
import { citiesInScope, listCitiesWithZones, type CityZones } from "@/lib/data-access/zones";
import { staffFeatureOn } from "@/lib/features/guards.server";
import { FeatureOffNotice } from "@/components/features/features-provider";
import { scopedRiderIds } from "@/lib/data-access/scoped-riders";

export const metadata: Metadata = { title: "Cash & expenses · Deligro" };

/** Today's figures; never served from a cache. */
export const dynamic = "force-dynamic";

/**
 * Manager -> record the cash-on-delivery handover and any small operational
 * spend (EV bike maintenance, charging, rider salary paid outside the app).
 *
 * The physical cash still moves Customer -> Rider -> Manager -> Owner offline
 * — this screen is only the digital record of it, per the confirmed rule that
 * offline execution must never mean an untracked transaction. It does not
 * enforce or block anything: the "today" summary below is shown so a manager
 * can see, at a glance, whether what riders collected roughly matches what
 * has been handed on. Reconciling any gap is still a human judgement call.
 *
 * Platform: BOTH. A manager records a handover standing next to the rider, so
 * the phone shell is the primary one here; nothing on this screen is too wide
 * for it.
 */
export default async function ManagerCashPage() {
  // Switchable in Admin → Feature access; the server actions behind this
  // page check the same switch.
  if (!(await staffFeatureOn("manager.cash"))) return <FeatureOffNotice title="Cash & expenses" />;
  const profile = await requireRole(["manager", "admin"]);
  // Service-role reads below: limited to this person's zones (0141).
  const scope = await staffScopeFor(profile);

  let riders: ManagerRider[] = [];
  let zones: { id: string; label: string }[] = [];
  let summary: CodDaySummary = {
    collectedToday: 0,
    handedToManagerToday: 0,
    handedToOwnerToday: 0,
  };
  let outstanding: CodLedgerSummary | null = null;
  let handovers: CodHandoverRow[] = [];
  let expenses: OperationalExpenseRow[] = [];
  let failed = false;

  if (isSupabaseConfigured) {
    try {
      let cities: CityZones[];
      let riderIds: Set<string> | null;
      [riders, riderIds, summary, outstanding, handovers, expenses, cities] = await Promise.all([
        listRiders(),
        scopedRiderIds(scope),
        codDaySummary(scope),
        codOutstandingSummary(scope),
        listCodHandovers(scope, 20),
        listOperationalExpenses(scope, 20),
        listCitiesWithZones(),
      ]);
      // Only the riders this manager may record cash for (their zones).
      if (riderIds) riders = riders.filter((r) => riderIds!.has(r.id));
      const inScope = citiesInScope(cities, scope);
      zones = inScope.flatMap((c) =>
        c.zones.map((z) => ({ id: z.id, label: inScope.length > 1 ? `${c.name} · ${z.name}` : z.name }))
      );
    } catch {
      failed = true;
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <header className="flex items-center justify-between gap-3 pb-1 pt-1">
        <BackToBoard />
        <p className="text-sm font-semibold text-muted">Cash &amp; expenses</p>
      </header>

      <div className="pb-3">
        <h1 className="text-[23px] font-extrabold tracking-tight">
          Record cash and spend
        </h1>
        <p className="mt-1 text-sm text-muted">
          The cash itself can move by hand. What matters is that it is written
          down here, so nothing financially real is left untracked.
        </p>
      </div>

      {!isSupabaseConfigured ? (
        <p className="rounded-xl border border-pop/40 bg-pop/10 px-3.5 py-3 text-sm font-medium text-ink">
          Demo mode. Connect Supabase and apply migration 0047 to record cash
          and expenses.
        </p>
      ) : null}
      {isSupabaseConfigured && failed ? (
        <p className="rounded-xl border border-red-500/25 bg-red-500/10 px-3.5 py-3 text-sm font-medium text-red-600">
          Could not load this screen. Check migration 0047 is applied.
        </p>
      ) : null}
      {isSupabaseConfigured && !failed ? (
        <>
          <div className="grid grid-cols-3 gap-2.5">
            <SummaryTile label="Collected today" value={summary.collectedToday} />
            <SummaryTile
              label="Handed to manager"
              value={summary.handedToManagerToday}
            />
            <SummaryTile
              label="Handed to owner"
              value={summary.handedToOwnerToday}
            />
          </div>

          <OutstandingCashNote outstanding={outstanding} />

          <div className="mt-5">
            <CashRecorder riders={riders} zones={zones} />
          </div>

          <section className="mt-7">
            <h2 className="text-sm font-bold text-ink">Recent handovers</h2>
            {handovers.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Nothing recorded yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {handovers.map((h) => (
                  <li
                    key={h.id}
                    className="rounded-xl border border-line bg-surface p-3 text-[13px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-ink">
                        {h.leg === "rider_to_manager"
                          ? `${h.fromUserName ?? "Rider"} → ${h.toUserName ?? "Manager"}`
                          : `${h.fromUserName ?? "Manager"} → ${h.toUserName ?? "Owner"}`}
                      </span>
                      <span className="font-semibold text-ink">
                        {formatINR(h.amount)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-muted">
                      {h.handoverDate}
                      {h.note ? ` · ${h.note}` : ""}
                      {h.recordedByName ? ` · recorded by ${h.recordedByName}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mb-8 mt-7">
            <h2 className="text-sm font-bold text-ink">Recent expenses</h2>
            {expenses.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Nothing recorded yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {expenses.map((e) => (
                  <li
                    key={e.id}
                    className="rounded-xl border border-line bg-surface p-3 text-[13px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-ink">
                        {EXPENSE_CATEGORY_LABEL[e.category]}
                        {e.riderName ? ` · ${e.riderName}` : ""}
                      </span>
                      <span className="font-semibold text-ink">
                        {formatINR(e.amount)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-muted">
                      {e.expenseDate}
                      {e.note ? ` · ${e.note}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

/** All-time cash not yet passed up the chain; nothing when the chain is clear. */
function OutstandingCashNote({
  outstanding,
}: Readonly<{ outstanding: CodLedgerSummary | null }>) {
  if (!outstanding) return null;
  const total = outstanding.outstandingWithRiders + outstanding.outstandingWithManagers;
  // NaN-safe: renders nothing for NaN, exactly as `!(total > 0)` did.
  if (Number.isNaN(total) || total <= 0) return null;
  return (
    <p className="mt-2.5 rounded-xl border border-pop/40 bg-pop/10 px-3.5 py-2.5 text-[12.5px] font-medium text-ink">
      {formatINR(outstanding.outstandingWithRiders)} outstanding with
      riders, {formatINR(outstanding.outstandingWithManagers)} with
      managers, all-time. See the full breakdown on the owner&apos;s
      cash ledger.
    </p>
  );
}

function SummaryTile({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <p className="text-data text-[15px] font-bold leading-none text-ink">
        {formatINR(value)}
      </p>
      <p className="text-label mt-1">{label}</p>
    </div>
  );
}
