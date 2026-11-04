"use client";

import { useState } from "react";
import { useFeatures } from "@/components/features/features-provider";
import Link from "next/link";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleDashed,
  Clock,
  ExternalLink,
  IndianRupee,
  Mail,
  MapPin,
  Pencil,
  Phone,
  ShieldCheck,
  Sparkles,
  Star,
  Store,
  UtensilsCrossed,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/roles/role-ui";
import { LivePulse } from "@/components/vendor/vendor-ui";
import { RestaurantOpenToggle } from "@/components/vendor/restaurant-open-toggle";
import { RestaurantSwitcher } from "@/components/vendor/restaurant-switcher";
import { VendorStoreEditSheet } from "@/components/vendor/vendor-store-edit-sheet";
import { formatINR } from "@/lib/utils/format";
import type { VendorProfileSummary } from "@/lib/data-access/vendor-profile";

function priceLabel(tier: number) {
  return "₹".repeat(Math.min(3, Math.max(1, tier)));
}

function storeSince(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
  });
}

function CompletenessRing({ score }: { score: number }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  const offset = c - (score / 100) * c;
  return (
    <div className="relative grid size-12 place-items-center">
      <svg className="size-12 -rotate-90" viewBox="0 0 44 44" aria-hidden>
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          stroke="var(--line)"
          strokeWidth="4"
        />
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className="vendor-profile-ring"
        />
      </svg>
      <span className="absolute text-[11px] font-bold tabular-nums">{score}%</span>
    </div>
  );
}

function Fact({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-label">{label}</p>
        <p className="mt-0.5 text-sm font-semibold leading-snug">{value}</p>
      </div>
    </div>
  );
}

function QuickLink({
  href,
  label,
  hint,
}: {
  href: string;
  label: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="vendor-profile-link press group flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5"
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        <p className="mt-0.5 text-xs text-muted">{hint}</p>
      </div>
      <ArrowUpRight className="size-4 shrink-0 text-muted transition group-hover:text-accent" />
    </Link>
  );
}

