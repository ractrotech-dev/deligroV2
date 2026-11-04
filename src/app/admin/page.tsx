import { requireRole } from "@/lib/auth";
import Link from "next/link";
import { Plus } from "lucide-react";
import { getFailedPaymentCount } from "@/lib/data-access/admin-stats";
import { getOrderDesk, type DeskOrder, type OrderDesk } from "@/lib/data-access/admin-dispatch";
import {
  listPendingExceptions,
  type OpsException,
} from "@/lib/data-access/delivery-exceptions";
import { ExceptionQueue } from "@/components/ops/exception-queue";
import { EmergencyBanner } from "@/components/ops/emergency-banner";
import type { EmergencyItem } from "@/components/ops/emergency-types";
import { listEmergenciesAction } from "@/app/manager/support-actions";
import { countUnfinishedPayments } from "@/lib/data-access/admin-settlements";
import { totalShopDues } from "@/lib/data-access/manager-finance";
import {
  AttentionCards,
  Empty,
  LiveBadge,
  PageHeader,
  Section,
  Tabs,
  Toolbar,
  type AttentionItem,
} from "@/components/admin/console";
import { FilterForm, SearchField } from "@/components/admin/admin-filters";
import { OrderBoard, OrderList } from "@/components/admin/order-desk";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formatINR } from "@/lib/utils/format";
import { captureError } from "@/lib/obs/emit";

/**
 * Admin home: the order desk. The owner runs orders from here.
 *
 * Top to bottom: anything about a rider's safety or a rider waiting on a decision,
 * then every order still moving, with the buttons to move it, give it a rider, ring
 * the people on it or cancel it. Anything else waiting on the owner sits underneath.
 *
 * The sales figures and charts that used to live here are at /admin/reports/overview.
 * They answer "how is the business doing", and this screen answers "what do I do
 * next". Every order control goes through the audited calls in order-desk-controls.
 */
export const dynamic = "force-dynamic";

/** Long enough that a page of order reads isn't re-run every few seconds. */
const REFRESH_MS = 10_000;

type Show = "late" | "norider" | null;
type View = "board" | "list";

const NO_ORDERS: OrderDesk = { orders: [], atRisk: 0, unassigned: 0, failed: false };

/** Null: it could not be added up, which must never read as a green ₹0. */
type ShopsOwed = { amount: number; shops: number; unfinished: number } | null;

/** One SQL rollup and one count. */
async function loadShopsOwed(): Promise<ShopsOwed> {
  try {
    const [dues, unfinished] = await Promise.all([totalShopDues(), countUnfinishedPayments()]);
    return { ...dues, unfinished };
  } catch (e) {
    captureError(e, { source: "admin-home/shops-owed", attrs: { event: "shops_owed_failed" } });
    return null;
  }
}

function shopsOwedItem(owed: ShopsOwed): AttentionItem {
  const base = { href: "/admin/settlements", title: "Owed to shops", action: "Open Settlements" };
  if (!owed) {
    return { ...base, figure: "—", count: 0, detail: "Could not add this up just now", tone: "amber" };
  }
  const unfinished = owed.unfinished > 0 ? `, ${owed.unfinished} not finished` : "";
  return {
    ...base,
    figure: formatINR(owed.amount),
    count: owed.shops,
    detail: `${owed.shops} shop${owed.shops === 1 ? "" : "s"}${unfinished}`,
    tone: "amber",
  };
}

/** What else is waiting on the owner. Only what has something in it. */
function otherWork(owed: ShopsOwed, failedPayments: number): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (failedPayments > 0) {
    items.push({
      href: "/admin/orders?payment=failed",
      title: "Failed payments",
      detail: "Customer tried to pay and could not",
      count: failedPayments,
      tone: "amber",
      action: "View orders",
    });
  }
  if (!owed || owed.amount > 0) items.push(shopsOwedItem(owed));
  return items;
}

function pick(orders: DeskOrder[], show: Show): DeskOrder[] {
  if (show === "late") return orders.filter((o) => o.lateByMinutes > 0);
  if (show === "norider") return orders.filter((o) => o.noRider);
  return orders;
}

function hrefFor({ show, view }: { show: Show; view: View }): string {
  const params = new URLSearchParams();
  if (show) params.set("show", show);
  if (view !== "board") params.set("view", view);
  const qs = params.toString();
  return qs ? `/admin?${qs}` : "/admin";
}

