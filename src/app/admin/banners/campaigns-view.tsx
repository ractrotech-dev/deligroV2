import Link from "next/link";
import { Megaphone, Plus } from "lucide-react";
import { MetricRow, StatusText, type Delta, type MetricItem, type Tone } from "@/components/admin/console";
import { PLACEMENT_LABEL, bannerShowsAnywhere } from "@/lib/banner-placements";
import type { Banner, BannerStatus } from "@/types";
import { AdminHero, EmptyState, PreviewNotice } from "@/components/admin/admin-ui";
import { PromoBannerCarousel } from "@/components/home/promo-banner-carousel";
import type { BannerActivity } from "@/lib/data-access/banners";
import { BannerRowActions } from "./banner-row-actions";

/**
 * Admin → Campaigns & ads. The figures first, then every banner and sponsored slot
 * as a card, running ones first.
 *
 * A budget bar, reach, redemptions and ROI are not here: banners in this product
 * carry no budget, no coupon link and no spend, so there is nothing to divide or
 * draw a progress track against. Orders are not here either: nothing ever sends an
 * "order" event for a banner (/api/banners/track takes impressions and clicks), so
 * the figure would always be 0. What the platform does record is views and clicks,
 * in total on each banner and by day in banner_events.
 *
 * Only some placements are read by a screen (lib/banner-placements.ts). A banner
 * with none of them is marked "Not showing anywhere", so it can be fixed.
 */

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

const STATUS_ORDER: Record<BannerStatus, number> = { active: 0, paused: 1, draft: 2, archived: 3 };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const nf = new Intl.NumberFormat("en-IN");

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Against the seven days before. None when there is nothing to compare with. */
function weekDelta(now: number, before: number): Delta | undefined {
  if (before === 0) return undefined;
  const change = Math.round(((now - before) / before) * 100);
  return { label: `${change > 0 ? "+" : ""}${change}%`, direction: change > 0 ? "up" : change < 0 ? "down" : "flat" };
}

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  timeZone: "Asia/Kolkata",
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

function figures(banners: Banner[], activity: BannerActivity | null): MetricItem[] {
  const count = (s: BannerStatus) => banners.filter((b) => b.status === s).length;
  const running = count("active");
  const parked = banners.length - running;
  const parkedNote = [
    count("paused") ? `${count("paused")} paused` : null,
    count("draft") ? plural(count("draft"), "draft") : null,
    count("archived") ? `${count("archived")} ended` : null,
  ].filter(Boolean);
  const paid = banners.filter((b) => b.kind === "sponsored");

  const shownTotal = sum(banners.map((b) => b.analytics?.impressions ?? 0));
  const clicksTotal = sum(banners.map((b) => b.analytics?.clicks ?? 0));
  const ctrTotal = shownTotal > 0 ? clicksTotal / shownTotal : 0;

  const shown7 = activity ? sum(activity.shown) : 0;
  const clicks7 = activity ? sum(activity.clicks) : 0;

  return [
    { label: "Running now", value: nf.format(running), note: `Of ${plural(banners.length, "campaign")}` },
    { label: "Not running", value: nf.format(parked), note: parked === 0 ? "Everything is live" : parkedNote.join(", ") },
    activity
      ? {
          label: "Shown, last 7 days",
          value: nf.format(shown7),
          note: `${nf.format(shownTotal)} all time`,
          spark: activity.shown,
          delta: weekDelta(shown7, activity.shownBefore),
        }
      : { label: "Shown", value: nf.format(shownTotal), note: "All time" },
    activity
      ? {
          label: "Clicks, last 7 days",
          value: nf.format(clicks7),
          note: `${nf.format(clicksTotal)} all time`,
          spark: activity.clicks,
          delta: weekDelta(clicks7, activity.clicksBefore),
        }
      : { label: "Clicks", value: nf.format(clicksTotal), note: "All time" },
    {
      label: "Click-through",
      value: pct(ctrTotal),
      note: activity && shown7 > 0 ? `${pct(clicks7 / shown7)} last 7 days` : "Clicks per time shown",
    },
    { label: "Paid ads", value: nf.format(paid.length), note: `${paid.filter((b) => b.status === "active").length} running` },
  ];
}

