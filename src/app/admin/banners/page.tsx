import Link from "next/link";
import {
  StatusText,
  type Tone,
} from "@/components/admin/console";
import { Megaphone, Plus } from "lucide-react";
import { listAllBanners, bannersBackendReady } from "@/lib/banners";
import type { Banner, BannerStatus } from "@/types";
import {
  AdminHero,
  EmptyState,
  PreviewNotice,
} from "@/components/admin/admin-ui";
import { ConsoleOnly } from "@/components/admin/console-only";
import { StatTile, StatTiles } from "@/components/admin/console-ui";
import { PromoBannerCarousel } from "@/components/home/promo-banner-carousel";
import { BannerRowActions } from "./banner-row-actions";

/**
 * Admin → Campaigns. Every banner and sponsored slot, as performance cards.
 *
 * The design's budget bar, reach, redemptions and ROI are not here: banners in
 * this product carry no budget, no coupon link and no spend, so there is
 * nothing to divide or draw a progress track against. What the platform does
 * record — impressions, clicks, click-through and attributed orders — is what
 * the four figures show. A budget bar filled from a number nobody set is a
 * chart of an assumption.
 */
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<BannerStatus, Tone> = {
  active: "green",
  paused: "amber",
  draft: "neutral",
  archived: "neutral",
};

const STATUS_LABEL: Record<BannerStatus, string> = {
  active: "Running",
  paused: "Paused",
  draft: "Draft",
  archived: "Ended",
};

const nf = new Intl.NumberFormat("en-IN");

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
});

/** "12 Aug – 30 Aug", "from 12 Aug", "until 30 Aug", or open-ended. */
function window_(b: Banner): string {
  const from = b.startsAt ? dateFmt.format(new Date(b.startsAt)) : null;
  const to = b.endsAt ? dateFmt.format(new Date(b.endsAt)) : null;
  if (from && to) return `${from} – ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Until ${to}`;
  return "No end date";
}

export default async function AdminBannersPage() {
  const [banners, backendReady] = await Promise.all([
    listAllBanners(),
    bannersBackendReady(),
  ]);

  const live = banners.filter((b) => b.status === "active");
  const totals = banners.reduce(
    (acc, b) => {
      acc.impressions += b.analytics?.impressions ?? 0;
      acc.clicks += b.analytics?.clicks ?? 0;
      acc.orders += b.analytics?.orders ?? 0;
      return acc;
    },
    { impressions: 0, clicks: 0, orders: 0 }
  );
  const ctr = totals.impressions > 0 ? totals.clicks / totals.impressions : 0;

  return (
    <>
      <AdminHero
        title="Campaigns"
        tag={live.length > 0 ? `${live.length} running` : "None running"}
        subtitle="Banners and sponsored slots across the customer app"
        action={
          <ConsoleOnly tool="Designing a campaign" notice={false}>
            <Link href="/admin/banners/new" className="c-btn c-btn-dark press">
              <Plus className="size-3.5" strokeWidth={2.4} /> New campaign
            </Link>
          </ConsoleOnly>
        }
      />

      {/* Pausing or ending a live campaign is a phone job and stays below.
          Authoring one — creative, placements, schedule — is not. */}
      <ConsoleOnly
        tool="Designing a campaign"
        why="Pausing or ending a campaign that is already running — the urgent half — works on a phone, from the list below."
      />

      {!backendReady ? (
        <PreviewNotice>
          Preview mode — apply{" "}
          <code className="rounded bg-surface-2 px-1 text-xs">
            0014_banners.sql
          </code>{" "}
          to persist campaigns.
        </PreviewNotice>
      ) : null}

      {banners.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No campaigns yet"
          description="Create a banner and it shows in the customer app."
          action={
            <ConsoleOnly tool="Designing a campaign" notice={false}>
              <Link href="/admin/banners/new" className="c-btn c-btn-dark press">
                <Plus className="size-3.5" strokeWidth={2.4} /> New campaign
              </Link>
            </ConsoleOnly>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3.5">
            {banners.map((b) => (
              <CampaignCard key={b.id} banner={b} />
            ))}
          </div>

          <StatTiles>
            <StatTile
              label="Running now"
              value={live.length}
              note={`Of ${banners.length} campaign${banners.length === 1 ? "" : "s"}`}
            />
            <StatTile
              label="Impressions"
              value={nf.format(totals.impressions)}
              note="Times a banner was shown"
            />
            <StatTile
              label="Click-through"
              value={pct(ctr)}
              note={`${nf.format(totals.clicks)} clicks`}
            />
            <StatTile
              label="Attributed orders"
              value={nf.format(totals.orders)}
              note="Orders that followed a click"
            />
          </StatTiles>
        </>
      )}
    </>
  );
}

function CampaignCard({ banner: b }: { banner: Banner }) {
  const a = b.analytics;
  return (
    <article className="flex flex-col gap-3.5 rounded-xl border border-line bg-surface px-[17px] py-4">
      {/* The slide itself, rendered by the customer component so what an
          operator approves here cannot drift from what ships. `analytics={false}`
          because a campaigns list that logged an impression per card would be
          measuring its own audience.

          Console-only, and silently so: this is a preview, not a tool — nobody
          goes looking for it — and it is the expensive half of the card. One
          live carousel per campaign inside a 370px frame is a lot of mounted
          client component for a picture that would be too small to judge. */}
      <ConsoleOnly tool="Campaign previews" notice={false}>
        <div className="pointer-events-none -mx-[17px] -mt-4 overflow-hidden rounded-t-xl [&_a]:rounded-none">
          <PromoBannerCarousel banners={[b]} placement="preview" analytics={false} />
        </div>
      </ConsoleOnly>

      <div className="flex items-start gap-3">
        <span
          className="grid size-10 shrink-0 place-items-center rounded-[9px] text-lg"
          style={{ background: b.tint }}
        >
          {b.glyph ?? "📢"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 truncate text-[15px] font-bold tracking-[-0.01em]">
              {b.headline}
            </h2>
            <StatusText tone={STATUS_TONE[b.status]} className="shrink-0">
              {STATUS_LABEL[b.status]}
            </StatusText>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted">
            {b.name}
            {b.kind === "sponsored"
              ? ` · Sponsored${b.sponsorName ? ` · ${b.sponsorName}` : ""}`
              : ""}
            {" · "}
            {window_(b)}
          </p>
        </div>
      </div>

      {/* Two up in the phone column, four across in the console — the figures
          are worth keeping on a phone, they just don't fit in one row there. */}
      <dl className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
        <Figure label="Shown" value={nf.format(a?.impressions ?? 0)} />
        <Figure label="Clicks" value={nf.format(a?.clicks ?? 0)} />
        <Figure label="CTR" value={pct(a?.ctr ?? 0)} />
        <Figure label="Orders" value={nf.format(a?.orders ?? 0)} />
      </dl>

      <div className="flex items-center justify-between gap-2 border-t border-[color:var(--c-divider)] pt-3">
        <p className="min-w-0 truncate text-[11.5px] text-muted">
          {b.placements.length
            ? b.placements.join(", ")
            : "Not placed anywhere yet"}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Link href={`/admin/banners/${b.id}`} className="c-btn-affirm press">
            Edit
          </Link>
          <BannerRowActions id={b.id} status={b.status} />
        </div>
      </div>
    </article>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dd className="truncate text-base font-bold leading-none tabular-nums text-ink">
        {value}
      </dd>
      <dt className="mt-1 truncate text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">
        {label}
      </dt>
    </div>
  );
}
