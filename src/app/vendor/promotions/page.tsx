import Link from "next/link";
import {
  StatusText,
  type Tone,
} from "@/components/admin/console";
import { Plus } from "lucide-react";
import { getProfile } from "@/lib/auth";
import { hasVendorAccess } from "@/lib/auth/vendor-access";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { resolveVendorRestaurant } from "@/lib/data-access/vendor-restaurant";
import {
  listVendorPromotions,
  PromotionsNotMigratedError,
  type Promotion,
} from "@/lib/data-access/promotions";
import {
  VendorPageHeader,
  VendorStatGrid,
} from "@/components/vendor/vendor-page-header";
import { formatINR } from "@/lib/utils/format";
import { offerBadgeText } from "@/lib/promotion-rules";
import { VendorPromotionRowActions } from "./promotion-row-actions";

/**
 * Vendor → Promotions.
 *
 * The shop's own promo codes, and the only way its offer badge gets set. Before
 * 0041 the badge was a free-text field in the store editor: a vendor typed
 * "35% OFF up to ₹120" and customers saw it, with no code behind it and nothing
 * a customer could do with it. Running a promotion and advertising one are the
 * same act now.
 */
export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function statusOf(p: Promotion): { label: string; tone: Tone } {
  if (!p.active) return { label: "Paused", tone: "neutral" };
  if (p.expiresAt && Date.parse(p.expiresAt) < Date.now()) {
    return { label: "Ended", tone: "neutral" };
  }
  if (p.maxRedemptions != null && p.redemptions >= p.maxRedemptions) {
    return { label: "Fully claimed", tone: "amber" };
  }
  return { label: "Live", tone: "green" };
}

function Shell({
  subtitle,
  children,
}: {
  subtitle: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <VendorPageHeader title="Promotions" subtitle={subtitle} />
      {children}
    </div>
  );
}

export default async function VendorPromotionsPage() {
  if (!isSupabaseConfigured) {
    return <Shell subtitle="Connect Supabase to run promotions." />;
  }

  const profile = await getProfile();
  if (!(await hasVendorAccess(profile))) {
    return <Shell subtitle="Restaurant access required." />;
  }

  const restaurant = await resolveVendorRestaurant();
  if (!restaurant) {
    return <Shell subtitle="No shop is linked to this account yet." />;
  }

  let promotions: Promotion[] = [];
  let notMigrated = false;
  try {
    promotions = await listVendorPromotions(restaurant.id);
  } catch (err) {
    if (err instanceof PromotionsNotMigratedError) notMigrated = true;
    else throw err;
  }

  if (notMigrated) {
    return (
      <Shell subtitle="Promotions aren't switched on for this database yet — migration 0041 is pending." />
    );
  }

  const live = promotions.filter((p) => statusOf(p).label === "Live");
  const claimed = promotions.reduce((sum, p) => sum + p.redemptions, 0);
  const given = promotions.reduce((sum, p) => sum + p.discountGiven, 0);

  return (
    <div className="space-y-6">
      <VendorPageHeader
        title="Promotions"
        subtitle={`Promo codes for ${restaurant.name}`}
        action={
          <Link href="/vendor/promotions/new" className="c-btn c-btn-dark press">
            <Plus className="size-3.5" strokeWidth={2.4} /> New code
          </Link>
        }
      />

      <VendorStatGrid
        columns={4}
        items={[
          { label: "Live codes", value: String(live.length) },
          { label: "Times claimed", value: String(claimed) },
          { label: "Given away", value: formatINR(given) },
          {
            label: "Offer badge",
            value: live.length > 0 ? "Showing" : "None",
            tone: live.length > 0 ? "green" : "muted",
          },
        ]}
      />

      {promotions.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-6 text-center">
          <h2 className="text-[15px] font-bold">No promotions yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            Create a code and it does two things: customers can type it at
            checkout, and your shop&rsquo;s card starts showing the offer badge.
            The discount comes out of your item revenue, so set a cap.
          </p>
          <Link
            href="/vendor/promotions/new"
            className="c-btn c-btn-dark press mt-4 inline-flex"
          >
            <Plus className="size-3.5" strokeWidth={2.4} /> New code
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 @3xl:grid-cols-2">
          {promotions.map((p) => {
            const status = statusOf(p);
            return (
              <article
                key={p.code}
                className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-[17px] py-4"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-mono text-[15px] font-bold tracking-[0.06em]">
                      {p.code}
                    </h2>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {p.label ?? offerBadgeText(p)}
                    </p>
                  </div>
                  <StatusText tone={status.tone} className="shrink-0">
                    {status.label}
                  </StatusText>
                </div>

                <dl className="grid grid-cols-3 gap-2">
                  <Figure label="Takes off" value={offerBadgeText(p)} />
                  <Figure
                    label="Claimed"
                    value={
                      p.maxRedemptions != null
                        ? `${p.redemptions} / ${p.maxRedemptions}`
                        : String(p.redemptions)
                    }
                  />
                  <Figure label="Cost to you" value={formatINR(p.discountGiven)} />
                </dl>

                <div className="flex items-center justify-between gap-2 border-t border-[color:var(--c-divider)] pt-3">
                  <p className="min-w-0 truncate text-[11.5px] text-muted">
                    {p.expiresAt
                      ? `Until ${dateFmt.format(new Date(p.expiresAt))}`
                      : "No end date"}
                  </p>
                  <div className="flex shrink-0 items-center gap-2">
                    <Link
                      href={`/vendor/promotions/${encodeURIComponent(p.code)}`}
                      className="c-btn-affirm press"
                    >
                      Edit
                    </Link>
                    <VendorPromotionRowActions code={p.code} active={p.active} />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
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
