import type { ReactNode } from "react";
import Link from "next/link";
import { Panel, RangeTabs } from "@/components/admin/admin-ui";
import {
  MetricRow,
  ShareBar,
  type Delta,
  type MetricItem,
  type ShareSegment,
} from "@/components/admin/console";
import {
  getAdminSeries,
  getOrderStatusMix,
  type AdminSeries,
} from "@/lib/data-access/admin-series";
import { getVendorEarningsSummary } from "@/lib/data-access/vendor-earnings";
import {
  storefrontGaps,
  storefrontScore,
  type VendorDetail,
} from "@/lib/data-access/admin-vendors";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formatINR, formatRating, formatCount } from "@/lib/utils/format";
import { VendorCredentials } from "./edit/vendor-credentials";
import { VendorDeletePanel } from "./vendor-delete-panel";
import { VendorPerformance } from "./vendor-performance";
import { Card, Row, fmtDate, rupees } from "./vendor-fields";


const nf = new Intl.NumberFormat("en-IN");

const DAY_OPTIONS = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
];

const EMPTY_SERIES: AdminSeries = {
  days: [],
  totals: { orders: 0, gmv: 0 },
  peak: null,
  olderOrders: 0,
};

const SLICE_COLOR: Record<string, string> = {
  placed: "var(--accent)",
  kitchen: "var(--accent)",
  ready: "var(--pop)",
  on_the_way: "var(--blue)",
  delivered: "var(--green)",
  cancelled: "var(--deal)",
};

function pctDelta(pct: number | null): Delta | undefined {
  if (pct == null) return undefined;
  if (pct === 0) return { label: "0%", direction: "flat" };
  return {
    label: `${pct > 0 ? "+" : "−"}${Math.abs(Math.round(pct))}%`,
    direction: pct > 0 ? "up" : "down",
  };
}

/** Who runs the shop, and how to reach them. */
function OwnerCard({ vendor }: Readonly<{ vendor: VendorDetail }>) {
  let ownerName: ReactNode = null;
  if (vendor.ownerName) {
    ownerName = vendor.ownerMobile ? (
      <a href={`tel:${vendor.ownerMobile}`}>{vendor.ownerName}</a>
    ) : (
      vendor.ownerName
    );
  }

  return (
    <Card title="Owner">
      <Row
        label="Owner name"
        value={ownerName}
      />
      <Row
        label="Mobile"
        value={
          vendor.ownerMobile ? (
            <a href={`tel:${vendor.ownerMobile}`}>{vendor.ownerMobile}</a>
          ) : null
        }
      />
      <Row label="Alt. mobile" value={vendor.ownerAltMobile} />
      <Row
        label="Email"
        value={
          vendor.ownerEmail ? (
            <a href={`mailto:${vendor.ownerEmail}`}>{vendor.ownerEmail}</a>
          ) : null
        }
      />
    </Card>
  );
}

/**
 * Web console overview for one shop: KPIs, sales report, then the facts
 * that used to be the whole page. Password and delete live in Access — they
 * are shop-level, not header chrome.
 */