export function CampaignsView({
  banners,
  backendReady,
  activity,
  now,
}: Readonly<{
  banners: Banner[];
  backendReady: boolean;
  /** Null when the daily figures can't be read: the totals still show. */
  activity: BannerActivity | null;
  now: Date;
}>) {
  const running = banners.filter((b) => b.status === "active").length;
  const notShowing = banners.filter((b) => !bannerShowsAnywhere(b.placements));
  const endingSoon = banners.filter((b) => {
    if (b.status !== "active" || !b.endsAt) return false;
    const left = new Date(b.endsAt).getTime() - now.getTime();
    return left > 0 && left <= WEEK_MS;
  });
  const sorted = [...banners].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

  const newCampaign = (
    <Link href="/admin/banners/new" className="c-btn c-btn-dark">
      <Plus className="size-3.5" strokeWidth={2.4} /> New campaign
    </Link>
  );

  return (
    <>
      <AdminHero
        title="Campaigns & ads"
        tag={running > 0 ? `${running} running` : "None running"}
        subtitle="Banners and sponsored slots across the customer app"
        action={newCampaign}
      />

      {!backendReady ? (
        <PreviewNotice>
          Preview mode — apply <code className="rounded bg-surface-2 px-1 text-xs">0014_banners.sql</code> to persist
          campaigns.
        </PreviewNotice>
      ) : null}

      {banners.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No campaigns yet"
          description="Create a banner and it shows in the customer app."
          action={newCampaign}
        />
      ) : (
        <div className="space-y-4">
          <MetricRow items={figures(banners, activity)} />

          {notShowing.length > 0 ? (
            <p className="text-sm">
              <StatusText tone="red">
                {notShowing.length === 1 ? "1 banner is" : `${notShowing.length} banners are`} not showing anywhere.
              </StatusText>{" "}
              <span className="text-muted">Open it and save to put it on the home page.</span>
            </p>
          ) : null}
          {endingSoon.length > 0 ? (
            <p className="text-sm">
              <StatusText tone="amber">{`${plural(endingSoon.length, "campaign")} ${endingSoon.length === 1 ? "ends" : "end"} within 7 days:`}</StatusText>{" "}
              <span className="text-muted">{endingSoon.map((b) => b.name).join(", ")}</span>
            </p>
          ) : null}

          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3.5">
            {sorted.map((b) => (
              <CampaignCard key={b.id} banner={b} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function CampaignCard({ banner: b }: Readonly<{ banner: Banner }>) {
  const a = b.analytics;
  const shows = bannerShowsAnywhere(b.placements);
  return (
    <article className="flex flex-col rounded-[var(--c-r)] border border-line bg-surface">
      <div className="pointer-events-none pt-4">
        <PromoBannerCarousel banners={[b]} placement="preview" analytics={false} />
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <div className="flex items-start justify-between gap-2">
            <h2 className="min-w-0 truncate text-[14px] font-bold tracking-[-0.01em]">{b.name}</h2>
            <StatusText tone={STATUS_TONE[b.status]} className="shrink-0">
              {STATUS_LABEL[b.status]}
            </StatusText>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted">
            {b.kind === "sponsored" ? `Sponsored${b.sponsorName ? ` by ${b.sponsorName}` : ""} · ` : ""}
            {window_(b)}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted">
            {shows ? b.placements.flatMap((p) => PLACEMENT_LABEL[p] ?? []).join(", ") : <StatusText tone="red">Not showing anywhere</StatusText>}
          </p>
        </div>

        <dl className="grid grid-cols-3 gap-2">
          <CampaignFigure label="Shown" value={nf.format(a?.impressions ?? 0)} />
          <CampaignFigure label="Clicks" value={nf.format(a?.clicks ?? 0)} />
          <CampaignFigure label="Click-through" value={pct(a?.ctr ?? 0)} />
        </dl>

        <div className="mt-auto border-t border-[color:var(--c-divider)] pt-3">
          <BannerRowActions id={b.id} status={b.status} />
        </div>
      </div>
    </article>
  );
}

function CampaignFigure({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="min-w-0">
      <dd className="truncate text-base font-bold leading-none tabular-nums text-ink">{value}</dd>
      <dt className="mt-1 truncate text-[10.5px] font-medium text-muted">{label}</dt>
    </div>
  );
}
