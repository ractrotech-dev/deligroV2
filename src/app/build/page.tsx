import Link from "next/link";
import type { Metadata } from "next";
import { Check, Circle, Database, ExternalLink, Loader2, MinusCircle } from "lucide-react";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import {
  BUILD_TABS,
  PROJECT,
  STATUS_META,
  isBuildTab,
  milestonesForTab,
  planProgress,
  type BuildTab,
  type Milestone,
  type TaskStatus,
} from "@/lib/build-plan";
import {
  getBuildDbSnapshot,
  type BuildDbSnapshot,
} from "@/lib/data-access/build-stats";
import { requireRole } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Build tracker",
  description: "5-week delivery plan and live progress by role.",
  // Belt and braces alongside the role check below and the Disallow in
  // robots.ts: an internal roadmap has no business in a search result.
  robots: { index: false, follow: false },
};

const ICON: Record<TaskStatus, React.ComponentType<{ className?: string }>> = {
  done: Check,
  active: Loader2,
  todo: Circle,
  blocked: MinusCircle,
};

interface DbRow {
  label: string;
  table: string;
  value: number | string;
}

/** A count from a table a later migration added — `—` when it isn't there yet. */
function opt(n: number | null): number | string {
  return n ?? "—";
}

function dbRowsForTab(tab: BuildTab, db: BuildDbSnapshot): DbRow[] {
  switch (tab) {
    case "customer":
      return [
        { label: "Customer profiles", table: "profiles.role = customer", value: db.profiles_customer },
        { label: "Saved addresses", table: "addresses", value: db.addresses },
        { label: "Orders", table: "orders", value: db.orders },
        { label: "Legacy orders", table: "orders.external_id", value: db.legacy_orders },
        { label: "Favorites", table: "favorites", value: opt(db.favorites) },
        { label: "Reviews", table: "reviews", value: opt(db.reviews) },
        { label: "Promo banners", table: "banners", value: opt(db.banners) },
        { label: "Coupons", table: "coupons", value: opt(db.coupons) },
        {
          label: "Online payments (paid)",
          table: "payments.status = paid",
          value:
            db.payments === null
              ? "—"
              : `${db.payments_paid ?? 0} / ${db.payments}`,
        },
      ];
    case "vendor":
      return [
        { label: "Restaurant profiles", table: "profiles.role = restaurant", value: db.profiles_restaurant },
        { label: "Distinct owners", table: "restaurants.owner_id", value: db.distinct_restaurant_owners },
        { label: "Restaurants (open)", table: "restaurants.is_open", value: `${db.restaurants_open} / ${db.restaurants}` },
        { label: "Legacy shops", table: "restaurants.slug ~ '-[0-9]+$'", value: db.legacy_restaurants },
        { label: "Menu items", table: "menu_items", value: db.menu_items },
        { label: "Legacy menu items", table: "menu_items.external_id", value: db.legacy_menu_items },
        { label: "Vendor categories", table: "vendor_categories", value: opt(db.vendor_categories) },
        { label: "Legal documents", table: "vendor_documents", value: opt(db.vendor_documents) },
        { label: "Orders (all)", table: "orders", value: db.orders },
        { label: "Legacy orders", table: "orders.external_id", value: db.legacy_orders },
      ];
    case "driver":
      return [
        { label: "Driver profiles", table: "profiles.role = driver", value: db.profiles_driver },
        { label: "Deliveries", table: "deliveries", value: db.deliveries },
        { label: "Unassigned jobs", table: "deliveries.status = unassigned", value: db.deliveries_unassigned },
        { label: "Orders (pipeline)", table: "orders", value: db.orders },
      ];
    case "manager":
      return [
        { label: "Manager profiles", table: "profiles.role = manager", value: opt(db.profiles_manager) },
        { label: "Orders (all vendors)", table: "orders", value: db.orders },
        { label: "Phone orders taken", table: "orders.channel = phone", value: opt(db.orders_phone) },
        { label: "Deliveries", table: "deliveries", value: db.deliveries },
        { label: "Unassigned jobs", table: "deliveries.status = unassigned", value: db.deliveries_unassigned },
        { label: "Restaurants (open)", table: "restaurants.is_open", value: `${db.restaurants_open} / ${db.restaurants}` },
      ];
    case "admin":
      return [
        { label: "Admin profiles", table: "profiles.role = admin", value: db.profiles_admin },
        { label: "Manager profiles", table: "profiles.role = manager", value: opt(db.profiles_manager) },
        {
          label: "All profiles",
          table: "profiles",
          value:
            db.profiles_customer +
            db.profiles_restaurant +
            db.profiles_driver +
            db.profiles_admin +
            (db.profiles_manager ?? 0),
        },
        { label: "Restaurants (approved)", table: "restaurants.approved", value: `${db.restaurants_approved} / ${db.restaurants}` },
        { label: "Vendor drafts", table: "vendor_registration_drafts", value: opt(db.vendor_drafts) },
        { label: "Vendor categories", table: "vendor_categories", value: opt(db.vendor_categories) },
        { label: "Orders", table: "orders", value: db.orders },
        { label: "Legacy orders", table: "orders.external_id", value: db.legacy_orders },
        { label: "Refunds (pending)", table: "refunds.status = pending", value: `${db.refunds_pending} / ${db.refunds}` },
        {
          label: "Payments (paid)",
          table: "payments.status = paid",
          value:
            db.payments === null
              ? "—"
              : `${db.payments_paid ?? 0} / ${db.payments}`,
        },
        { label: "Promo banners", table: "banners", value: opt(db.banners) },
        { label: "Addresses", table: "addresses", value: db.addresses },
      ];
  }
}

