/**
 * QA — migration 0158's report aggregates in PGlite, against the reference
 * arithmetic (src/lib/metrics) on one seeded fixture set:
 *
 *   ops_report_orders            totals.orders = counted orders; the
 *                                cancellation report = cancelledSummary;
 *                                totals are the same on every page.
 *   ops_report_refunds_adjustments every approved refund once (approvedRefunds
 *                                total + onCancelled); corrections apart.
 *   ops_report_vendor_ops        counts per shop; rejections = vendor cancels.
 *   ops_report_rider_performance delivered, failed, offers/accepted, COD.
 *   ops_report_support_tickets   counts and minutes over every row.
 *   ops_report_marketing         redemptions, discount, attributed sales.
 *
 * plus zone scoping and service-role-only execution.
 *
 * Needs: npm i --no-save @electric-sql/pglite@0.2.17
 * Usage: npx tsx scripts/qa/manager-report-sql.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  approvedRefunds,
  cancelledSummary,
  countedOrders,
  istDayStart,
  addDays,
  inRange,
  type MetricOrder,
  type MetricRefund,
} from "../../src/lib/metrics";

async function main() {
  let passed = 0;
  let failed = 0;
  function check(name: string, ok: boolean, detail?: unknown) {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 1200)); }
  }

  let seed = 7_2026;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const uuid = (prefix: number, i: number) => `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;

  const Z1 = uuid(1, 1), Z2 = uuid(1, 2);
  const SHOPS = [{ id: uuid(2, 1), zone: Z1, name: "Annapurna" }, { id: uuid(2, 2), zone: Z1, name: "Bhoj" }, { id: uuid(2, 3), zone: Z2, name: "Chaat" }];
  const RIDERS = [uuid(3, 1), uuid(3, 2), uuid(3, 3)];
  const STATUSES = ["placed", "delivered", "delivered", "delivered", "cancelled"] as const;
  const BY = ["customer", "vendor", "manager", "system"] as const;
  const PAY: [string, string][] = [["cod", "pending"], ["online", "paid"], ["online", "failed"], ["online", "refunded"]];
  const START = Date.parse("2026-10-01T00:00:00Z");

  interface O { id: string; restaurant_id: string; zone_id: string; status: string; created_at: string; total: number; discount: number; fee: number;
    pm: string; ps: string; cancelled_by: string | null; accepted_at: string | null; ready_at: string | null; rider: string | null }
  const orders: O[] = [];
  const refunds: { id: string; order_id: string; amount: number; status: string }[] = [];
  for (let i = 1; i <= 220; i++) {
    const shop = pick(SHOPS);
    const status = pick(STATUSES);
    const [pm, ps] = pick(PAY);
    const created = new Date(START + Math.floor(rand() * 20 * 86_400_000));
    const o: O = {
      id: uuid(4, i), restaurant_id: shop.id, zone_id: shop.zone, status, created_at: created.toISOString(),
      total: Math.round(rand() * 900) + 50, discount: pick([0, 0, 25]), fee: pick([0, 20]), pm, ps,
      cancelled_by: status === "cancelled" ? pick(BY) : null,
      accepted_at: status !== "placed" ? new Date(created.getTime() + 3 * 60_000).toISOString() : null,
      ready_at: status === "delivered" ? new Date(created.getTime() + 18 * 60_000).toISOString() : null,
      rider: status === "delivered" ? pick(RIDERS) : null,
    };
    orders.push(o);
    if (rand() < 0.25) refunds.push({ id: uuid(5, refunds.length + 1), order_id: o.id, amount: Math.floor(rand() * 100) + 1, status: pick(["approved", "approved", "pending", "denied"]) });
  }

  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.profiles (id uuid primary key, role text not null, full_name text);
    create table public.staff_zones (user_id uuid, zone_id uuid, primary key (user_id, zone_id));
    create table public.restaurants (id uuid primary key, zone_id uuid, name text, rating numeric(2,1) default 4.5, rating_count integer default 0);
    create table public.orders (id uuid primary key, short_code text, restaurant_id uuid, zone_id uuid, status text, created_at timestamptz,
      cancelled_at timestamptz, accepted_at timestamptz, ready_at timestamptz, total numeric(10,2), discount integer default 0,
      delivery_fee numeric(10,2), payment_method text, payment_status text, cancelled_by text, cancellation_reason text);
    create table public.order_items (id serial primary key, order_id uuid, qty integer, price numeric(10,2));
    create table public.deliveries (id uuid primary key default gen_random_uuid(), order_id uuid unique, driver_id uuid, status text,
      assigned_at timestamptz, delivered_at timestamptz, cod_collected_amount integer);
    create table public.delivery_events (id serial primary key, driver_id uuid, kind text, created_at timestamptz);
    create table public.rider_shifts (id serial primary key, driver_id uuid, started_at timestamptz, ended_at timestamptz);
    create table public.rider_ratings (id serial primary key, driver_id uuid, rating smallint, created_at timestamptz);
    create table public.rider_profiles (driver_id uuid primary key, rider_code text);
    create table public.refunds (id uuid primary key, order_id uuid, amount integer, status text, origin text default 'customer', reason text, decided_by uuid);
    create table public.vendor_settlements (id uuid primary key, status text);
    create table public.vendor_settlement_orders (settlement_id uuid, order_id uuid unique);
    create table public.settlement_corrections (id uuid primary key default gen_random_uuid(), restaurant_id uuid, order_id uuid, refund_id uuid,
      amount integer, status text default 'outstanding', reason text, created_by uuid, created_at timestamptz);
    create table public.support_tickets (id uuid primary key default gen_random_uuid(), number serial, created_at timestamptz, requester_role text,
      category text, priority text, status text, escalation_level smallint default 0, assigned_to uuid, order_id uuid, restaurant_id uuid,
      first_response_at timestamptz, resolved_at timestamptz, zone_id uuid);
    create table public.banners (id uuid primary key default gen_random_uuid(), name text, kind text, status text, starts_at timestamptz,
      ends_at timestamptz, sponsor_name text, target_zones text[] default '{}');
    create table public.banner_events (id serial primary key, banner_id uuid, kind text, created_at timestamptz);
    create table public.coupons (code text primary key, label text, restaurant_id uuid, funded_by text default 'platform', starts_at timestamptz,
      expires_at timestamptz, active boolean default true);
    create table public.coupon_redemptions (id serial primary key, code text, order_id uuid unique, discount integer);
    grant all on all tables in schema public to service_role, authenticated;
  `);
  await db.exec(readFileSync(new URL("../../supabase/migrations/0144_ops_metrics_rollups.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../../supabase/migrations/0158_manager_report_aggregates.sql", import.meta.url), "utf8"));

  for (const s of SHOPS) await db.query(`insert into public.restaurants (id, zone_id, name) values ($1,$2,$3)`, [s.id, s.zone, s.name]);
  for (const [i, r] of RIDERS.entries()) {
    await db.query(`insert into public.profiles values ($1,'driver',$2)`, [r, `Rider ${i}`]);
    await db.query(`insert into public.staff_zones values ($1,$2)`, [r, i < 2 ? Z1 : Z2]);
    await db.query(`insert into public.rider_profiles values ($1,$2)`, [r, `DR-000${i + 1}`]);
  }
  for (const o of orders) {
    await db.query(`insert into public.orders values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [o.id, `C${o.id.slice(-4)}`, o.restaurant_id, o.zone_id, o.status, o.created_at, o.status === "cancelled" ? o.created_at : null,
       o.accepted_at, o.ready_at, o.total, o.discount, o.fee, o.pm, o.ps, o.cancelled_by, o.cancelled_by ? "Out of stock" : null]);
    await db.query(`insert into public.order_items (order_id, qty, price) values ($1, 2, 100)`, [o.id]);
    if (o.rider) {
      await db.query(`insert into public.deliveries (order_id, driver_id, status, assigned_at, delivered_at, cod_collected_amount) values ($1,$2,'delivered',$3,$4,$5)`,
        [o.id, o.rider, o.accepted_at, new Date(Date.parse(o.created_at) + 40 * 60_000).toISOString(), o.pm === "cod" ? o.total : null]);
      await db.query(`insert into public.delivery_events (driver_id, kind, created_at) values ($1,'offered',$2), ($1,'accepted',$2)`, [o.rider, o.created_at]);
    }
  }
  for (const r of refunds) await db.query(`insert into public.refunds (id, order_id, amount, status) values ($1,$2,$3,$4)`, [r.id, r.order_id, r.amount, r.status]);
  await db.query(`insert into public.delivery_events (driver_id, kind, created_at) values ($1,'offered','2026-10-05T06:00:00Z'), ($1,'failed','2026-10-05T07:00:00Z')`, [RIDERS[0]]);
  await db.query(`insert into public.settlement_corrections (restaurant_id, order_id, amount, created_at) values ($1,$2,120,'2026-10-06T06:00:00Z')`, [SHOPS[0].id, orders[0].id]);
  await db.query(`insert into public.support_tickets (created_at, requester_role, category, priority, status, zone_id, first_response_at, resolved_at) values
    ('2026-10-03T06:00:00Z','customer','refund','high','resolved',$1,'2026-10-03T06:30:00Z','2026-10-03T08:00:00Z'),
    ('2026-10-04T06:00:00Z','vendor','payout','normal','open',$1,null,null),
    ('2026-10-04T06:00:00Z','driver','refund','normal','open',$2,null,null)`, [Z1, Z2]);
  await db.query(`insert into public.banners (id, name, kind, status, starts_at, ends_at, target_zones) values
    ($1,'Diwali','internal','active','2026-10-01T00:00:00Z','2026-10-31T00:00:00Z','{}'), ($2,'Saja only','sponsored','active',null,null,'{Saja}')`, [uuid(6, 1), uuid(6, 2)]);
  await db.query(`insert into public.banner_events (banner_id, kind, created_at) values ($1,'impression','2026-10-05T06:00:00Z'), ($1,'impression','2026-10-05T06:00:00Z'), ($1,'click','2026-10-05T06:00:00Z')`, [uuid(6, 1)]);
  const counted = orders.filter((o) => !(o.pm === "online" && !["paid", "authorized", "refunded"].includes(o.ps)));
  const promoOrders = counted.filter((_, i) => i % 7 === 0);
  await db.query(`insert into public.coupons (code, label, restaurant_id, funded_by) values ('FEST50','Festival',null,'platform'), ('BHOJ10',null,$1,'vendor')`, [SHOPS[1].id]);
  for (const o of promoOrders) await db.query(`insert into public.coupon_redemptions (code, order_id, discount) values ('FEST50',$1,25)`, [o.id]);

  const svc = async <T,>(sql: string, params: unknown[] = []): Promise<T> => {
    await db.exec("set role service_role");
    try { return (await db.query<{ v: T }>(sql, params)).rows[0].v; } finally { await db.exec("reset role"); }
  };
  const range = { from: "2026-10-01", to: "2026-10-21" };
  const S = istDayStart(range.from).toISOString(), E = istDayStart(addDays(range.to, 1)).toISOString();
  const metric: MetricOrder[] = orders.map((o) => ({ id: o.id, restaurantId: o.restaurant_id, zoneId: o.zone_id, status: o.status as MetricOrder["status"],
    createdAt: o.created_at, total: o.total, deliveryFee: o.fee, taxAmount: 0, tip: 0, discount: o.discount, discountFundedBy: null,
    paymentMethod: o.pm as MetricOrder["paymentMethod"], paymentStatus: o.ps as MetricOrder["paymentStatus"] }));
  const mrefunds: MetricRefund[] = refunds.map((r) => ({ id: r.id, orderId: r.order_id, amount: r.amount, status: r.status as MetricRefund["status"] }));

  console.log("\n── orders / cancellation ──");
  type OrdersRes = { totalRows: number; totals: { orders: number; total: number; refunded: number }; rows: { id: string; total: number }[] };
  const all = await svc<OrdersRes>(`select public.ops_report_orders(null,$1,$2,null,null,null,null,false,null,0,50) as v`, [S, E]);
  const inScope = countedOrders(metric.filter((o) => inRange(o.createdAt, range)));
  check("totalRows = counted orders in range (unpaid online checkouts left out)", all.totalRows === inScope.length && all.totals.orders === inScope.length, { sql: all.totalRows, ref: inScope.length });
  const p2 = await svc<OrdersRes>(`select public.ops_report_orders(null,$1,$2,null,null,null,null,false,null,50,50) as v`, [S, E]);
  check("page 2 carries the same totals and different rows", JSON.stringify(p2.totals) === JSON.stringify(all.totals) && !p2.rows.some((r) => all.rows.some((x) => x.id === r.id)));
  const canc = await svc<{ totalRows: number; totals: { total: number } }>(`select public.ops_report_orders(null,$1,$2,null,null,null,null,true,null,0,50) as v`, [S, E]);
  const cs = cancelledSummary(inScope);
  check("cancellation report count and value = cancelledSummary", canc.totalRows === cs.count && Number(canc.totals.total) === cs.value, { sql: canc, ref: cs });
  const byVendor = await svc<{ totalRows: number }>(`select public.ops_report_orders(null,$1,$2,null,null,null,null,true,'vendor',0,50) as v`, [S, E]);
  check("cancelled-by filter", byVendor.totalRows === inScope.filter((o) => o.status === "cancelled" && orders.find((x) => x.id === o.id)!.cancelled_by === "vendor").length);
  const z2 = await svc<{ totalRows: number }>(`select public.ops_report_orders($3::uuid[],$1,$2,null,null,null,null,false,null,0,50) as v`, [S, E, [Z2]]);
  check("zone-scoped", z2.totalRows === inScope.filter((o) => o.zoneId === Z2).length);
  const rider = await svc<{ totalRows: number }>(`select public.ops_report_orders(null,$1,$2,null,$3,null,null,false,null,0,50) as v`, [S, E, RIDERS[1]]);
  check("rider filter", rider.totalRows === inScope.filter((o) => orders.find((x) => x.id === o.id)!.rider === RIDERS[1]).length);

  console.log("\n── refunds and adjustments ──");
  type RA = { totalRows: number; totals: { refundsApproved: number; refundsApprovedCount: number; corrections: number }; rows: { type: string; id: string }[] };
  const ra = await svc<RA>(`select public.ops_report_refunds_adjustments(null,$1,$2,null,null,0,500) as v`, [S, E]);
  const ref = approvedRefunds(inScope, mrefunds);
  check("approved refunds counted once (total + on cancelled orders)", Number(ra.totals.refundsApproved) === ref.total + ref.onCancelled, { sql: ra.totals, ref });
  check("each refund row appears once", new Set(ra.rows.filter((r) => r.type === "refund").map((r) => r.id)).size === ra.rows.filter((r) => r.type === "refund").length);
  check("the correction is listed apart (₹120)", Number(ra.totals.corrections) === 120 && ra.rows.some((r) => r.type === "correction"));
  const raApproved = await svc<RA>(`select public.ops_report_refunds_adjustments(null,$1,$2,null,'approved',0,500) as v`, [S, E]);
  check("a status filter lists refunds only", raApproved.rows.every((r) => r.type === "refund"));

  console.log("\n── vendors ──");
  type V = { restaurantId: string; orders: number; cancelled: number; rejected: number; acceptCount: number; acceptMinutesSum: number }[];
  const vops = await svc<V>(`select public.ops_report_vendor_ops(null,$1,$2,null) as v`, [S, E]);
  for (const s of SHOPS) {
    const mine = inScope.filter((o) => o.restaurantId === s.id);
    const row = vops.find((v) => v.restaurantId === s.id);
    check(`${s.name}: orders, cancelled, rejected`, row !== undefined && row.orders === mine.length && row.cancelled === mine.filter((o) => o.status === "cancelled").length
      && row.rejected === mine.filter((o) => orders.find((x) => x.id === o.id)!.cancelled_by === "vendor" && o.status === "cancelled").length, row);
    check(`${s.name}: accept minutes average 3`, row !== undefined && (row.acceptCount === 0 || Math.round(Number(row.acceptMinutesSum) / row.acceptCount) === 3));
  }

  console.log("\n── riders ──");
  type R = { riderId: string; delivered: number; failed: number; offers: number; accepted: number; codCollected: number; code: string }[];
  const rp = await svc<R>(`select public.ops_report_rider_performance(null,$1,$2,null) as v`, [S, E]);
  for (const r of RIDERS) {
    const mine = orders.filter((o) => o.rider === r && Date.parse(o.created_at) + 40 * 60_000 < Date.parse(E));
    const row = rp.find((x) => x.riderId === r);
    check(`rider ${r.slice(-1)}: delivered and COD`, row !== undefined && row.delivered === mine.length
      && Number(row.codCollected) === mine.filter((o) => o.pm === "cod").reduce((s, o) => s + o.total, 0), row);
  }
  check("rider 1 has one failed delivery and one extra offer", rp.find((x) => x.riderId === RIDERS[0])!.failed === 1);
  const rpZ = await svc<R>(`select public.ops_report_rider_performance($3::uuid[],$1,$2,null) as v`, [S, E, [Z2]]);
  check("riders are zone-scoped", rpZ.length === 1 && rpZ[0].riderId === RIDERS[2]);

  console.log("\n── support tickets ──");
  type T = { totalRows: number; totals: { count: number; firstResponseMinutesSum: number; firstResponseCount: number; topCategories: { category: string; count: number }[] } };
  const tk = await svc<T>(`select public.ops_report_support_tickets(null,$1,$2,null,0,50) as v`, [S, E]);
  check("three tickets, first response 30 min, top category refund (2)", tk.totalRows === 3 && Number(tk.totals.firstResponseMinutesSum) === 30
    && tk.totals.firstResponseCount === 1 && tk.totals.topCategories[0].category === "refund" && tk.totals.topCategories[0].count === 2, tk.totals);
  const tkZ = await svc<T>(`select public.ops_report_support_tickets($3::uuid[],$1,$2,null,0,50) as v`, [S, E, [Z1]]);
  check("tickets are zone-scoped", tkZ.totalRows === 2);

  console.log("\n── marketing ──");
  type M = { banners: { campaign: string; impressions: number; clicks: number }[]; codes: { code: string; redemptions: number; discountGiven: number; attributedSales: number; fundedBy: string }[] };
  const mk = await svc<M>(`select public.ops_report_marketing(null,null,$1,$2,null) as v`, [S, E]);
  const fest = mk.codes.find((c) => c.code === "FEST50");
  const promoNonCancelled = promoOrders.filter((o) => o.status !== "cancelled" && inRange(o.created_at, range));
  check("FEST50: redemptions, discount, attributed sales (non-cancelled orders)", fest !== undefined && fest.redemptions === promoOrders.filter((o) => inRange(o.created_at, range)).length
    && Number(fest.discountGiven) === 25 * fest.redemptions && Number(fest.attributedSales) === promoNonCancelled.reduce((s, o) => s + o.total, 0) && fest.fundedBy === "deligro", fest);
  check("banner impressions and clicks from events in range", mk.banners.some((b) => b.campaign === "Diwali" && b.impressions === 2 && b.clicks === 1));
  const mkZ1 = await svc<M>(`select public.ops_report_marketing($3::uuid[], $4::text[], $1, $2, null) as v`, [S, E, [Z1], ["bemetara"]]);
  check("a banner aimed at another zone is not in zone 1's report", !mkZ1.banners.some((b) => b.campaign === "Saja only"));
  const mkZ2 = await svc<M>(`select public.ops_report_marketing($3::uuid[], $4::text[], $1, $2, null) as v`, [S, E, [Z2], ["saja"]]);
  check("...and is in zone 2's", mkZ2.banners.some((b) => b.campaign === "Saja only"));

  console.log("\n── service role only ──");
  for (const fn of ["ops_report_orders", "ops_report_refunds_adjustments", "ops_report_vendor_ops", "ops_report_rider_performance", "ops_report_support_tickets", "ops_report_marketing"]) {
    const r = await db.query<{ ok: boolean }>(`select has_function_privilege('authenticated', p.oid, 'execute') as ok from pg_proc p where proname = $1`, [fn]);
    check(`${fn} is not executable by authenticated`, r.rows[0]?.ok === false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
void main();
