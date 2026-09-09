import Link from "next/link";
import {
  StatusText,
  type Tone,
} from "@/components/admin/console";
import { Plus, TicketPercent } from "lucide-react";
import {
  listPromotions,
  promotionsBackendReady,
  PromotionsNotMigratedError,
  type Promotion,
} from "@/lib/data-access/promotions";
import { AdminHero, EmptyState, PreviewNotice } from "@/components/admin/admin-ui";
import { StatTile, StatTiles } from "@/components/admin/console-ui";
import { formatINR } from "@/lib/utils/format";
import { offerBadgeText } from "@/lib/promotion-rules";
import { CouponRowActions } from "./coupon-row-actions";

/**
 * Admin → Promo codes.
 *
 * Until 0041 there was no screen at all: `coupons` had two demo rows inserted
 * by migration 0006 and the only way to add a third was to write SQL against
 * production. Everything a code can do — a percentage, a ceiling, a minimum,
 * a per-customer limit, an end date, a shop — was already in the schema and
 * enforced at redemption; none of it was reachable.
 */
export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** Live, retired, or simply switched off — as a customer would experience it. */
function statusOf(p: Promotion): { label: string; tone: Tone } {
  if (!p.active) return { label: "Paused", tone: "neutral" };
  if (p.expiresAt && Date.parse(p.expiresAt) < Date.now()) {
    return { label: "Expired", tone: "neutral" };
  }
  if (p.maxRedemptions != null && p.redemptions >= p.maxRedemptions) {
    return { label: "Fully claimed", tone: "amber" };
  }
  return { label: "Live", tone: "green" };
}

export default async function AdminCouponsPage() {
  const backendReady = await promotionsBackendReady();
  let promotions: Promotion[] = [];
  if (backendReady) {
    try {
      promotions = await listPromotions();
    } catch (err) {
      if (!(err instanceof PromotionsNotMigratedError)) throw err;
    }
  }

  const live = promotions.filter((p) => statusOf(p).label === "Live");
  const given = promotions.reduce((sum, p) => sum + p.discountGiven, 0);
  const claimed = promotions.reduce((sum, p) => sum + p.redemptions, 0);
  const vendorFunded = promotions
    .filter((p) => p.fundedBy === "vendor")
    .reduce((sum, p) => sum + p.discountGiven, 0);

  return (
    <>
      <AdminHero
        title="Promo codes"
        tag={live.length > 0 ? `${live.length} live` : "None live"}
        subtitle="Every code a customer can type at checkout"
        action={
          <Link href="/admin/coupons/new" className="c-btn c-btn-dark press">
            <Plus className="size-3.5" strokeWidth={2.4} /> New code
          </Link>
        }
      />

      {!backendReady ? (
        <PreviewNotice>
          Preview mode — apply{" "}
          <code className="rounded bg-surface-2 px-1 text-xs">
            0041_vendor_coupons.sql
          </code>{" "}
          to scope codes to a shop and record who funds them.
        </PreviewNotice>
      ) : null}

      {promotions.length === 0 ? (
        <EmptyState
          icon={TicketPercent}
          title="No promo codes yet"
          description="Create one and customers can type it at checkout. A code scoped to a shop also becomes that shop's offer badge."
          action={
            <Link href="/admin/coupons/new" className="c-btn c-btn-dark press">
              <Plus className="size-3.5" strokeWidth={2.4} /> New code
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3.5">
            {promotions.map((p) => (
              <CouponCard key={p.code} promotion={p} />
            ))}
          </div>

          <StatTiles>
            <StatTile
              label="Live now"
              value={live.length}
              note={`Of ${promotions.length} code${promotions.length === 1 ? "" : "s"}`}
            />
            <StatTile label="Times claimed" value={claimed} note="Across all codes" />
            <StatTile
              label="Given away"
              value={formatINR(given)}
              note="Off customer bills"
            />
            <StatTile
              label="Funded by shops"
              value={formatINR(vendorFunded)}
              note={`${formatINR(given - vendorFunded)} funded by Deligro`}
            />
          </StatTiles>
        </>
      )}
    </>
  );
}

function CouponCard({ promotion: p }: { promotion: Promotion }) {
  const status = statusOf(p);
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-[17px] py-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-[15px] font-bold tracking-[0.06em]">
            {p.code}
          </h2>
          <p className="mt-0.5 truncate text-xs text-muted">
            {p.label ?? offerBadgeText(p)}
            {" · "}
            {p.restaurantName ?? "Every shop"}
          </p>
        </div>
        <StatusText tone={status.tone} className="shrink-0">
          {status.label}
        </StatusText>
      </div>

      <dl className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
        <Figure label="Takes off" value={offerBadgeText(p)} />
        <Figure
          label="Claimed"
          value={
            p.maxRedemptions != null
              ? `${p.redemptions} / ${p.maxRedemptions}`
              : String(p.redemptions)
          }
        />
        <Figure label="Given" value={formatINR(p.discountGiven)} />
        <Figure label="Funded by" value={p.fundedBy === "vendor" ? "The shop" : "Deligro"} />
      </dl>

      <div className="flex items-center justify-between gap-2 border-t border-[color:var(--c-divider)] pt-3">
        <p className="min-w-0 truncate text-[11.5px] text-muted">
          {p.expiresAt ? `Until ${dateFmt.format(new Date(p.expiresAt))}` : "No end date"}
          {p.maxPerCustomer != null
            ? ` · ${p.maxPerCustomer} per customer`
            : " · unlimited per customer"}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href={`/admin/coupons/${encodeURIComponent(p.code)}`}
            className="c-btn-affirm press"
          >
            Edit
          </Link>
          <CouponRowActions code={p.code} active={p.active} />
        </div>
      </div>
    </article>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dd className="truncate text-[13px] font-bold leading-none text-ink">{value}</dd>
      <dt className="mt-1 truncate text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">
        {label}
      </dt>
    </div>
  );
}