function DbPanel({ tab, snapshot }: { tab: BuildTab; snapshot: BuildDbSnapshot | null }) {
  if (!snapshot) {
    return (
      <section className="card p-5">
        <div className="flex items-center gap-2">
          <Database className="size-4 text-muted" />
          <p className="text-label">Database snapshot</p>
        </div>
        <p className="mt-2 text-sm text-muted">
          Supabase not configured — set env keys to see live row counts.
        </p>
      </section>
    );
  }

  const rows = dbRowsForTab(tab, snapshot);
  return (
    <section className="card p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Database className="size-4 text-accent" />
          <p className="text-label">Live database · {BUILD_TABS.find((t) => t.id === tab)?.label}</p>
        </div>
        <span className="text-[11px] font-medium text-muted">Supabase Postgres</span>
      </div>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div
            key={row.table}
            className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2"
          >
            <div className="min-w-0">
              <dt className="text-sm font-medium">{row.label}</dt>
              <dd className="truncate font-mono text-[11px] text-muted">{row.table}</dd>
            </div>
            <span className="shrink-0 text-lg font-extrabold tabular-nums tracking-tight">
              {row.value}
            </span>
          </div>
        ))}
      </dl>
    </section>
  );
}

function MilestoneList({
  milestones,
  globalOffset,
}: {
  milestones: Milestone[];
  globalOffset: number;
}) {
  // Each milestone's build numbers continue where the previous one stopped.
  // Derived by folding over the list rather than by advancing a counter inside
  // the map: a variable reassigned from inside a render closure isn't a pure
  // function of the inputs, and would carry its value across re-renders.
  const numbered = milestones.reduce<
    { milestone: Milestone; startNo: number }[]
  >((acc, m) => {
    const prev = acc.at(-1);
    const startNo = prev
      ? prev.startNo + prev.milestone.tasks.length
      : globalOffset + 1;
    return [...acc, { milestone: m, startNo }];
  }, []);

  return (
    <div className="space-y-4">
      {numbered.map(({ milestone: m, startNo }) => {
        const doneCount = m.tasks.filter((t) => t.status === "done").length;
        return (
          <section key={`${m.week}-${m.title}`} className="card p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-label">
                  {m.week === 0 ? "Foundation" : `Week ${m.week}`} · {m.range}
                </p>
                <h2 className="mt-0.5 text-xl font-extrabold tracking-tight">{m.title}</h2>
                <p className="mt-1 text-sm text-muted">{m.goal}</p>
              </div>
              <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold text-muted">
                {doneCount}/{m.tasks.length}
              </span>
            </div>

            <ul className="mt-4 space-y-2.5">
              {m.tasks.map((t, ti) => {
                const meta = STATUS_META[t.status];
                const Icon = ICON[t.status];
                const no = startNo + ti;
                return (
                  <li key={t.title} className="flex items-start gap-3">
                    <span
                      className="text-data mt-0.5 w-8 shrink-0 text-right text-xs font-semibold text-muted"
                      aria-label={`Build ${no}`}
                    >
                      #{no}
                    </span>
                    <span
                      className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full"
                      style={{ background: "var(--surface-2)", color: meta.tint }}
                    >
                      <Icon
                        className={
                          "size-3.5" + (t.status === "active" ? " animate-spin" : "")
                        }
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={
                          "block text-[15px] font-medium" +
                          (t.status === "done"
                            ? " text-muted line-through decoration-1"
                            : "")
                        }
                      >
                        {t.title}
                      </span>
                      {t.detail ? (
                        <span className="mt-0.5 block text-xs text-muted">{t.detail}</span>
                      ) : null}
                      {t.db ? (
                        <span className="mt-1 inline-block rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                          {t.db}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className="shrink-0 text-[11px] font-semibold uppercase tracking-wide"
                      style={{ color: meta.tint }}
                    >
                      {meta.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export default async function BuildTrackerPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  // Operators only. This page publishes the internal delivery plan — what is
  // done, what is blocked, what the architecture is — next to live row counts
  // from getBuildDbSnapshot(), which is a rough measure of order, vendor and
  // customer volume. src/proxy.ts only asks for a guest cookie on routes like
  // this one, and a guest cookie is one click on the sign-in screen, so until
  // now any visitor could read all of it. Information disclosure rather than a
  // vulnerability, but in a one-city market it is free intelligence.
  await requireRole("admin");

  const { tab: tabParam } = await searchParams;
  const tab: BuildTab = isBuildTab(tabParam) ? tabParam : "customer";
  const tabConfig = BUILD_TABS.find((t) => t.id === tab)!;
  const milestones = milestonesForTab(tab);
  const p = planProgress(milestones);
  const dbSnapshot = await getBuildDbSnapshot();

  const globalOffset =
    tab === "customer"
      ? 0
      : BUILD_TABS.slice(0, BUILD_TABS.findIndex((t) => t.id === tab)).reduce(
          (n, t) => n + milestonesForTab(t.id).flatMap((m) => m.tasks).length,
          0
        );

  return (
    <div className="dashboard-shell">
      <main className="dashboard-main max-w-[820px]">
        <div className="flex items-center justify-between py-4">
          <div>
            <p className="text-display">Build tracker</p>
            <p className="text-sm text-muted">
              {PROJECT.name} v1 · {PROJECT.durationLabel} · ship by {PROJECT.ship}
            </p>
          </div>
          <ThemeToggle />
        </div>

        {/* Role tabs */}
        <nav
          className="card flex flex-wrap gap-1 p-1.5"
          aria-label="Build tracker sections"
        >
          {BUILD_TABS.map((t) => {
            const active = t.id === tab;
            return (
              <Link
                key={t.id}
                href={t.id === "customer" ? "/build" : `/build?tab=${t.id}`}
                className={
                  "flex min-w-[5.5rem] flex-1 flex-col items-center rounded-xl px-3 py-2 text-center transition-colors" +
                  (active
                    ? " bg-accent text-[var(--on-accent)]"
                    : " text-muted hover:bg-surface-2 hover:text-foreground")
                }
              >
                <span className="text-sm font-semibold">{t.label}</span>
                <span
                  className={
                    "mt-0.5 text-[10px] leading-tight" +
                    (active ? " opacity-90" : " opacity-70")
                  }
                >
                  {t.portal}
                </span>
              </Link>
            );
          })}
        </nav>

        {/* Tab header */}
        <section className="card mt-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-label">{tabConfig.label} portal</p>
              <h2 className="mt-0.5 text-xl font-extrabold tracking-tight">{tabConfig.summary}</h2>
            </div>
            <Link
              href={tabConfig.portal}
              className="inline-flex items-center gap-1 text-sm font-medium text-accent"
            >
              Open portal
              <ExternalLink className="size-3.5" />
            </Link>
          </div>

          <div className="mt-4 flex items-end justify-between">
            <div>
              <p className="text-label">Section progress</p>
              <p className="mt-1 text-3xl font-extrabold tracking-tight">{p.pct}%</p>
            </div>
            <p className="text-sm text-muted">
              <span className="font-semibold text-[color:var(--green)]">{p.done} done</span>
              {" · "}
              <span className="font-semibold text-accent">{p.active} active</span>
              {" · "}
              {p.total} tasks
            </p>
          </div>
          <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${p.pct}%` }}
            />
          </div>
        </section>

        <div className="mt-4">
          <DbPanel tab={tab} snapshot={dbSnapshot} />
        </div>

        <div className="mt-4">
          <MilestoneList milestones={milestones} globalOffset={globalOffset} />
        </div>

        <p className="mt-6 text-center text-xs text-muted">
          Live from <code>src/lib/build-plan.ts</code> +{" "}
          <code>getBuildDbSnapshot()</code> — flip a task&apos;s <code>status</code>{" "}
          to update this board.
        </p>
      </main>
    </div>
  );
}
