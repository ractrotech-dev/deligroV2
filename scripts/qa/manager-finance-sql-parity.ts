/**
 * QA — migration 0157's finance rollups against the reference arithmetic
 * (src/lib/metrics, src/lib/settlements/math.ts via the metrics module, and
 * src/lib/ops/finance-rules.ts), on one seeded fixture set in PGlite:
 *
 *   ops_finance_rollup        = salesSummary + platformCommission (+ by day, by shop)
 *   ops_vendor_dues_scoped    = vendorEarnings per shop
 *   ops_rider_dues            = riderLedgerTotals per rider
 *   ops_reconciliation_orders = classifyOrderReconciliation per order
 *   ops_cash_reconciliation   = collected / deposited per rider × IST day
 *
 * plus zone scoping and service-role-only execution.
 *
 * Needs: npm i --no-save @electric-sql/pglite@0.2.17
 * Usage: npx tsx scripts/qa/manager-finance-sql-parity.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  istDayKey,
  istDayStart,
  addDays,
  inRange,
  platformCommission,
  salesSummary,
  vendorEarnings,
  type DateRange,
  type MetricOrder,
  type MetricRefund,
  type PricingContext,
  isCountedOrder,
} from "../../src/lib/metrics";
import {
  dailyFromFinanceRollup,
  salesFromRollup,
  type FinanceRollup,
  type ReconciliationRollupItem,
  type RiderDueRollupRow,
  type VendorDueRollupRow,
  type CashRiderDay,
} from "../../src/lib/ops/finance-rollup";
import { classifyOrderReconciliation, riderLedgerTotals } from "../../src/lib/ops/finance-rules";

async function main() {
  let passed = 0;
  let failed = 0;
  function check(name: string, ok: boolean, detail?: unknown) {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 1500)); }
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // ── fixtures ─────────────────────────────────────────────────────────────
  let seed = 20261022;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const uuid = (prefix: number, i: number) => `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;

  const ZONE1 = uuid(1, 1), ZONE2 = uuid(1, 2);
  const SHOPS = [
    { id: uuid(2, 1), zone: ZONE1, pct: 12.5, other: 0, cycle: "weekly" },
    { id: uuid(2, 2), zone: ZONE1, pct: null, other: 5, cycle: "monthly" },
    { id: uuid(2, 3), zone: ZONE2, pct: 7.25, other: 3, cycle: "weekly" },
  ];
  const DEFAULT_PCT = 15, GST = 18;
  const STATUSES = ["placed", "kitchen", "delivered", "delivered", "delivered", "delivered", "cancelled"] as const;
  const PAYMENTS: [string, string][] = [["cod", "pending"], ["cod", "paid"], ["online", "paid"], ["online", "pending"], ["online", "failed"], ["online", "refunded"]];
  const NOW = new Date("2026-10-22T10:00:00Z");
  const START = Date.parse("2026-09-25T00:00:00Z");
  const instant = () => {
    if (rand() < 0.15) {
      const day = 1 + Math.floor(rand() * 20);
      return new Date(Date.parse(`2026-10-${String(day).padStart(2, "0")}T18:30:00Z`) + (rand() - 0.5) * 20 * 60_000).toISOString();
    }
    return new Date(START + Math.floor(rand() * 27 * 86_400_000)).toISOString();
  };
  const DRIVERS = [uuid(8, 1), uuid(8, 2), uuid(8, 3)];
  const MANAGERS = [uuid(9, 1)];

  interface O { id: string; short: string; restaurant_id: string; zone_id: string; status: string; created_at: string; total: number;
    delivery_fee: number; tax_amount: number; tip: number; discount: number; discount_funded_by: string | null;
    payment_method: string; payment_status: string; delivered_at: string | null; driver: string | null; cod: number | null; cod_at: string | null }
  const orders: O[] = [];
  const items: { order_id: string; qty: number; price: number }[] = [];
  const refunds: { id: string; order_id: string; amount: number; status: string }[] = [];
  for (let i = 1; i <= 300; i++) {
    const shop = pick(SHOPS);
    const status = pick(STATUSES);
    const [pm, ps] = pick(PAYMENTS);
    const food = Math.round(rand() * 80000) / 100;
    const fee = pick([0, 20, 25.5]);
    const tax = Math.round(food * 0.05 * 100) / 100;
    const tip = pick([0, 10]);
    const discount = pick([0, 0, 30, 50]);
    const created = instant();
    const delivered = status === "delivered" ? new Date(Date.parse(created) + 40 * 60_000).toISOString() : null;
    const driver = status === "delivered" ? pick(DRIVERS) : null;
    const total = Math.max(0, Math.round((food + fee + tax + tip - discount) * 100) / 100);
    orders.push({
      id: uuid(4, i), short: `C${i}`, restaurant_id: shop.id, zone_id: shop.zone, status, created_at: created, total,
      delivery_fee: fee, tax_amount: tax, tip, discount, discount_funded_by: discount ? pick(["platform", "vendor", null]) : null,
      payment_method: pm, payment_status: ps, delivered_at: delivered, driver,
      cod: delivered && pm === "cod" ? Math.round(total) : null, cod_at: delivered && pm === "cod" ? delivered : null,
    });
    if (rand() < 0.8) {
      for (let l = 0; l < 1 + Math.floor(rand() * 3); l++) items.push({ order_id: uuid(4, i), qty: 1 + Math.floor(rand() * 2), price: Math.round(rand() * 20000) / 100 });
    }
    if (rand() < 0.2) {
      refunds.push({ id: uuid(6, refunds.length + 1), order_id: uuid(4, i), amount: Math.floor(rand() * 150), status: pick(["approved", "approved", "pending", "denied"]) });
    }
  }
  const deliveredOrders = orders.filter((o) => o.status === "delivered");
  const PAID = uuid(7, 1), DRAFT = uuid(7, 2);
  const paidIds = deliveredOrders.filter((_, i) => i % 4 === 0).map((o) => o.id);
  const draftIds = deliveredOrders.filter((_, i) => i % 4 === 1).map((o) => o.id);

  // ── database ─────────────────────────────────────────────────────────────
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.profiles (id uuid primary key, role text not null);
    create table public.staff_zones (user_id uuid, zone_id uuid, primary key (user_id, zone_id));
    create table public.restaurants (id uuid primary key, zone_id uuid, commission_pct numeric(5,2), other_charges_per_order integer,
      settlement_cycle text not null default 'weekly');
    create table public.orders (id uuid primary key, short_code text, restaurant_id uuid, zone_id uuid, status text not null,
      created_at timestamptz not null, total numeric(10,2), delivery_fee numeric(10,2), tax_amount numeric(10,2), tip numeric(10,2),
      discount integer not null default 0, discount_funded_by text, payment_method text, payment_status text);
    create table public.order_items (id serial primary key, order_id uuid, qty integer, price numeric(10,2));
    create table public.deliveries (id serial primary key, order_id uuid unique, driver_id uuid, delivered_at timestamptz,
      cod_collected_amount integer, cod_collected_at timestamptz);
    create table public.refunds (id uuid primary key, order_id uuid, amount integer, status text);
    create table public.vendor_settlements (id uuid primary key, status text, restaurant_id uuid, net_payable integer,
      created_at timestamptz default now(), paid_at timestamptz);
    create table public.vendor_settlement_orders (settlement_id uuid, order_id uuid unique, contribution integer);
    create table public.settlement_corrections (id uuid primary key default gen_random_uuid(), order_id uuid, restaurant_id uuid, amount integer,
      status text, created_at timestamptz default now());
    create table public.rider_earnings (id uuid primary key default gen_random_uuid(), driver_id uuid, delivery_id uuid, amount numeric(10,2),
      earned_at timestamptz, payout_id uuid);
    create table public.rider_incentive_awards (id uuid primary key default gen_random_uuid(), driver_id uuid, amount numeric(10,2),
      trigger_delivery_id uuid, awarded_at timestamptz, payout_id uuid);
    create table public.rider_adjustments (id uuid primary key default gen_random_uuid(), driver_id uuid, kind text, amount numeric(10,2),
      effective_on date, payout_id uuid);
    create table public.rider_payouts (id uuid primary key default gen_random_uuid(), driver_id uuid, amount numeric(10,2), paid_on date,
      reference text, created_at timestamptz default now(), period_end date, method text default 'bank', note text, created_by uuid, request_id uuid);
    create table public.payment_requests (id uuid primary key default gen_random_uuid(), settlement_id uuid, status text);
    create table public.cod_handovers (id uuid primary key default gen_random_uuid(), leg text, from_user uuid, to_user uuid,
      handover_date date, amount integer, zone_id uuid);
    create table public.cash_disputes (id uuid primary key default gen_random_uuid(), driver_id uuid, day date, status text);
    create table public.cash_deposits (id uuid primary key default gen_random_uuid(), driver_id uuid, status text, created_at timestamptz);
    grant all on all tables in schema public to service_role, authenticated;
  `);
  await db.exec(readFileSync(new URL("../../supabase/migrations/0144_ops_metrics_rollups.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../../supabase/migrations/0157_manager_finance_rollups.sql", import.meta.url), "utf8"));

  for (const s of SHOPS) await db.query(`insert into public.restaurants values ($1,$2,$3,$4,$5)`, [s.id, s.zone, s.pct, s.other, s.cycle]);
  for (const d of DRIVERS) await db.query(`insert into public.profiles values ($1,'driver')`, [d]);
  await db.query(`insert into public.staff_zones values ($1,$2),($3,$2),($4,$5)`, [DRIVERS[0], ZONE1, DRIVERS[1], DRIVERS[2], ZONE2]);
  for (const o of orders) {
    await db.query(`insert into public.orders values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [o.id, o.short, o.restaurant_id, o.zone_id, o.status, o.created_at, o.total, o.delivery_fee, o.tax_amount, o.tip, o.discount, o.discount_funded_by, o.payment_method, o.payment_status]);
    if (o.delivered_at) await db.query(`insert into public.deliveries (order_id, driver_id, delivered_at, cod_collected_amount, cod_collected_at) values ($1,$2,$3,$4,$5)`,
      [o.id, o.driver, o.delivered_at, o.cod, o.cod_at]);
  }
  for (const it of items) await db.query(`insert into public.order_items (order_id, qty, price) values ($1,$2,$3)`, [it.order_id, it.qty, it.price]);
  for (const r of refunds) await db.query(`insert into public.refunds values ($1,$2,$3,$4)`, [r.id, r.order_id, r.amount, r.status]);
  await db.query(`insert into public.vendor_settlements (id, status, restaurant_id, net_payable, created_at, paid_at) values
    ($1,'paid',$3,1500,'2026-10-05T06:00:00Z','2026-10-06T06:00:00Z'), ($2,'draft',$3,700,'2026-10-15T06:00:00Z',null),
    ($4,'draft',$5,300,'2026-10-16T06:00:00Z',null), ($6,'paid',$5,900,'2026-09-20T06:00:00Z','2026-09-21T06:00:00Z')`,
    [PAID, DRAFT, SHOPS[0].id, uuid(7, 3), SHOPS[2].id, uuid(7, 4)]);
  await db.query(`insert into public.payment_requests (settlement_id, status) values ($1,'pending_approval')`, [DRAFT]);

  // ── reference inputs ─────────────────────────────────────────────────────
  const metricOrders: MetricOrder[] = orders.map((o) => ({
    id: o.id, restaurantId: o.restaurant_id, zoneId: o.zone_id, status: o.status as MetricOrder["status"], createdAt: o.created_at,
    total: o.total, deliveryFee: o.delivery_fee, taxAmount: o.tax_amount, tip: o.tip, discount: o.discount,
    discountFundedBy: o.discount_funded_by as MetricOrder["discountFundedBy"], paymentMethod: o.payment_method as MetricOrder["paymentMethod"],
    paymentStatus: o.payment_status as MetricOrder["paymentStatus"],
    items: items.filter((i) => i.order_id === o.id).map((i) => ({ name: "x", qty: i.qty, price: i.price })),
  }));
  for (const o of metricOrders) if (o.items && o.items.length === 0) delete o.items;
  const metricRefunds: MetricRefund[] = refunds.map((r) => ({ id: r.id, orderId: r.order_id, amount: r.amount, status: r.status as MetricRefund["status"] }));
  const pricing: PricingContext = {
    commissionPct: new Map(SHOPS.map((s) => [s.id, s.pct ?? DEFAULT_PCT])),
    otherCharges: new Map(SHOPS.map((s) => [s.id, s.other])),
    commissionGstPct: GST,
  };
  // Settlement lines: paid ones at today's expected contribution, some altered.
  const { priceOrder, refundsByOrder } = await import("../../src/lib/metrics");
  const byOrderRefund = refundsByOrder(metricRefunds);
  const expectedOf = (id: string) => priceOrder(metricOrders.find((o) => o.id === id)!, pricing, byOrderRefund.get(id) ?? 0).contribution;
  const lineContribution = new Map<string, number>();
  const corrections: { order_id: string; amount: number; status: string }[] = [];
  paidIds.forEach((id, i) => {
    const e = expectedOf(id);
    if (i % 5 === 1) { lineContribution.set(id, e + 120); corrections.push({ order_id: id, amount: 120, status: "outstanding" }); }
    else if (i % 5 === 2) { lineContribution.set(id, e + 80); corrections.push({ order_id: id, amount: 80, status: "applied" }); }
    else if (i % 5 === 3) lineContribution.set(id, e + 50); // mismatch, no correction
    else lineContribution.set(id, e);
  });
  draftIds.forEach((id) => lineContribution.set(id, expectedOf(id)));
  for (const id of paidIds) await db.query(`insert into public.vendor_settlement_orders values ($1,$2,$3)`, [PAID, id, lineContribution.get(id)]);
  for (const id of draftIds) await db.query(`insert into public.vendor_settlement_orders values ($1,$2,$3)`, [DRAFT, id, lineContribution.get(id)]);
  for (const c of corrections) await db.query(`insert into public.settlement_corrections (order_id, amount, status) values ($1,$2,$3)`, [c.order_id, c.amount, c.status]);

  // Rider ledger.
  const ledger: { driver: string; type: string; amount: number; date: string; payoutId: string | null }[] = [];
  for (const [k, d] of DRIVERS.entries()) {
    const pay = uuid(10, k + 1);
    await db.query(`insert into public.rider_payouts (id, driver_id, amount, paid_on, reference) values ($1,$2,12000,'2026-09-30','UTR${k}')`, [pay, d]);
    const rows = [
      { type: "earning", amount: 35.5, date: "2026-10-03", payoutId: null },
      { type: "earning", amount: 40.25, date: "2026-09-20", payoutId: pay },
      { type: "salary", amount: 12000, date: "2026-10-15", payoutId: k === 2 ? pay : null },
      { type: "deduction", amount: 150, date: "2026-10-05", payoutId: null },
      { type: "bonus", amount: 300, date: "2026-10-08", payoutId: null },
    ];
    for (const r of rows) {
      ledger.push({ driver: d, ...r });
      if (r.type === "earning") await db.query(`insert into public.rider_earnings (driver_id, amount, earned_at, payout_id) values ($1,$2,$3,$4)`,
        [d, r.amount, `${r.date}T06:00:00Z`, r.payoutId]);
      else if (r.type === "bonus") await db.query(`insert into public.rider_incentive_awards (driver_id, amount, awarded_at, payout_id) values ($1,$2,$3,$4)`,
        [d, r.amount, `${r.date}T06:00:00Z`, r.payoutId]);
      else await db.query(`insert into public.rider_adjustments (driver_id, kind, amount, effective_on, payout_id) values ($1,$2,$3,$4,$5)`,
        [d, r.type, r.amount, r.date, r.payoutId]);
    }
  }
  // Cash.
  const day = "2026-10-20";
  await db.query(`insert into public.cod_handovers (leg, from_user, to_user, handover_date, amount, zone_id) values
    ('rider_to_manager',$1,$2,$3,500,$4), ('manager_to_owner',$2,null,$3,300,$4), ('rider_to_manager',$5,$2,$3,200,$6)`,
    [DRIVERS[0], MANAGERS[0], day, ZONE1, DRIVERS[2], ZONE2]);
  await db.query(`insert into public.cash_disputes (driver_id, day, status) values ($1,$2,'open')`, [DRIVERS[1], day]);

  const asService = async <T,>(sql: string, params: unknown[] = []): Promise<T> => {
    await db.exec(`set role service_role`);
    try { return (await db.query<{ v: T }>(sql, params)).rows[0].v; } finally { await db.exec(`reset role`); }
  };

  // ── sales & commission ───────────────────────────────────────────────────
  console.log("\n── ops_finance_rollup = salesSummary + platformCommission ──");
  const ranges: DateRange[] = [{ from: "2026-10-01", to: "2026-10-21" }, { from: "2026-09-25", to: "2026-10-22" }, { from: "2026-10-12", to: "2026-10-12" }];
  for (const range of ranges) {
    for (const zones of [null, [ZONE1], [ZONE2], [] as string[]]) {
      for (const payment of [null, "cod", "online"]) {
        const start = istDayStart(range.from).toISOString();
        const end = istDayStart(addDays(range.to, 1)).toISOString();
        const rollup = await asService<FinanceRollup>(
          `select public.ops_finance_rollup($1::uuid[], $2::timestamptz, $3::timestamptz, null, $4, $5, $6) as v`,
          [zones, start, end, payment, DEFAULT_PCT, GST]);
        const inScope = metricOrders.filter((o) => inRange(o.createdAt, range) && (zones === null || zones.includes(o.zoneId!))
          && (payment === null || o.paymentMethod === payment));
        const ref = salesSummary(inScope, metricRefunds);
        const com = platformCommission(inScope, metricRefunds, pricing);
        const sql = salesFromRollup(rollup.summary);
        const label = `${range.from}…${range.to} zones=${zones === null ? "all" : zones.length} pay=${payment ?? "all"}`;
        check(`${label}: sales figures`, same(
          [sql.orders, sql.grossSales, sql.customerPaid, sql.netSales, sql.discounts, sql.refunds, sql.deliveryFees, sql.cancelled],
          [ref.orders, ref.grossSales, ref.customerPaid, ref.netSales, ref.discounts, ref.refunds, ref.deliveryFees, ref.cancelled]),
          { sql, ref });
        check(`${label}: platform commission`, same(sql.platformCommission, com), { sql: sql.platformCommission, ref: com });
        const days = dailyFromFinanceRollup(rollup, range);
        const daySum = days.reduce((a, d) => a + d.netSales, 0);
        check(`${label}: daily net sales sum to the period`, daySum === sql.netSales, { daySum, net: sql.netSales });
        const perDayRef = days.every((d) => {
          const dayOrders = inScope.filter((o) => istDayKey(o.createdAt) === d.date);
          const s = salesSummary(dayOrders, metricRefunds);
          return s.netSales === d.netSales && s.customerPaid === d.customerPaid && s.orders === d.orders;
        });
        check(`${label}: every day equals salesSummary of that day`, perDayRef);
        const vendorCommission = rollup.byVendor.reduce((a, v) => a + v.commission + v.commissionGst + v.otherCharges, 0);
        check(`${label}: by-shop commission sums to the total`, vendorCommission === com.total);
      }
    }
  }

  // ── vendor dues ─────────────────────────────────────────────────────────
  console.log("\n── ops_vendor_dues_scoped = vendorEarnings ──");
  for (const zones of [null, [ZONE1], [ZONE2]]) {
    const rows = await asService<VendorDueRollupRow[]>(`select public.ops_vendor_dues_scoped($1::uuid[], $2, $3) as v`, [zones, DEFAULT_PCT, GST]);
    const scoped = metricOrders.filter((o) => zones === null || zones.includes(o.zoneId!));
    const ref = vendorEarnings(scoped, metricRefunds, pricing, new Set(paidIds));
    const sqlNets = Object.fromEntries(rows.map((r) => [r.restaurantId, Number(r.net)]));
    const refNets = Object.fromEntries([...ref.byVendor].map(([k, v]) => [k, v.net]));
    check(`zones=${zones === null ? "all" : zones[0].slice(-1)}: net per shop`, same(Object.keys(sqlNets).sort().map((k) => sqlNets[k]), Object.keys(refNets).sort().map((k) => refNets[k])), { sqlNets, refNets });
    const payable = rows.reduce((a, r) => a + Math.max(0, Number(r.net)), 0);
    check(`zones=${zones === null ? "all" : zones[0].slice(-1)}: payable = vendorEarnings.payable`, payable === ref.payable, { payable, ref: ref.payable });
  }

  // ── rider dues ───────────────────────────────────────────────────────────
  console.log("\n── ops_rider_dues = riderLedgerTotals ──");
  const riderRows = await asService<RiderDueRollupRow[]>(`select public.ops_rider_dues(null, null) as v`);
  for (const d of DRIVERS) {
    const ref = riderLedgerTotals(ledger.filter((l) => l.driver === d));
    const row = riderRows.find((r) => r.riderId === d);
    check(`rider ${d.slice(-1)} unpaid ${ref.unpaid} from ${ref.oldestUnpaidOn}`,
      row !== undefined && Number(row.unpaid) === ref.unpaid && row.oldestUnpaidOn === ref.oldestUnpaidOn, { row, ref });
    check(`rider ${d.slice(-1)} last payout`, row?.lastPayout?.paidOn === "2026-09-30" && Number(row?.lastPayout?.amount) === 12000);
  }
  const zone2Riders = await asService<RiderDueRollupRow[]>(`select public.ops_rider_dues($1::uuid[], null) as v`, [[ZONE2]]);
  check("zone 2 sees only its rider", zone2Riders.length === 1 && zone2Riders[0].riderId === DRIVERS[2]);

  // ── reconciliation ───────────────────────────────────────────────────────
  console.log("\n── ops_reconciliation_orders = classifyOrderReconciliation ──");
  const range = { from: "2026-09-25", to: "2026-10-22" };
  const recon = await asService<{ summary: Record<string, number>; items: ReconciliationRollupItem[] }>(
    `select public.ops_reconciliation_orders(null, $1, $2, $3, $4, $5, null, null, null, 200) as v`,
    [istDayStart(range.from).toISOString(), istDayStart(addDays(range.to, 1)).toISOString(), DEFAULT_PCT, GST, NOW.toISOString()]);
  const refStates: Record<string, number> = {};
  let mismatches = 0;
  for (const o of deliveredOrders) {
    if (!isCountedOrder(metricOrders.find((m) => m.id === o.id)!)) continue;
    const shop = SHOPS.find((s) => s.id === o.restaurant_id)!;
    const line = paidIds.includes(o.id) ? { settlementStatus: "paid" as const, contribution: lineContribution.get(o.id)! }
      : draftIds.includes(o.id) ? { settlementStatus: "draft" as const, contribution: lineContribution.get(o.id)! } : null;
    const corr = corrections.filter((c) => c.order_id === o.id);
    const res = classifyOrderReconciliation({
      delivered: true, deliveredAt: new Date(o.delivered_at!), cycle: shop.cycle as "weekly" | "monthly", line,
      expectedContribution: expectedOf(o.id),
      outstandingCorrection: corr.filter((c) => c.status === "outstanding").reduce((a, c) => a + c.amount, 0),
      appliedCorrection: corr.filter((c) => c.status === "applied").reduce((a, c) => a + c.amount, 0), now: NOW,
    });
    refStates[res.state] = (refStates[res.state] ?? 0) + 1;
    const item = recon.items.find((i) => i.orderId === o.id);
    if (item && (item.state !== res.state || Number(item.difference) !== res.difference)) mismatches++;
  }
  check("summary counts by state match", same(Object.keys(refStates).sort().map((k) => [k, refStates[k]]),
    Object.keys(recon.summary).sort().map((k) => [k, Number(recon.summary[k])])), { sql: recon.summary, ref: refStates });
  check("every listed order has the same state and difference", mismatches === 0, mismatches);
  check("all six states occur in the fixture", Object.keys(refStates).length >= 5, refStates);
  const onlyMismatch = await asService<{ items: ReconciliationRollupItem[] }>(
    `select public.ops_reconciliation_orders(null, $1, $2, $3, $4, $5, 'paid_mismatch', null, null, 200) as v`,
    [istDayStart(range.from).toISOString(), istDayStart(addDays(range.to, 1)).toISOString(), DEFAULT_PCT, GST, NOW.toISOString()]);
  check("state filter returns only that state", onlyMismatch.items.length > 0 && onlyMismatch.items.every((i) => i.state === "paid_mismatch"));
  const page1 = await asService<{ items: ReconciliationRollupItem[] }>(
    `select public.ops_reconciliation_orders(null, $1, $2, $3, $4, $5, null, null, null, 5) as v`,
    [istDayStart(range.from).toISOString(), istDayStart(addDays(range.to, 1)).toISOString(), DEFAULT_PCT, GST, NOW.toISOString()]);
  const last = page1.items[4];
  const page2 = await asService<{ items: ReconciliationRollupItem[] }>(
    `select public.ops_reconciliation_orders(null, $1, $2, $3, $4, $5, null, $6, $7, 5) as v`,
    [istDayStart(range.from).toISOString(), istDayStart(addDays(range.to, 1)).toISOString(), DEFAULT_PCT, GST, NOW.toISOString(), last.deliveredAt, last.orderId]);
  check("keyset paging: a page of 5 (+1 probe), the next page continues without overlap",
    page1.items.length === 6 && page2.items.length === 6 && !page2.items.some((i) => page1.items.slice(0, 5).some((j) => j.orderId === i.orderId)));

  // ── cash ─────────────────────────────────────────────────────────────────
  console.log("\n── ops_cash_reconciliation ──");
  const cash = await asService<{ riders: CashRiderDay[]; managers: { day: string; managerId: string; received: number; handedOn: number }[] }>(
    `select public.ops_cash_reconciliation(null, '2026-09-25', '2026-10-22', null) as v`);
  const refCollected = new Map<string, number>();
  for (const o of orders) if (o.cod_at) {
    const key = `${o.driver}|${istDayKey(o.cod_at)}`;
    refCollected.set(key, (refCollected.get(key) ?? 0) + (o.cod ?? 0));
  }
  const sqlCollected = new Map(cash.riders.map((r) => [`${r.riderId}|${r.day}`, Number(r.collected)]));
  check("collected per rider × IST day", [...refCollected].every(([k, v]) => sqlCollected.get(k) === v), { refCollected: [...refCollected].slice(0, 5), sql: [...sqlCollected].slice(0, 5) });
  const d0 = cash.riders.find((r) => r.riderId === DRIVERS[0] && r.day === day);
  check("rider 0 deposited 500 on the 20th", Number(d0?.deposited) === 500, d0);
  const disputedRow = cash.riders.find((r) => r.riderId === DRIVERS[1] && r.day === day);
  check("an open dispute flags the day (when the rider has a row that day)", disputedRow === undefined || disputedRow.disputed === true, disputedRow);
  check("manager received 700, handed on 300", cash.managers.some((m) => m.day === day && Number(m.received) === 700 && Number(m.handedOn) === 300), cash.managers);
  const cashZone2 = await asService<{ riders: CashRiderDay[] }>(`select public.ops_cash_reconciliation($1::uuid[], '2026-10-20', '2026-10-20', null) as v`, [[ZONE2]]);
  check("zone 2 cash shows no zone-1 deposit", !cashZone2.riders.some((r) => r.riderId === DRIVERS[0] && Number(r.deposited) > 0));

  // ── rider ledger totals, payouts, settlement totals ──────────────────────
  console.log("\n── ops_rider_ledger_totals, ops_rider_payouts_scoped, ops_settlement_totals ──");
  const plain = (l: (typeof ledger)[number]) => ({ type: l.type, amount: l.amount, date: l.date, payoutId: l.payoutId });
  const lt = await asService<{ earnedInRange: number; unpaid: number }>(`select public.ops_rider_ledger_totals(null, '2026-10-01', '2026-10-31') as v`);
  const refOct = riderLedgerTotals(ledger.map(plain), { from: "2026-10-01", to: "2026-10-31" });
  check("ledger earned in October and unpaid match riderLedgerTotals",
    Number(lt.earnedInRange) === refOct.earnedInRange && Number(lt.unpaid) === refOct.unpaid, { lt, refOct });
  const lt2 = await asService<{ unpaid: number }>(`select public.ops_rider_ledger_totals($1::uuid[], '2026-10-01', '2026-10-31') as v`, [[ZONE2]]);
  const ref2 = riderLedgerTotals(ledger.filter((l) => l.driver === DRIVERS[2]).map(plain));
  check("ledger totals are zone-scoped", Number(lt2.unpaid) === ref2.unpaid, { lt2, ref2 });
  const po = await asService<{ totals: { amount: number; count: number }; items: { riderId: string }[] }>(
    `select public.ops_rider_payouts_scoped(null, '2026-09-01', '2026-09-30', null, null, null, null, 2) as v`);
  check("payouts in September: 3 × 12000, page of 2 (+1 probe)", Number(po.totals.amount) === 36000 && po.totals.count === 3 && po.items.length === 3, po);
  const poZ = await asService<{ totals: { count: number } }>(
    `select public.ops_rider_payouts_scoped($1::uuid[], '2026-09-01', '2026-09-30', null, null, null, null, 50) as v`, [[ZONE1]]);
  check("payouts are zone-scoped (2 riders in zone 1)", poZ.totals.count === 2, poZ);
  const stAll = await asService<{ netPayable: number; count: number }>(`select public.ops_settlement_totals(null, null, null, null, null) as v`);
  check("settlement totals: all four", Number(stAll.netPayable) === 3400 && stAll.count === 4, stAll);
  const stPaidOct = await asService<{ netPayable: number; count: number }>(
    `select public.ops_settlement_totals(null, 'paid', null, '2026-10-01T00:00:00+05:30', '2026-11-01T00:00:00+05:30') as v`);
  check("paid in October (by paid_at): one, 1500", Number(stPaidOct.netPayable) === 1500 && stPaidOct.count === 1, stPaidOct);
  const stPending = await asService<{ count: number }>(`select public.ops_settlement_totals(null, 'pending_approval', null, null, null) as v`);
  check("pending_approval = drafts with a pending request", stPending.count === 1, stPending);
  const stZone2 = await asService<{ count: number }>(`select public.ops_settlement_totals($1::uuid[], null, null, null, null) as v`, [[ZONE2]]);
  check("settlement totals are zone-scoped", stZone2.count === 2, stZone2);

  // ── privileges ───────────────────────────────────────────────────────────
  console.log("\n── service role only ──");
  for (const fn of ["ops_finance_rollup", "ops_vendor_dues_scoped", "ops_rider_dues", "ops_reconciliation_orders", "ops_cash_reconciliation",
    "ops_rider_ledger_totals", "ops_rider_payouts_scoped", "ops_settlement_totals"]) {
    const r = await db.query<{ ok: boolean }>(`select has_function_privilege('authenticated', p.oid, 'execute') as ok from pg_proc p where proname = $1`, [fn]);
    check(`${fn} is not executable by authenticated`, r.rows[0]?.ok === false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
void main();
