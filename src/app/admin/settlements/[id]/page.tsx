import { notFound } from "next/navigation";
import {
  Fact,
  FactList,
  PageHeader,
  Panel,
  Section,
  SectionCol,
  SectionRow,
  StatusBadge,
  type Tone,
} from "@/components/admin/console";
import {
  OrderPayoutBreakdown,
  PayoutLinesTable,
  PayoutTotals,
} from "@/components/admin/payout-breakdown";
import {
  getSettlement,
  type SettlementStatus,
} from "@/lib/data-access/admin-settlements";
import { formatINR } from "@/lib/utils/format";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { ConsoleOnly } from "@/components/admin/console-only";
import { SettlementActions } from "./settlement-actions";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<SettlementStatus, Tone> = {
  draft: "amber",
  paid: "green",
  void: "neutral",
};

const STATUS_LABEL: Record<SettlementStatus, string> = {
  draft: "Draft",
  paid: "Paid",
  void: "Void",
};

export default async function SettlementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isSupabaseConfigured) notFound();

  const { id } = await params;
  let settlement;
  try {
    settlement = await getSettlement(id);
  } catch {
    notFound();
  }
  if (!settlement) notFound();

  const owes = settlement.netPayable < 0;
  const payout = settlement.payout;

  return (
    <>
      <PageHeader
        title={settlement.restaurantName}
        description={settlement.periodLabel}
        back={{ href: "/admin/settlements", label: "Settlements" }}
        status={
          <StatusBadge tone={STATUS_TONE[settlement.status]}>
            {STATUS_LABEL[settlement.status]}
          </StatusBadge>
        }
        actions={
          <div className="text-right">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">
              {owes ? "Vendor owes" : "Net payable"}
            </p>
            <p
              className={`text-data mt-1 text-[22px] font-bold leading-none tracking-[-0.025em] tabular-nums ${owes ? "text-deal" : "text-ink"}`}
            >
              {formatINR(Math.abs(settlement.netPayable))}
            </p>
          </div>
        }
      />

      {settlement.kind === "instant" ? (
        <p className="rounded-[var(--c-r)] border border-line bg-surface-2 px-3.5 py-2.5 text-[12px] leading-relaxed text-muted">
          Early payout for a single order, made ahead of this shop&apos;s normal
          cycle. It is excluded from the next settlement automatically, so it
          cannot be paid twice.
        </p>
      ) : null}

      <SectionRow>
        <SectionCol grow={1.3} basis={340}>
          <Panel title="How this payout was worked out">
            <PayoutTotals
              totals={{
                foodGross: settlement.foodGross,
                commission: settlement.commission,
                commissionGst: settlement.commissionGst,
                otherCharges: settlement.otherCharges,
                refundsRecovered: settlement.refundsRecovered,
                netPayable: settlement.netPayable,
              }}
              commissionPct={payout.commissionPct}
              commissionGstPct={payout.commissionGstPct}
              orderCount={settlement.orderCount}
              mismatch={settlement.mismatch}
            />
          </Panel>
        </SectionCol>

        <SectionCol basis={280}>
          <Section
            flush
            title="Where the money goes"
            description="The rates shown are what this shop is on today. The rupee figures beside them are the snapshot taken when this settlement was built — changing a rate never rewrites a payout that already exists."
          >
            <FactList>
              <Fact label="UPI">{payout.upiId ?? "—"}</Fact>
              <Fact label="Account name">{payout.bankAccountName ?? "—"}</Fact>
              <Fact label="Account no.">
                <span className="text-data">
                  {payout.bankAccountNumber ?? "—"}
                </span>
              </Fact>
              <Fact label="IFSC">
                <span className="text-data">{payout.bankIfsc ?? "—"}</span>
              </Fact>
              <Fact label="Bank">{payout.bankName ?? "—"}</Fact>
              <Fact label="Commission">{payout.commissionPct}%</Fact>
              {settlement.paymentRef ? (
                <Fact label="UTR / ref">
                  <span className="text-data font-medium text-ink">
                    {settlement.paymentRef}
                  </span>
                </Fact>
              ) : null}
              {settlement.notes ? (
                <Fact label="Notes">{settlement.notes}</Fact>
              ) : null}
            </FactList>
          </Section>
        </SectionCol>
      </SectionRow>

      {/* Console-only: marking a payout paid means typing a UTR against a money
          transfer, and a phone keyboard is the wrong place to get that right.
          Reading the statement is exactly what a phone is for, so it stays. */}
      {settlement.status === "draft" ? (
        <ConsoleOnly
          tool="Settling a payout"
          why="Recording a UTR or voiding a batch moves real money, and a phone keyboard is the wrong place to get a reference number right. The statement below reads fine here."
        >
          <SettlementActions
            id={settlement.id}
            netPayable={settlement.netPayable}
          />
        </ConsoleOnly>
      ) : null}

      {settlement.lines.length === 1 ? (
        <Panel
          title={`Order ${settlement.lines[0].code}`}
          className="admin-measure"
        >
          <OrderPayoutBreakdown
            line={settlement.lines[0]}
            commissionPct={payout.commissionPct}
            commissionGstPct={payout.commissionGstPct}
          />
        </Panel>
      ) : settlement.lines.length > 1 ? (
        <Section title="Orders in this batch" meta={`${settlement.lines.length}`}>
          <PayoutLinesTable lines={settlement.lines} />
        </Section>
      ) : settlement.status === "void" ? (
        <p className="c-empty">
          Voided — order lines were released so they can be settled again. The
          header totals above are the snapshot from when the draft was created.
        </p>
      ) : null}
    </>
  );
}