export async function VendorOverview({
  vendor,
  days,
}: Readonly<{
  vendor: VendorDetail;
  days: number;
}>) {
  const [series, mix, earnings] = isSupabaseConfigured
    ? await Promise.all([
        getAdminSeries(days, vendor.id),
        getOrderStatusMix(days, vendor.id),
        getVendorEarningsSummary(vendor.id, "last_30").catch(() => null),
      ])
    : ([EMPTY_SERIES, [], null] as const);

  const avg =
    series.totals.orders > 0
      ? Math.round(series.totals.gmv / series.totals.orders)
      : 0;
  const hrefFor = (d: number) => `/admin/vendors/${vendor.id}?days=${d}`;
  const rangeTabs = (
    <RangeTabs options={DAY_OPTIONS} active={days} hrefFor={hrefFor} />
  );

  const kpis: MetricItem[] = [
    {
      label: "Sales",
      value: formatINR(series.totals.gmv),
      note: `${days} days`,
      // Against the prior 30 days, so only shown on the 30-day window.
      delta:
        days === 30
          ? pctDelta(earnings?.periodChangePercent ?? null)
          : undefined,
      spark: series.days.map((d) => d.gmv),
    },
    {
      label: "Orders",
      value: nf.format(series.totals.orders),
      note:
        earnings && earnings.pendingCount > 0
          ? `${earnings.pendingCount} live`
          : `${days} days`,
      spark: series.days.map((d) => d.orders),
    },
    {
      label: "Avg order",
      value: formatINR(avg),
      note: "this window",
    },
    {
      label: "Today",
      value: formatINR(earnings?.todayRevenue ?? 0),
      note: `${nf.format(earnings?.todayOrders ?? 0)} orders`,
    },
    {
      label: "Rating",
      value: vendor.ratingCount > 0 ? formatRating(vendor.rating) : "—",
      note:
        vendor.ratingCount > 0
          ? `${formatCount(vendor.ratingCount)} ratings`
          : "no ratings yet",
    },
  ];

  const segments: ShareSegment[] = mix.map((s) => ({
    label: s.label,
    count: s.count,
    color: SLICE_COLOR[s.status] ?? "var(--c-faint)",
  }));

  const gaps = storefrontGaps(vendor);

  return (
    <div className="space-y-4">
      {gaps.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-deal/25 bg-deal/5 px-4 py-3 text-sm">
          <span className="font-semibold text-deal">
            Storefront {storefrontScore(vendor)}% complete.
          </span>
          <span className="text-muted">Still missing {gaps.join(", ")}.</span>
          <Link
            href={`/admin/vendors/${vendor.id}/edit`}
            className="press ml-auto text-xs font-semibold text-accent-ink"
          >
            Fix on edit
          </Link>
        </div>
      ) : null}

      <div className="flex justify-end @3xl:hidden">{rangeTabs}</div>
      <MetricRow items={kpis} />

      <Panel title="Order mix" subtitle={`${days} days`} className="@3xl:hidden">
        <ShareBar segments={segments} />
      </Panel>

      <VendorPerformance
        days={days}
        series={series}
        segments={segments}
        earnings={earnings}
        rangeTabs={rangeTabs}
      />

      <div className="grid gap-3 @3xl:grid-cols-3">
        <OwnerCard vendor={vendor} />
        <Card title="Shop">
          <Row label="Category" value={vendor.category} />
          <Row
            label="Commission"
            value={`${vendor.effectiveCommissionPct}%${
              vendor.inheritsPlatformRate ? " · platform rate" : ""
            }`}
          />
          <Row label="Min order" value={rupees(vendor.minOrder)} />
          <Row label="Menu items" value={vendor.menuItemCount} />
          <Row label="Open now" value={vendor.isOpen ? "Yes" : "No"} />
          <Row label="Registered" value={fmtDate(vendor.createdAt)} />
        </Card>
        <Card title="Location">
          <Row label="Address" value={vendor.address} />
          <Row label="Landmark" value={vendor.landmark} />
          <Row label="Pincode" value={vendor.pincode} />
          <Row
            label="Pin"
            value={
              vendor.lat != null && vendor.lng != null
                ? `${vendor.lat.toFixed(5)}, ${vendor.lng.toFixed(5)}`
                : "Not set"
            }
          />
        </Card>
      </div>

      <section id="access" className="space-y-3">
        <div>
          <h2 className="text-sm font-bold">Access</h2>
          <p className="mt-0.5 text-xs text-muted">
            The owner&apos;s login, and removing the shop from the platform.
          </p>
        </div>
        <div className="grid gap-3 @3xl:grid-cols-2">
          <VendorCredentials
            id={vendor.id}
            loginEmail={vendor.ownerEmail}
            loginPassword={vendor.loginPassword}
            passwordResetAt={vendor.passwordResetAt}
            ownerMobile={vendor.ownerMobile}
            ownerPhoneVerified={vendor.ownerPhoneVerified}
          />
          <VendorDeletePanel id={vendor.id} name={vendor.name} />
        </div>
      </section>
    </div>
  );
}
