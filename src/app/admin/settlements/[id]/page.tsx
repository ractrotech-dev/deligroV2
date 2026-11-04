import { PAYMENT_STATUS_LABEL } from "../payment-status";
import { requireRole } from "@/lib/auth";
import { notFound } from "next/navigation";
import { captureError } from "@/lib/obs/emit";
import {
  PageHeader,
  Section,
  SectionCol,
  SectionRow,
  StatusBadge,
  type Tone,
} from "@/components/admin/console";
import {
  PayFigure,
  PayoutLinesTable,
  PayoutTotals,
  PayToList,
} from "@/components/admin/payout-breakdown";
import {
  getSettlement,
  type SettlementStatus,
} from "@/lib/data-access/admin-settlements";
import { oldCashRuleShortfall } from "@/lib/settlements/math";
import { formatINR } from "@/lib/utils/format";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { SettlementActions } from "./settlement-actions";
import { ReversalActions } from "./reversal-actions";
import { adminMayApproveOwn, pendingRequestFor } from "@/lib/data-access/settlement-requests";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<SettlementStatus, Tone> = {
  draft: "amber",
  paid: "green",
  void: "neutral",
};

const STATUS_LABEL = PAYMENT_STATUS_LABEL;

/** One payment: how much, where it goes, what to do next, and the orders in it. */
export default async function SettlementDetailPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ id: string }>;
  searchParams: Promise<{ changed?: string }>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  const admin = await requireRole("admin");

  if (!isSupabaseConfigured) notFound();

  const { id } = await params;
  const { changed } = await searchParams;
  let settlement;
  let pendingRequest: Awaited<ReturnType<typeof pendingRequestFor>> = null;
  let mayApproveOwn = false;
  try {
    [settlement, pendingRequest, mayApproveOwn] = await Promise.all([getSettlement(id), pendingRequestFor(id), adminMayApproveOwn(admin.id)]);
  } catch (e) {
    captureError(e, { source: "admin-settlements/detail", attrs: { event: "settlement_read_failed", settlementId: id } });
    return (
      <>
        <PageHeader title="Payment" back={{ href: "/admin/settlements", label: "Settlements" }} />
        <p className="text-[13px] font-medium text-deal">
          Could not load this payment. Refresh to try again.
        </p>
      </>
    );
  }
  if (!settlement) notFound();

  const payout = settlement.payout;
  const shop = settlement.restaurantName;

  let title: string | undefined;
  if (settlement.status === "paid") title = `Paid to ${shop}`;
  if (settlement.status === "void") title = `Cancelled payment to ${shop}`;

  const orders = `For ${settlement.orderCount} order${settlement.orderCount === 1 ? "" : "s"}, ${settlement.periodLabel}.`;

  // Old refunds on earlier, already-paid orders, taken back in this payment.
  const linesTotal = settlement.lines.reduce((sum, l) => sum + l.contribution, 0);
  const corrections = settlement.lines.length
    ? Math.max(0, linesTotal - settlement.netPayable - settlement.mismatch)
    : 0;
  const shortfall =
    settlement.status === "paid" ? oldCashRuleShortfall(settlement.lines) : 0;

  return (
    <>
      <PageHeader
        title={shop}
        back={{ href: "/admin/settlements", label: "Settlements" }}
        status={
          <StatusBadge tone={STATUS_TONE[settlement.status]}>
            {STATUS_LABEL[settlement.status]}
          </StatusBadge>
        }
      />

      {changed && settlement.status === "draft" ? (
        <p className="text-[13px] font-medium text-[color:var(--c-ink-amber)]">
          An adjustment changed the amount, so this is the payment now. Check it, then pay.
        </p>
      ) : null}

      {shortfall > 0 ? (
        <p className="text-[13px] font-medium text-deal">
          This payment used the old cash rule, so the shop got{" "}
          <span className="text-data font-semibold tabular-nums">
            {formatINR(shortfall)}
          </span>{" "}
          less than it should have.
        </p>
      ) : null}

      <SectionRow>
        <SectionCol basis={340}>
          <PayFigure
            shop={shop}
            title={title}
            amount={settlement.netPayable}
            note={orders}
          />
          {settlement.paymentRef ? (
            <p className="mt-2 text-[12.5px] text-muted">
              Payment reference{" "}
              <span className="text-data font-medium text-ink">
                {settlement.paymentRef}
              </span>
            </p>
          ) : null}
          {settlement.notes ? (
            <p className="mt-2 text-[12.5px] text-muted">{settlement.notes}</p>
          ) : null}
          <div className="mt-4">
            {settlement.status === "draft" ? (
              <SettlementActions
                id={settlement.id}
                netPayable={settlement.netPayable}
                pendingRequest={pendingRequest}
                viewerId={admin.id}
                mayApproveOwn={mayApproveOwn}
              />
            ) : null}
            {settlement.status === "paid" ? (
              <ReversalActions
                id={settlement.id}
                pendingRequest={pendingRequest}
                viewerId={admin.id}
                mayApproveOwn={mayApproveOwn}
              />
            ) : null}
          </div>
        </SectionCol>

        {settlement.status === "draft" ? (
          <SectionCol basis={300}>
            <Section flush title="Send it to">
              <PayToList payout={payout} />
            </Section>
          </SectionCol>
        ) : null}

        <SectionCol basis={300}>
          <Section flush title={`How we got ${formatINR(Math.abs(settlement.netPayable))}`}>
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
              corrections={corrections}
              mismatch={settlement.mismatch}
            />
          </Section>
        </SectionCol>
      </SectionRow>

      {settlement.lines.length > 0 ? (
        <Section title="Orders">
          <PayoutLinesTable
            lines={settlement.lines}
            commissionPct={payout.commissionPct}
            commissionGstPct={payout.commissionGstPct}
          />
        </Section>
      ) : null}
      {settlement.lines.length === 0 && settlement.status === "void" ? (
        <p className="c-empty">
          This payment was cancelled, so its orders can be paid again.
        </p>
      ) : null}
    </>
  );
}
