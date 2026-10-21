/**
 * QA — migration 0144's SQL rollups against the reference metrics module.
 *
 * Runs 0144 in an in-process Postgres (PGlite), loads one randomised but
 * seeded set of orders, items, refunds and settlements into it, and requires
 * `ops_dashboard_rollup` / `ops_stats_rollup` (through `dashboardFromRollup` /
 * `statsFromRollup`) to produce exactly what `computeDashboard` /
 * `computeStats` produce from the same rows — every figure, every ordering.
 * It also proves the functions are service-role only.
 *
 * Needs: npm i --no-save @electric-sql/pglite@0.2.17
 * Usage: npx tsx scripts/qa/ops-sql-parity.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  averageOrderValue,
  computeDashboard,
  computeStats,
  dailySeries,
  dashboardFromRollup,
  inRange,
  istDayKey,
  istDayStart,
  addDays,
  previousPeriod,
  rangeBounds,
  statsFromRollup,
  type DashboardRollup,
  type DateRange,
  type Granularity,
  type MetricOrder,
  type MetricRefund,
  type PricingContext,
  type StatsRollup,
} from "../../src/lib/metrics";

async function main() {

  let failed = 0;
  let passed = 0;
  function check(name: string, ok: boolean, detail?: unknown) {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail, null, 1).slice(0, 2000)); }
  }

  /** Key-order independent comparison. */
  function canon(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    }
    return v;
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  function firstDiff(a: unknown, b: unknown, path = ""): string | null {
    if (same(a, b)) return null;
    if (a && b && typeof a === "object" && typeof b === "object") {
      for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) {
        const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
        if (d) return d;
      }
    }
    return `${path}: sql=${JSON.stringify(a)} ts=${JSON.stringify(b)}`;
  }

  // ── fixtures ───────────────────────────────────────────────────────────────
  let seed = 20261021;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const uuid = (prefix: number, i: number) =>
    `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;

  const ZONE1 = uuid(1, 1);
  const ZONE2 = uuid(1, 2);
  const SHOPS = [
    { id: uuid(2, 1), zone: ZONE1, pct: 12.5, other: 0, status: "active", open: true, name: "Annapurna" },
    { id: uuid(2, 2), zone: ZONE1, pct: null, other: 5, status: "active", open: false, name: "Bhoj" },
    { id: uuid(2, 3), zone: ZONE2, pct: 7.25, other: 3, status: "suspended", open: true, name: "Chaat Corner" },
    { id: uuid(2, 4), zone: ZONE2, pct: 33.3, other: 0, status: "active", open: true, name: "Annapurna" },
  ];
  const DEFAULT_PCT = 15;
  const GST = 18;
  const CATEGORIES = ["Starters", " Starters ", "Mains", null, "", "Desserts"];
  const MENU = CATEGORIES.map((category, i) => ({ id: uuid(3, i + 1), category }));
  const STATUSES = ["placed", "kitchen", "ready", "on_the_way", "delivered", "delivered", "delivered", "cancelled"] as const;
  const CANCELLERS = [null, "customer", "vendor", "manager", "admin", "system"] as const;
  const REASONS = [null, "Out of stock", " Out of stock ", "Customer asked", "", "Shop closed"];
  const PAYMENTS: [string, string][] = [
    ["cod", "pending"], ["cod", "paid"], ["online", "paid"], ["online", "pending"],
    ["online", "failed"], ["online", "authorized"], ["online", "refunded"], ["cod", "pending"],
  ];

  // Instants around IST midnights (18:30Z) between 17 and 22 October.
  const START = Date.parse("2026-10-17T00:00:00Z");
  function instant(): string {
    const r = rand();
    if (r < 0.15) {
      const day = 17 + Math.floor(rand() * 5);
      const offset = (rand() - 0.5) * 20 * 60_000; // ±10 min around IST midnight
      return new Date(Date.parse(`2026-10-${day}T18:30:00Z`) + offset).toISOString();
    }
    return new Date(START + Math.floor(rand() * 5.5 * 86_400_000)).toISOString();
  }
  const money = () => Math.round(rand() * 120000) / 100 + pick([0, 0.5, 0.25]);

  interface OrderFx {
    id: string; restaurant_id: string; zone_id: string; customer_id: string; status: string; created_at: string;
    total: number; delivery_fee: number; tax_amount: number; tip: number; discount: number; discount_funded_by: string | null;
    payment_method: string; payment_status: string; cancelled_by: string | null; cancellation_reason: string | null;
  }
  interface ItemFx { order_id: string; name: string; qty: number; price: number; menu_item_id: string | null }
  interface RefundFx { id: string; order_id: string; amount: number; status: string }

  const orders: OrderFx[] = [];
  const items: ItemFx[] = [];
  const refunds: RefundFx[] = [];
  for (let i = 1; i <= 400; i++) {
    const shop = pick(SHOPS);
    const status = pick(STATUSES);
    const [pm, ps] = pick(PAYMENTS);
    const food = money();
    const fee = pick([0, 20, 25.5, 40]);
    const tax = Math.round(food * 0.05 * 100) / 100;
    const tip = pick([0, 0, 10, 15.5]);
    const discount = pick([0, 0, 0, 30, 50, 75]);
    const o: OrderFx = {
      id: uuid(4, i), restaurant_id: shop.id, zone_id: shop.zone, customer_id: uuid(5, 1 + (i % 37)),
      status, created_at: instant(),
      total: Math.max(0, Math.round((food + fee + tax + tip - discount) * 100) / 100),
      delivery_fee: fee, tax_amount: tax, tip, discount,
      discount_funded_by: discount ? pick(["platform", "vendor", null]) : null,
      payment_method: pm, payment_status: ps,
      cancelled_by: status === "cancelled" ? pick(CANCELLERS) : null,
      cancellation_reason: status === "cancelled" ? pick(REASONS) : null,
    };
    orders.push(o);
    if (rand() < 0.85) {
      const lines = 1 + Math.floor(rand() * 3);
      for (let l = 0; l < lines; l++) {
        items.push({
          order_id: o.id, name: `Dish ${l}`, qty: 1 + Math.floor(rand() * 3), price: Math.round(rand() * 30000) / 100,
          menu_item_id: rand() < 0.9 ? pick(MENU).id : null,
        });
      }
    }
    if (rand() < 0.2) {
      refunds.push({ id: uuid(6, refunds.length + 1), order_id: o.id, amount: Math.floor(rand() * 200), status: pick(["approved", "approved", "pending", "denied"]) });
      if (rand() < 0.3) refunds.push({ id: uuid(6, refunds.length + 1), order_id: o.id, amount: 40, status: "approved" });
    }
  }
  // Where double arithmetic and exact decimals disagree: 200 × 7.25% is
  // 14.499999999999998 in JavaScript (→ 14), 14.5 exactly (→ 15). The SQL must
  // round as the settlement statement does.
  for (const [i, shop, food] of [[901, SHOPS[2], 200], [902, SHOPS[3], 500], [903, SHOPS[3], 1500]] as const) {
    orders.push({
      id: uuid(4, i), restaurant_id: shop.id, zone_id: shop.zone, customer_id: uuid(5, 1), status: "delivered",
      created_at: "2026-10-21T05:00:00Z", total: food, delivery_fee: 0, tax_amount: 0, tip: 0, discount: 0,
      discount_funded_by: null, payment_method: "online", payment_status: "paid", cancelled_by: null, cancellation_reason: null,
    });
  }
  const delivered = orders.filter((o) => o.status === "delivered");
  const PAID_SETTLEMENT = uuid(7, 1);
  const DRAFT_SETTLEMENT = uuid(7, 2);
  const paidLines = delivered.filter((_, i) => i % 3 === 0).map((o) => o.id);
  const draftLines = delivered.filter((_, i) => i % 3 === 1).map((o) => o.id);

  // Riders and tickets, for the counts.
  const DRIVERS = [uuid(8, 1), uuid(8, 2), uuid(8, 3), uuid(8, 4)];
  const now = new Date("2026-10-21T10:00:00Z");

  // ── database ───────────────────────────────────────────────────────────────
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.profiles (id uuid primary key, role text not null);
    create table public.restaurants (id uuid primary key, zone_id uuid, status text, is_open boolean,
      commission_pct numeric(5,2), other_charges_per_order integer, name text);
    create table public.menu_items (id uuid primary key, category text);
    create table public.orders (id uuid primary key, restaurant_id uuid, zone_id uuid, customer_id uuid,
      status text not null, created_at timestamptz not null, total numeric(10,2), delivery_fee numeric(10,2),
      tax_amount numeric(10,2), tip numeric(10,2), discount integer not null default 0, discount_funded_by text,
      payment_method text, payment_status text, cancelled_by text, cancellation_reason text);
    create table public.order_items (id serial primary key, order_id uuid, name text, qty integer, price numeric(10,2), menu_item_id uuid);
    create table public.refunds (id uuid primary key, order_id uuid, amount integer, status text);
    create table public.vendor_settlements (id uuid primary key, status text);
    create table public.vendor_settlement_orders (settlement_id uuid, order_id uuid unique);
    create table public.staff_zones (user_id uuid, zone_id uuid, primary key (user_id, zone_id));
    create table public.deliveries (id serial primary key, order_id uuid unique, driver_id uuid, status text);
    create table public.rider_status (driver_id uuid primary key, is_online boolean, break_until timestamptz);
    create table public.support_tickets (id serial primary key, status text, zone_id uuid);
    grant all on all tables in schema public to service_role, authenticated;
  `);
  await db.exec(readFileSync(new URL("../../supabase/migrations/0144_ops_metrics_rollups.sql", import.meta.url), "utf8"));

  for (const s of SHOPS) {
    await db.query(`insert into public.restaurants values ($1,$2,$3,$4,$5,$6,$7)`, [s.id, s.zone, s.status, s.open, s.pct, s.other, s.name]);
  }
  for (const m of MENU) await db.query(`insert into public.menu_items values ($1,$2)`, [m.id, m.category]);
  for (const o of orders) {
    await db.query(
      `insert into public.orders values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [o.id, o.restaurant_id, o.zone_id, o.customer_id, o.status, o.created_at, o.total, o.delivery_fee, o.tax_amount,
        o.tip, o.discount, o.discount_funded_by, o.payment_method, o.payment_status, o.cancelled_by, o.cancellation_reason]
    );
  }
  for (const it of items) {
    await db.query(`insert into public.order_items (order_id, name, qty, price, menu_item_id) values ($1,$2,$3,$4,$5)`,
      [it.order_id, it.name, it.qty, it.price, it.menu_item_id]);
  }
  for (const r of refunds) await db.query(`insert into public.refunds values ($1,$2,$3,$4)`, [r.id, r.order_id, r.amount, r.status]);
  await db.query(`insert into public.vendor_settlements values ($1,'paid'),($2,'draft')`, [PAID_SETTLEMENT, DRAFT_SETTLEMENT]);
  for (const id of paidLines) await db.query(`insert into public.vendor_settlement_orders values ($1,$2)`, [PAID_SETTLEMENT, id]);
  for (const id of draftLines) await db.query(`insert into public.vendor_settlement_orders values ($1,$2)`, [DRAFT_SETTLEMENT, id]);
  for (const d of DRIVERS) await db.query(`insert into public.profiles values ($1,'driver')`, [d]);
  await db.query(`insert into public.profiles values ($1,'manager')`, [uuid(8, 9)]);
  await db.query(`insert into public.staff_zones values ($1,$3),($2,$3),($2,$4),($5,$4),($6,$3)`, [DRIVERS[0], DRIVERS[1], ZONE1, ZONE2, DRIVERS[2], uuid(8, 9)]);
  await db.query(`insert into public.rider_status values ($1,true,null),($2,true,$4),($3,true,null),($5,false,null)`,
    [DRIVERS[0], DRIVERS[1], DRIVERS[2], "2026-10-21T11:00:00Z", DRIVERS[3]]);
  const activeOrders = orders.filter((o) => o.status === "on_the_way" || o.status === "ready").slice(0, 3);
  await db.query(`insert into public.deliveries (order_id, driver_id, status) values ($1,$4,'picked_up'),($2,$4,'assigned'),($3,$5,'assigned')`,
    [activeOrders[0].id, activeOrders[1].id, activeOrders[2].id, DRIVERS[0], DRIVERS[2]]);
  await db.query(`insert into public.support_tickets (status, zone_id) values ('open',$1),('escalated',$1),('closed',$1),('in_progress',$2)`, [ZONE1, ZONE2]);

  // ── reference inputs ───────────────────────────────────────────────────────
  const menuCategory = new Map(MENU.map((m) => [m.id, m.category]));
  function toMetric(o: OrderFx): MetricOrder {
    return {
      id: o.id, restaurantId: o.restaurant_id, zoneId: o.zone_id, customerId: o.customer_id,
      status: o.status as MetricOrder["status"], createdAt: o.created_at,
      total: o.total, deliveryFee: o.delivery_fee, taxAmount: o.tax_amount, tip: o.tip, discount: o.discount,
      discountFundedBy: (o.discount_funded_by as MetricOrder["discountFundedBy"]) ?? null,
      paymentMethod: o.payment_method as MetricOrder["paymentMethod"],
      paymentStatus: o.payment_status as MetricOrder["paymentStatus"],
      cancelledBy: o.cancelled_by as MetricOrder["cancelledBy"], cancellationReason: o.cancellation_reason,
      items: items.filter((it) => it.order_id === o.id).map((it) => ({
        name: it.name, qty: it.qty, price: it.price, menuItemId: it.menu_item_id,
        category: it.menu_item_id ? menuCategory.get(it.menu_item_id) ?? null : null,
      })),
    };
  }
  const metricRefunds: MetricRefund[] = refunds.map((r) => ({ id: r.id, orderId: r.order_id, amount: r.amount, status: r.status as MetricRefund["status"] }));
  const pricing: PricingContext = {
    commissionPct: new Map(SHOPS.map((s) => [s.id, Math.min(100, Math.max(0, s.pct ?? DEFAULT_PCT))])),
    otherCharges: new Map(SHOPS.map((s) => [s.id, s.other])),
    commissionGstPct: GST,
  };
  const names = new Map(SHOPS.map((s) => [s.id, s.name]));

  // ── dashboard ──────────────────────────────────────────────────────────────
  const today = istDayKey(now);
  const todayStart = istDayStart(today);
  const todayEnd = istDayStart(addDays(today, 1));

  async function dashboardRollup(zones: string[] | null): Promise<DashboardRollup> {
    const { rows } = await db.query<{ r: DashboardRollup }>(
      `select public.ops_dashboard_rollup($1::uuid[], $2, $3, $4, $5, $6) as r`,
      [zones, todayStart.toISOString(), todayEnd.toISOString(), now.toISOString(), DEFAULT_PCT, GST]
    );
    return rows[0].r;
  }

  for (const [label, zones] of [["all zones", null], ["zone 1", [ZONE1]], ["zone 2", [ZONE2]], ["no zones", []]] as const) {
    console.log(`\n── dashboard, ${label} ──`);
    const inScope = orders.filter((o) => zones === null || (zones as readonly string[]).includes(o.zone_id)).map(toMetric);
    const counts = { activeVendors: 0, onlineVendors: 0, activeRiders: 0, onlineRiders: 0, ridersOnDelivery: 0, riderPaymentsDue: 0, pendingMarketingRequests: 0, pendingSupportTickets: 0 };
    const ref = computeDashboard(inScope, { now, refunds: metricRefunds, pricing, paidOrderIds: new Set(paidLines), counts });
    const roll = await dashboardRollup(zones === null ? null : [...zones]);
    const { dashboard, unavailable } = dashboardFromRollup(roll, today);
    const orderKeys = ["todaysTotalSales", "totalSales", "todaysOrders", "totalOrders", "pendingOrders", "completedOrders",
      "cancelledOrders", "totalDeliveryFees", "totalPlatformCommission", "vendorPaymentsDue"] as const;
    for (const k of orderKeys) check(`${k} matches (${ref.figures[k]})`, dashboard.figures[k] === ref.figures[k], { sql: dashboard.figures[k], ts: ref.figures[k] });
    check("today is the IST day", dashboard.today === ref.today);
    const zoneShops = SHOPS.filter((s) => zones === null || (zones as readonly string[]).includes(s.zone));
    check("active vendors", dashboard.figures.activeVendors === zoneShops.filter((s) => s.status === "active").length, dashboard.figures.activeVendors);
    check("online vendors = active and open", dashboard.figures.onlineVendors === zoneShops.filter((s) => s.status === "active" && s.open).length);
    const expectRiders = zones === null ? 4 : zones.length === 0 ? 0 : (zones as readonly string[]).includes(ZONE1) ? 2 : 2;
    check("active riders (staff_zones / all drivers)", dashboard.figures.activeRiders === expectRiders, dashboard.figures.activeRiders);
    const expectOnline = zones === null ? 2 : zones.length === 0 ? 0 : (zones as readonly string[]).includes(ZONE1) ? 1 : 1;
    check("online riders exclude the one on a break and the offline one", dashboard.figures.onlineRiders === expectOnline, dashboard.figures.onlineRiders);
    check("rider pay stays unavailable until Phase 5", unavailable.includes("riderPaymentsDue"));
    check("marketing requests unavailable (table absent)", unavailable.includes("pendingMarketingRequests"));
    const expectTickets = zones === null ? 3 : zones.length === 0 ? 0 : (zones as readonly string[]).includes(ZONE1) ? 2 : 1;
    check("pending support tickets (open/in progress/escalated)", dashboard.figures.pendingSupportTickets === expectTickets, dashboard.figures.pendingSupportTickets);
  }

  // ── statistics ─────────────────────────────────────────────────────────────
  async function statsRollup(zones: string[] | null, range: DateRange, summaryOnly = false, restaurant: string | null = null): Promise<StatsRollup> {
    const b = rangeBounds(range);
    const { rows } = await db.query<{ r: StatsRollup }>(
      `select public.ops_stats_rollup($1::uuid[], $2, $3, $4, $5) as r`,
      [zones, b.start.toISOString(), b.endExclusive.toISOString(), restaurant, summaryOnly]
    );
    return rows[0].r;
  }

  const cases: { label: string; range: DateRange; g: Granularity; zones: string[] | null; shop?: string }[] = [
    { label: "3 days, all zones", range: { from: "2026-10-19", to: "2026-10-21" }, g: "day", zones: null },
    { label: "5 days by week, zone 1", range: { from: "2026-10-17", to: "2026-10-21" }, g: "week", zones: [ZONE1] },
    { label: "month buckets, zone 2", range: { from: "2026-10-01", to: "2026-10-22" }, g: "month", zones: [ZONE2] },
    { label: "one shop", range: { from: "2026-10-18", to: "2026-10-22" }, g: "day", zones: null, shop: SHOPS[0].id },
    { label: "no zones", range: { from: "2026-10-18", to: "2026-10-22" }, g: "day", zones: [] },
  ];
  for (const c of cases) {
    console.log(`\n── stats, ${c.label} ──`);
    const prevRange = previousPeriod(c.range);
    const scoped = orders
      .filter((o) => c.zones === null || c.zones.includes(o.zone_id))
      .filter((o) => !c.shop || o.restaurant_id === c.shop)
      .map(toMetric);
    const current = scoped.filter((o) => inRange(o.createdAt, c.range));
    const previous = scoped.filter((o) => inRange(o.createdAt, prevRange));
    const ref = computeStats(current, previous, metricRefunds, c.range, { granularity: c.g, names, limit: 10 });
    const [cur, prev] = await Promise.all([
      statsRollup(c.zones, c.range, false, c.shop ?? null),
      statsRollup(c.zones, prevRange, true, c.shop ?? null),
    ]);
    const got = statsFromRollup(cur, prev, c.range, { granularity: c.g, names, limit: 10 });
    for (const k of Object.keys(ref) as (keyof typeof ref)[]) {
      check(`${k} matches`, same(got.stats[k], ref[k]), firstDiff(got.stats[k], ref[k]));
    }
    check("daily series matches dailySeries", same(got.daily, dailySeries(current, c.range)), firstDiff(got.daily, dailySeries(current, c.range)));
    check("previous AOV matches", got.previousAverageOrderValue === averageOrderValue(previous), { sql: got.previousAverageOrderValue, ts: averageOrderValue(previous) });
    check("fixture is non-trivial", c.zones?.length === 0 || ref.summary.orders > 0, ref.summary.orders);
  }

  // ── access ─────────────────────────────────────────────────────────────────
  console.log("\n── access ──");
  for (const role of ["authenticated", "anon"]) {
    let denied = false;
    try {
      await db.exec(`set role ${role}`);
      await db.query(`select public.ops_dashboard_rollup(null, now(), now(), now(), 0, 0)`);
    } catch (e) {
      denied = /permission denied/i.test(String(e));
    } finally {
      await db.exec(`reset role`);
    }
    check(`${role} cannot call ops_dashboard_rollup`, denied);
    denied = false;
    try {
      await db.exec(`set role ${role}`);
      await db.query(`select public.ops_stats_rollup(null, now(), now(), null, true)`);
    } catch (e) {
      denied = /permission denied/i.test(String(e));
    } finally {
      await db.exec(`reset role`);
    }
    check(`${role} cannot call ops_stats_rollup`, denied);
  }
  {
    await db.exec(`set role service_role`);
    const { rows } = await db.query<{ ok: boolean }>(`select public.ops_dashboard_rollup(null, now(), now(), now(), 0, 0) is not null as ok`);
    await db.exec(`reset role`);
    check("service_role can call it", rows[0].ok === true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
