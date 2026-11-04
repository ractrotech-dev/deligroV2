import Link from "next/link";
import { FactList, MetricRow, Panel, StatusText, type MetricItem } from "@/components/admin/console";
import {
  isDraftStale,
  listSettlements,
  listVendorSettlementQueue,
  type SettlementListItem,
} from "@/lib/data-access/admin-settlements";
import type { VendorDetail } from "@/lib/data-access/admin-vendors";
import { CYCLE_LABEL, CYCLE_NOTE } from "@/lib/settlements/cycle";
import { Row, rupees } from "./vendor-fields";
import { PaymentHistory, SettleNow, type OpenDraft } from "./shop-settlement";

const HISTORY_LIMIT = 20;

/** Same rule the settlements queue uses, so "incomplete" never disagrees between the two screens. */
function hasPayoutDetails(v: VendorDetail): boolean {
  return Boolean(
    v.upiId?.trim() || (v.bankAccountNumber?.trim() && v.bankIfsc?.trim())
  );
}

/**
 * A yes/no fact about a shop. A dot and a word rather than a tinted capsule: green
 * is reserved for things that are going well, and "no" is not going badly.
 */
function YesNo({ value }: Readonly<{ value: boolean }>) {
  return (
    <StatusText tone={value ? "green" : "neutral"}>
      {value ? "Yes" : "No"}
    </StatusText>
  );
}

/**
 * What this shop is owed, its payments so far and whether any is out of date. One read
 * for the whole block: if it fails, the screen says so rather than showing ₹0 owed.
 * The caller has passed requireRole("admin"); these reads use the service role.
 */
async function loadSettlement(restaurantId: string) {
  try {
    const [queue, history] = await Promise.all([
      listVendorSettlementQueue(),
      listSettlements(HISTORY_LIMIT, restaurantId),
    ]);
    const drafts: OpenDraft[] = await Promise.all(
      history
        .filter((p: SettlementListItem) => p.status === "draft")
        .map(async (p) => {
          const check = await isDraftStale(p.id);
          return { id: p.id, stored: p.netPayable, fresh: check.freshNet, stale: check.stale };
        })
    );
    return {
      row: queue.rows.find((r) => r.restaurantId === restaurantId) ?? null,
      partial: queue.truncated,
      history,
      drafts,
    };
  } catch {
    return null;
  }
}

/** How this shop takes money and how it is paid. Laid out as the Overview tab is. */
export async function PaymentTab({ v, id }: Readonly<{ v: VendorDetail; id: string }>) {
  const settlement = await loadSettlement(id);
  const hasBank = Boolean(v.bankAccountName || v.bankName || v.bankAccountNumber || v.bankIfsc);

  const terms: MetricItem[] = [
    {
      label: "Commission",
      value: `${v.effectiveCommissionPct}%`,
      note: v.inheritsPlatformRate ? "Platform rate" : "This shop's rate",
    },
    {
      label: "Settlement",
      value: CYCLE_LABEL[v.settlementCycle],
      note: CYCLE_NOTE[v.settlementCycle],
    },
    {
      label: "Cash limit per order",
      value: v.codMaxOrder > 0 ? rupees(v.codMaxOrder) : "Platform limit",
      note: v.codMaxOrder > 0 ? "Above this, customers pay online" : "No limit set for this shop",
    },
    {
      label: "Other charges",
      value: v.otherChargesPerOrder > 0 ? rupees(v.otherChargesPerOrder) : "None",
      note: "Per delivered order",
    },
  ];

  return (
    <div className="space-y-4">
      {!hasPayoutDetails(v) ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--c-r)] border border-deal/25 bg-deal/5 px-4 py-3 text-sm">
          <span className="font-semibold text-deal">
            Bank details incomplete.
          </span>
          <span className="text-muted">
            Payouts settle to nothing until a UPI ID or bank account is added.
          </span>
          <Link
            href={`/admin/vendors/${id}/edit`}
            className="ml-auto text-xs font-semibold text-accent-ink"
          >
            Add bank account
          </Link>
        </div>
      ) : null}

      {settlement ? (
        <SettleNow shopName={v.name} row={settlement.row} drafts={settlement.drafts} partial={settlement.partial} />
      ) : (
        <p role="alert" className="rounded-[var(--c-r)] border border-deal/25 bg-deal/5 px-4 py-3 text-[13px] font-medium text-deal">
          Settlements couldn&apos;t be loaded. Reload the page to try again.
        </p>
      )}

      <MetricRow items={terms} />

      <div className="grid grid-cols-2 gap-4">
        <Panel title="Customer payments">
          <FactList>
            <Row label="Cash on delivery" value={<YesNo value={v.acceptCod} />} />
            <Row label="Online payment" value={<YesNo value={v.acceptOnline} />} />
          </FactList>
        </Panel>

        <Panel title="Payout destination">
          {v.upiId ? (
            <div className="flex items-center gap-3 rounded-lg bg-surface-2 p-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-sm font-bold text-accent">
                ₹
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-data truncate text-[13.5px] font-bold">
                  {v.upiId}
                </p>
                <p className="text-[11px] text-muted">
                  UPI · primary payout method
                </p>
              </div>
            </div>
          ) : null}
          {/* Four rows of dashes read as something broken, when a UPI ID alone is enough. */}
          {hasBank ? (
            <FactList className={v.upiId ? "mt-2" : undefined}>
              <Row label="Account name" value={v.bankAccountName} />
              <Row label="Bank" value={v.bankName} />
              <Row label="Account no." value={v.bankAccountNumber} />
              <Row label="IFSC" value={v.bankIfsc} />
            </FactList>
          ) : (
            <p className="mt-2 text-[12px] text-muted">No bank account added.</p>
          )}
        </Panel>
      </div>

      {settlement ? <PaymentHistory rows={settlement.history} limit={HISTORY_LIMIT} /> : null}
    </div>
  );
}