export default async function AdminHomePage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ show?: string; view?: string }>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const sp = await searchParams;
  const show: Show = sp.show === "late" || sp.show === "norider" ? sp.show : null;
  const view: View = sp.view === "list" ? "list" : "board";

  const [desk, owed, failedPayments, exceptions, emergencies] = await Promise.all([
    isSupabaseConfigured ? getOrderDesk() : Promise.resolve(NO_ORDERS),
    isSupabaseConfigured
      ? loadShopsOwed()
      : Promise.resolve<ShopsOwed>({ amount: 0, shops: 0, unfinished: 0 }),
    isSupabaseConfigured ? getFailedPaymentCount() : Promise.resolve(0),
    // Riders waiting on a decision. Service role (phones, signed photo URLs),
    // authorised by requireRole above; its failure costs only the queue.
    isSupabaseConfigured
      ? listPendingExceptions().catch(() => [] as OpsException[])
      : Promise.resolve([] as OpsException[]),
    // Open rider emergencies (0087). Its failure costs only the banner.
    isSupabaseConfigured
      ? listEmergenciesAction().catch(() => [] as EmergencyItem[])
      : Promise.resolve([] as EmergencyItem[]),
  ]);

  const shown = pick(desk.orders, show);
  const other = otherWork(owed, failedPayments);

  const empty = show ? (
    <Empty action={{ href: hrefFor({ show: null, view }), label: "Show all orders" }}>
      {show === "late" ? "No order is running late." : "Every order that needs a rider has one."}
    </Empty>
  ) : (
    <Empty action={{ href: "/admin/orders", label: "See past orders" }}>
      No orders are moving right now. New ones appear here by themselves.
    </Empty>
  );

  return (
    <>
      {isSupabaseConfigured ? <AutoRefresh interval={REFRESH_MS} /> : null}

      <PageHeader
        title="Dashboard"
        description="Every order still moving. Updates by itself."
        status={<LiveBadge label={`${desk.orders.length} moving`} />}
        actions={
          <>
            <Link href="/admin/reports/overview" className="c-btn c-btn-outline">
              Business numbers
            </Link>
            <Link href="/admin/orders" className="c-btn c-btn-outline">
              All orders
            </Link>
            <Link href="/manager/new-order" className="c-btn c-btn-dark">
              <Plus className="size-3.5" strokeWidth={2.4} /> New phone order
            </Link>
          </>
        }
      />

      {/* A rider in danger outranks everything on this screen. Renders nothing
          when there is no open emergency; polls on its own, like the queue. */}
      <EmergencyBanner items={emergencies} poll basePath="/admin/support" className="mb-4" />

      {/* Riders' exceptions, decided in place. Same component as the manager board's. */}
      {isSupabaseConfigured ? (
        <Section>
          <ExceptionQueue items={exceptions} poll />
        </Section>
      ) : null}

      <Toolbar>
        <Tabs
          label="Which orders"
          active={hrefFor({ show, view })}
          items={[
            { href: hrefFor({ show: null, view }), label: "All", count: desk.orders.length },
            { href: hrefFor({ show: "late", view }), label: "Running late", count: desk.atRisk },
            { href: hrefFor({ show: "norider", view }), label: "No rider", count: desk.unassigned },
          ]}
        />
        <FilterForm action="/admin/orders">
          <SearchField placeholder="Find an order, customer, shop or dish" />
        </FilterForm>
        <Tabs
          label="View"
          active={hrefFor({ show, view })}
          items={[
            { href: hrefFor({ show, view: "board" }), label: "Board" },
            { href: hrefFor({ show, view: "list" }), label: "List" },
          ]}
        />
      </Toolbar>

      {desk.failed ? (
        <p className="rounded-[var(--c-r)] border border-deal/30 bg-deal-soft px-3.5 py-2.5 text-[12.5px] font-medium text-deal">
          Couldn&apos;t load the orders. This page tries again by itself. If it stays like this, use All orders.
        </p>
      ) : view === "list" ? (
        <OrderList orders={shown} empty={empty} />
      ) : shown.length ? (
        <OrderBoard orders={shown} />
      ) : (
        empty
      )}

      {other.length ? (
        <Section title="Also waiting on you">
          <AttentionCards items={other} />
        </Section>
      ) : null}
    </>
  );
}