export function VendorProfileView({
  profile,
  live,
}: {
  profile: VendorProfileSummary;
  live: boolean;
}) {
  // Admin → Feature access.
  const features = useFeatures();
  const canEditShop = features["vendor.shop_profile"];
  const [editing, setEditing] = useState(false);
  const r = profile.restaurant;
  const since = r ? storeSince(r.createdAt) : null;
  const completionTone =
    profile.completeness.score >= 85
      ? "green"
      : profile.completeness.score >= 50
        ? "accent"
        : "muted";

  return (
    <div className="vendor-profile flex min-w-0 flex-col gap-[18px]">
      {/* Full-bleed storefront hero */}
      <section className="vendor-profile-hero relative isolate overflow-hidden rounded-[var(--radius-sheet)]">
        {r?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={r.imageUrl}
            alt=""
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <div
            className={`absolute inset-0 bg-gradient-to-br ${
              r?.accentTint || "from-[var(--accent)] to-[color-mix(in_srgb,var(--accent)_45%,var(--ink))]"
            }`}
          />
        )}
        <div className="vendor-profile-hero-veil absolute inset-0" />
        <div className="relative flex min-h-[280px] flex-col justify-end p-5 sm:min-h-[320px] sm:p-7">
          <div className="mb-auto flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {live && r?.isOpen ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur-sm">
                  <LivePulse />
                  Accepting orders
                </span>
              ) : null}
              {r?.approved ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur-sm">
                  <ShieldCheck className="size-3" />
                  Approved
                </span>
              ) : r ? (
                <span className="rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-bold text-white/90 backdrop-blur-sm">
                  Pending approval
                </span>
              ) : null}
              {r?.promoted ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur-sm">
                  <Sparkles className="size-3" />
                  Promoted
                </span>
              ) : null}
            </div>
            {r && canEditShop ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-white/40 bg-white/15 text-white backdrop-blur-sm hover:bg-white/25 hover:text-white"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-3.5" />
                Edit
              </Button>
            ) : null}
          </div>

          <div className="animate-fade-in max-w-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
              Storefront
            </p>
            <h1 className="text-display mt-1 text-3xl font-bold leading-[1.05] tracking-tight text-white sm:text-4xl lg:text-5xl">
              {r?.name ?? "No restaurant linked"}
            </h1>
            {r?.tagline ? (
              <p className="mt-2 max-w-xl text-sm text-white/85 sm:text-base">
                {r.tagline}
              </p>
            ) : r ? (
              <p className="mt-2 text-sm text-white/65">
                Add a tagline so customers know your vibe.
              </p>
            ) : (
              <p className="mt-2 text-sm text-white/80">
                Ask Deligro admin to link your restaurant account.
              </p>
            )}

            {r ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <RestaurantOpenToggle isOpen={r.isOpen} onPhoto />
                {r.cuisines.slice(0, 4).map((c) => (
                  <span
                    key={c}
                    className="rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm"
                  >
                    {c}
                  </span>
                ))}
                {r.cuisines.length > 4 ? (
                  <span className="text-[11px] font-semibold text-white/70">
                    +{r.cuisines.length - 4}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {r && profile.completeness.missing.length > 0 ? (
        <section className="vendor-profile-panel animate-slide-up flex flex-col gap-4 rounded-[var(--radius-block)] border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="flex items-center gap-3">
            <CompletenessRing score={profile.completeness.score} />
            <div>
              <p className="text-sm font-bold">Storefront checklist</p>
              <p className="mt-0.5 text-xs text-muted">
                Complete these to look polished on the customer app.
              </p>
            </div>
          </div>
          <ul className="flex flex-wrap gap-2">
            {profile.completeness.missing.map((item) => (
              <li key={item}>
                <button
                  type="button"
                  disabled={!canEditShop}
                  onClick={() => setEditing(true)}
                  className="press inline-flex items-center gap-1.5 rounded-full border border-dashed border-line bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-muted"
                >
                  <CircleDashed className="size-3" />
                  {item}
                </button>
              </li>
            ))}
          </ul>
          <Pill tone={completionTone}>{profile.completeness.score}% ready</Pill>
        </section>
      ) : r ? (
        <section className="vendor-profile-panel animate-slide-up flex items-center gap-3 rounded-[var(--radius-block)] border border-green/25 bg-green/5 px-4 py-3">
          <CheckCircle2 className="size-5 shrink-0 text-green" />
          <p className="text-sm font-medium text-green">
            Storefront looks complete — customers see a polished listing.
          </p>
        </section>
      ) : null}

      {r ? (
        <>
          {/* Snapshot metrics */}
          <section className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
            {[
              ...(features["vendor.reviews"]
                ? [
                    {
                      label: "Rating",
                      value: r.rating.toFixed(1),
                      hint: `${r.ratingCount} ratings · ${r.reviewCount} reviews`,
                    },
                  ]
                : []),
              {
                label: "Orders",
                value: String(profile.stats.totalOrders),
                hint: `${profile.stats.activeOrders} active now`,
              },
              {
                label: "Delivered",
                value: String(profile.stats.deliveredOrders),
                hint: `${profile.stats.cancelledOrders} cancelled`,
              },
              ...(features["vendor.earnings"]
                ? [
                    {
                      label: "Lifetime sales",
                      value: formatINR(profile.stats.lifetimeRevenue),
                      hint: `${profile.stats.menuAvailable}/${profile.stats.menuItems} dishes live`,
                    },
                  ]
                : []),
            ].map((m, i) => (
              <div
                key={m.label}
                className="vendor-profile-stat animate-fade-in rounded-[var(--radius-block)] border border-line bg-surface p-4"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <p className="text-label">{m.label}</p>
                <p className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">
                  {m.value}
                </p>
                <p className="mt-1 text-[11px] text-muted">{m.hint}</p>
              </div>
            ))}
          </section>

          <div className="grid gap-4 @3xl:grid-cols-[1.4fr_1fr] @3xl:gap-6">
            {/* Listing details */}
            <section className="vendor-profile-panel space-y-5 rounded-[var(--radius-block)] border border-line bg-surface p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold">Listing details</h2>
                  <p className="mt-0.5 text-sm text-muted">
                    What customers see on Deligro.
                  </p>
                </div>
                {canEditShop ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing(true)}
                  >
                    <Pencil className="size-3.5" />
                    Edit
                  </Button>
                ) : null}
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                {features["vendor.reviews"] ? (
                <Fact
                  icon={Star}
                  label="Customer rating"
                  value={
                    <span className="inline-flex items-center gap-1.5">
                      <Star className="size-3.5 fill-accent text-accent" />
                      {r.rating.toFixed(1)}
                      <span className="font-normal text-muted">
                        ({r.ratingCount})
                      </span>
                    </span>
                  }
                />
                ) : null}
                <Fact
                  icon={Clock}
                  label="Delivery ETA"
                  value={
                    r.etaMin != null && r.etaMax != null
                      ? `${r.etaMin}–${r.etaMax} min`
                      : "Not set"
                  }
                />
                <Fact
                  icon={IndianRupee}
                  label="Price · cost for two"
                  value={
                    <>
                      {priceLabel(r.priceTier)}
                      {r.costForTwo != null
                        ? ` · ${formatINR(r.costForTwo)}`
                        : ""}
                    </>
                  }
                />
                <Fact
                  icon={UtensilsCrossed}
                  label="Cuisines"
                  value={
                    r.cuisines.length > 0 ? r.cuisines.join(" · ") : "Add cuisines"
                  }
                />
                {/* Derived from this shop's promo codes since 0041 — the row
                    links to where it is actually set, because there is nowhere
                    else to type it any more. */}
                <Fact
                  icon={Sparkles}
                  label="Promo offer"
                  value={
                    features["vendor.promotions"] ? (
                      <Link
                        href="/vendor/promotions"
                        className="inline-flex items-center gap-1 text-accent"
                      >
                        {r.offer?.trim() || "Run a promotion"}
                        <ExternalLink className="size-3.5" />
                      </Link>
                    ) : (
                      r.offer?.trim() || "—"
                    )
                  }
                />
                <Fact
                  icon={MapPin}
                  label="Public page"
                  value={
                    live ? (
                      <Link
                        href={`/restaurant/${r.slug}`}
                        className="inline-flex items-center gap-1 text-accent"
                      >
                        /restaurant/{r.slug}
                        <ExternalLink className="size-3.5" />
                      </Link>
                    ) : (
                      `/${r.slug}`
                    )
                  }
                />
              </div>

              {since ? (
                <p className="border-t border-line pt-4 text-xs text-muted">
                  Listed on Deligro since {since}
                  {r.promoted ? " · Featured placement active" : ""}
                </p>
              ) : null}
            </section>

            {/* Owner + stores */}
            <div className="space-y-4">
              <section className="vendor-profile-panel space-y-4 rounded-[var(--radius-block)] border border-line bg-surface p-5">
                <div className="flex items-center gap-3">
                  <span className="grid size-12 place-items-center rounded-2xl bg-accent/12 text-sm font-bold text-accent">
                    {profile.initials}
                  </span>
                  <div className="min-w-0">
                    <h2 className="truncate font-bold">{profile.ownerName}</h2>
                    <p className="text-xs text-muted">
                      Owner · since {profile.memberSince}
                    </p>
                  </div>
                </div>
                <div className="space-y-3 border-t border-line pt-4">
                  {profile.ownerEmail ? (
                    <div className="flex items-center gap-3 text-sm">
                      <Mail className="size-4 shrink-0 text-muted" />
                      <span className="truncate">{profile.ownerEmail}</span>
                    </div>
                  ) : null}
                  {profile.ownerPhone ? (
                    <a
                      href={`tel:${profile.ownerPhone.replace(/\s/g, "")}`}
                      className="flex items-center gap-3 text-sm text-accent"
                    >
                      <Phone className="size-4 shrink-0" />
                      {profile.ownerPhone}
                    </a>
                  ) : null}
                  <div className="flex items-center gap-3 text-sm">
                    <Store className="size-4 shrink-0 text-muted" />
                    <span>
                      {profile.ownedRestaurants.length} store
                      {profile.ownedRestaurants.length === 1 ? "" : "s"} linked
                    </span>
                  </div>
                </div>
                {profile.ownedRestaurants.length > 1 ? (
                  <div className="border-t border-line pt-4">
                    <p className="mb-2 text-label">Active store</p>
                    <RestaurantSwitcher
                      restaurants={profile.ownedRestaurants}
                      activeSlug={r.slug}
                      fullWidth
                    />
                  </div>
                ) : null}
              </section>

              <section className="space-y-2">
                <QuickLink
                  href="/vendor/menu"
                  label="Menu"
                  hint={`${profile.stats.menuItems} items · manage dishes`}
                />
                <QuickLink
                  href="/vendor"
                  label="Orders"
                  hint={`${profile.stats.activeOrders} in the kitchen`}
                />
                {features["vendor.earnings"] ? (
                  <QuickLink
                    href="/vendor/earnings"
                    label="Earnings"
                    hint="Settlements & sales trends"
                  />
                ) : null}
                {features["vendor.shop_profile"] ? (
                  <QuickLink
                    href="/vendor/settings"
                    label="Settings"
                    hint="Where your shop sits on the map"
                  />
                ) : null}
                {live ? (
                  <QuickLink
                    href={`/restaurant/${r.slug}`}
                    label="Customer preview"
                    hint="See your public restaurant page"
                  />
                ) : null}
              </section>
            </div>
          </div>
        </>
      ) : (
        <section className="rounded-[var(--radius-block)] border border-dashed border-line bg-surface p-8 text-center">
          <Store className="mx-auto size-8 text-muted" />
          <p className="mt-3 font-semibold">No restaurant linked</p>
          <p className="mt-1 text-sm text-muted">
            Once admin assigns a store, your storefront profile will appear
            here.
          </p>
        </section>
      )}

      <p className="flex items-center justify-center gap-1.5 px-2 text-center text-xs text-muted">
        <ShieldCheck className="size-3.5 shrink-0" />
        Bank, GST, and legal entity details are managed by Deligro admin.
      </p>

      {r && editing ? (
        <VendorStoreEditSheet
          open={editing}
          restaurant={r}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}
