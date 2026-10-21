/**
 * QA — 0146's ops_product_insights and ops_product_counts against the
 * reference TypeScript (buildProductInsights / availabilityStats / isLowStock).
 *
 * Loads one seeded, randomised menu — dishes in every moderation and stock
 * state, availability and price changes before, inside and after the range,
 * orders across two zones — into an in-process Postgres and requires the SQL's
 * bounded answer, assembled by assembleProductInsights, to equal what the
 * reference builds from every row. Then the same for the list counts.
 *
 * Needs: npm i --no-save @electric-sql/pglite@0.2.17
 * Usage: npx tsx scripts/qa/manager-product-insights-sql.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  assembleProductInsights,
  buildProductInsights,
  isLowStock,
  isOutOfStock,
  type InsightSqlRow,
  type PriceChangeRow,
  type ProductRow,
} from "../../src/lib/ops/product-contract";
import type { AvailabilityChange } from "../../src/lib/ops/product-rules";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail, null, 1).slice(0, 2500)); }
}

// Seeded PRNG so a failure reproduces.
let seed = 46;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const read = (f: string) => readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const fn = (src: string, name: string) => {
  const m = src.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  if (!m) throw new Error(`${name} not found`);
  return m[0];
};

async function main() {
  const db = new PGlite();
  await db.exec(`
    create table public.restaurants (id uuid primary key, name text, zone_id uuid);
    create table public.menu_items (id uuid primary key, restaurant_id uuid references public.restaurants, name text not null,
      category text, price integer not null, discount_price integer, pending_price integer, image_url text, veg boolean,
      available boolean not null, stock_qty integer, low_stock_at integer, sold_out_by_stock boolean not null default false,
      approval_status text not null, hidden_by_ops boolean not null default false, updated_at timestamptz);
    create table public.menu_item_changes (id bigint generated always as identity primary key, menu_item_id uuid, restaurant_id uuid,
      field text, old_value text, new_value text, source text, actor_id uuid, created_at timestamptz);
    create table public.listing_flags (id uuid primary key default gen_random_uuid(), menu_item_id uuid, restaurant_id uuid, reason text, status text);
    create table public.orders (id uuid primary key, restaurant_id uuid, zone_id uuid, status text, payment_method text,
      payment_status text, created_at timestamptz);
    create table public.order_items (id bigint generated always as identity primary key, order_id uuid, menu_item_id uuid, qty integer, price integer);
  `);
  await db.exec(fn(read("0142_manager_orders_live.sql"), "ops_counts_as_order"));
  const m0146 = read("0146_manager_products.sql");
  for (const name of ["ops_product_sales", "ops_product_insights", "ops_product_counts"]) await db.exec(fn(m0146, name));

  const Z1 = uuid(1), Z2 = uuid(2);
  const shops = [uuid(11), uuid(12), uuid(13), uuid(14)];
  const shopZone = new Map([[shops[0], Z1], [shops[1], Z1], [shops[2], Z2], [shops[3], Z2]]);
  for (const s of shops) await db.query(`insert into public.restaurants values ($1, $2, $3)`, [s, `Shop ${s.slice(-2)}`, shopZone.get(s)]);

  const rangeStart = Date.parse("2026-10-01T00:00:00+05:30");
  const rangeEnd = Date.parse("2026-10-15T00:00:00+05:30");
  const span = rangeEnd - rangeStart;
  const iso = (t: number) => new Date(Math.floor(t / 1000) * 1000).toISOString();

  const items: ProductRow[] = [];
  for (let i = 0; i < 90; i++) {
    const shop = pick(shops);
    const approval = pick(["approved", "approved", "approved", "pending", "rejected"] as const);
    const stock = pick([null, null, 0, 3, 10, 25]);
    const row: ProductRow = {
      id: uuid(1000 + i), name: `Dish ${String(i).padStart(3, "0")} ${pick(["Lassi", "Dal", "Roti", "Paneer"])}`,
      restaurant_id: shop, category: pick([null, "Mains", "Drinks", "Breads"]), price: 50 + Math.floor(rnd() * 400),
      discount_price: null, pending_price: approval === "pending" && rnd() < 0.5 ? 300 : null, image_url: null, veg: true,
      available: rnd() < 0.7, stock_qty: stock, low_stock_at: stock !== null && rnd() < 0.6 ? 5 : null,
      sold_out_by_stock: stock === 0 && rnd() < 0.5, approval_status: approval, hidden_by_ops: rnd() < 0.1,
      updated_at: null, restaurants: { name: `Shop ${shop.slice(-2)}`, zone_id: shopZone.get(shop)! },
    };
    items.push(row);
    await db.query(
      `insert into public.menu_items (id, restaurant_id, name, category, price, discount_price, pending_price, image_url, veg, available,
        stock_qty, low_stock_at, sold_out_by_stock, approval_status, hidden_by_ops, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [row.id, row.restaurant_id, row.name, row.category, row.price, row.discount_price, row.pending_price, row.image_url, row.veg,
        row.available, row.stock_qty, row.low_stock_at, row.sold_out_by_stock, row.approval_status, row.hidden_by_ops, row.updated_at]
    );
  }

  // Availability and price changes: some before, many inside, some after the range.
  const changes: { item: ProductRow; field: string; old: string | null; neu: string | null; at: string; source: string }[] = [];
  for (const it of items) {
    const n = Math.floor(rnd() * 7);
    for (let k = 0; k < n; k++) {
      const t = rangeStart - span * 0.3 + rnd() * span * 1.6;
      const to = rnd() < 0.5;
      changes.push({ item: it, field: "available", old: String(!to), neu: String(to), at: iso(t), source: "vendor" });
    }
    if (rnd() < 0.4) {
      const t = rangeStart - span * 0.2 + rnd() * span * 1.4;
      changes.push({ item: it, field: "price", old: String(it.price), neu: String(it.price + 20), at: iso(t), source: pick(["vendor", "ops", "admin"]) });
    }
  }
  // Two dishes share a change instant, to pin tie order.
  changes.push({ item: items[0], field: "price", old: "100", neu: "120", at: iso(rangeStart + 3600_000), source: "vendor" });
  changes.push({ item: items[1], field: "price", old: "100", neu: "90", at: iso(rangeStart + 3600_000), source: "vendor" });
  changes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (rnd() < 0.5 ? -1 : 1));
  const ids: number[] = [];
  for (const c of changes) {
    const { rows } = await db.query<{ id: number }>(
      `insert into public.menu_item_changes (menu_item_id, restaurant_id, field, old_value, new_value, source, created_at)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [c.item.id, c.item.restaurant_id, c.field, c.old, c.neu, c.source, c.at]
    );
    ids.push(Number(rows[0].id));
  }

  // Orders and lines.
  for (let o = 0; o < 160; o++) {
    const shop = pick(shops);
    const oid = uuid(50000 + o);
    await db.query(`insert into public.orders values ($1,$2,$3,$4,$5,$6,$7)`, [
      oid, shop, shopZone.get(shop), pick(["delivered", "delivered", "kitchen", "cancelled"]),
      pick(["cod", "online"]), pick(["paid", "pending", "failed"]), iso(rangeStart - span * 0.1 + rnd() * span * 1.2),
    ]);
    const mine = items.filter((it) => it.restaurant_id === shop);
    for (let l = 0; l < 1 + Math.floor(rnd() * 3); l++) {
      const it = pick(mine);
      if (!it) continue;
      await db.query(`insert into public.order_items (order_id, menu_item_id, qty, price) values ($1,$2,$3,$4)`, [oid, it.id, 1 + Math.floor(rnd() * 4), it.price]);
    }
  }
  for (const it of items.slice(0, 12)) await db.query(`insert into public.listing_flags (menu_item_id, restaurant_id, reason, status) values ($1,$2,'other',$3)`, [it.id, it.restaurant_id, pick(["open", "resolved"])]);

  const range = { start: new Date(rangeStart), endExclusive: new Date(rangeEnd) };
  const norm = <T,>(x: T) => JSON.parse(JSON.stringify(x, (k, v) => (k === "at" && typeof v === "string" ? new Date(v).toISOString() : v)));

  console.log("\n── insights: SQL vs reference ──");
  for (const [label, zones, shop, limit] of [
    ["all zones", null, null, 20],
    ["zone 1", [Z1], null, 20],
    ["zone 2, limit 5", [Z2], null, 5],
    ["one shop", null, shops[2], 20],
  ] as const) {
    const scoped = items
      .filter((it) => (zones === null || (zones as readonly string[]).includes(it.restaurants && !Array.isArray(it.restaurants) ? it.restaurants.zone_id : "")) && (shop === null || it.restaurant_id === shop))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const scopedIds = new Set(scoped.map((s) => s.id));
    const { rows: sales } = await db.query<{ menu_item_id: string; units: number; revenue: number }>(
      `select * from public.ops_product_sales($1::uuid[], $2, $3, $4)`, [zones === null ? null : [...zones], range.start.toISOString(), range.endExclusive.toISOString(), shop]);
    const salesMap = new Map(sales.map((s) => [s.menu_item_id, { units: Number(s.units), revenue: Number(s.revenue) }]));
    const ordered = changes.map((c, i) => ({ ...c, id: ids[i] })).sort((a, b) => a.id - b.id).filter((c) => scopedIds.has(c.item.id));
    const availabilityChanges: AvailabilityChange[] = ordered.filter((c) => c.field === "available").map((c) => ({ itemId: c.item.id, at: c.at, to: c.neu === "true" }));
    const priceChanges: PriceChangeRow[] = ordered.filter((c) => c.field === "price").map((c) => ({ itemId: c.item.id, at: c.at, from: c.old, to: c.neu, source: c.source }));
    const want = buildProductInsights({ items: scoped, sales: salesMap, availabilityChanges, priceChanges, range, limit });

    const { rows } = await db.query<InsightSqlRow>(`select * from public.ops_product_insights($1::uuid[], $2, $3, $4, $5)`,
      [zones === null ? null : [...zones], shop, range.start.toISOString(), range.endExclusive.toISOString(), limit]);
    const named = new Set(rows.map((r) => r.menu_item_id));
    const got = assembleProductInsights(rows.map((r) => ({ ...r, at: r.at ? new Date(r.at as unknown as string).toISOString() : null })),
      items.filter((it) => named.has(it.id)));
    const bound = rows.length <= limit * 5;
    check(`${label}: ${rows.length} rows (≤ ${limit * 5}) — every section equals the reference`, bound && JSON.stringify(norm(got)) === JSON.stringify(norm(want)), {
      sections: (["frequentlyUnavailable", "priceChanges", "topSellers", "slowSellers", "outOfStock"] as const).map((k) => ({
        k, same: JSON.stringify(norm(got[k])) === JSON.stringify(norm(want[k])),
        got: norm(got[k]).slice(0, 3).map((x: { product?: { id: string }; id?: string }) => ({ ...x, product: x.product?.id ?? x.id })),
        want: norm(want[k]).slice(0, 3).map((x: { product?: { id: string }; id?: string }) => ({ ...x, product: x.product?.id ?? x.id })),
      })),
    });
    check(`${label}: the case under test is not empty (frequently unavailable ${want.frequentlyUnavailable.length}, price changes ${want.priceChanges.length})`,
      want.frequentlyUnavailable.length > 0 && want.priceChanges.length > 0 && want.slowSellers.length > 0);
  }

  console.log("\n── list counts: SQL vs reference ──");
  for (const [label, zones, shop, category, uncategorised, term] of [
    ["all zones", null, null, null, false, null],
    ["zone 1", [Z1], null, null, false, null],
    ["zone 2, Drinks", [Z2], null, "Drinks", false, null],
    ["uncategorised", null, null, null, true, null],
    ["one shop, search 'lassi'", null, shops[1], null, false, "lassi"],
    ["search with a wildcard is literal", null, null, null, false, "_"],
  ] as const) {
    const scoped = items.filter((it) => {
      const z = !Array.isArray(it.restaurants) && it.restaurants ? it.restaurants.zone_id : "";
      return (zones === null || (zones as readonly string[]).includes(z)) && (shop === null || it.restaurant_id === shop)
        && (uncategorised ? it.category === null : category === null || it.category === category)
        && (term === null || it.name.toLowerCase().includes(term.toLowerCase()));
    });
    const scopedIds = new Set(scoped.map((s) => s.id));
    const { rows: flags } = await db.query<{ menu_item_id: string }>(`select menu_item_id from public.listing_flags where status = 'open'`);
    const want = {
      unavailable: scoped.filter((r) => !r.available).length,
      out_of_stock: scoped.filter(isOutOfStock).length,
      low_stock: scoped.filter(isLowStock).length,
      pending_approval: scoped.filter((r) => r.approval_status === "pending").length,
      hidden: scoped.filter((r) => r.hidden_by_ops).length,
      open_flags: flags.filter((f) => scopedIds.has(f.menu_item_id)).length,
    };
    const { rows } = await db.query<Record<string, number>>(`select * from public.ops_product_counts($1::uuid[], $2, $3, $4, $5)`,
      [zones === null ? null : [...zones], shop, category, uncategorised, term]);
    check(`${label}: counts match`, JSON.stringify(rows[0]) === JSON.stringify(want), { got: rows[0], want });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
