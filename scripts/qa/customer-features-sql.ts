/**
 * QA — 0200 and 0201 in a real (in-process) Postgres: a customer switch holds for a
 * session talking straight to the database, not only through /api/*.
 *
 * Loads the real 0052, 0184, 0200 and 0201 into PGlite over the smallest schema they
 * need. The cancel and coupon functions are the real bodies from 0201.
 *
 * Needs: @electric-sql/pglite (or NODE_PATH pointing at a folder that has it).
 * Usage: npm run test:customer-features-sql
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400));
  }
}

const read = (f: string) => readFileSync(join(__dirname, "..", "..", "supabase", "migrations", f), "utf8").replace(/\r\n/g, "\n");

const ANNA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const SHOP = "44444444-4444-4444-8444-444444444444";
const ORDER_A = "55555555-5555-4555-8555-555555555555";
const ORDER_B = "66666666-6666-4666-8666-666666666666";
const ORDER_C = "77777777-7777-4777-8777-777777777777";

async function main() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('test.uid', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select jsonb_build_object('role', coalesce(nullif(current_setting('test.role', true), ''), 'authenticated')) $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;

    create table public.profiles (id uuid primary key, role text not null default 'customer');
    create table public.restaurants (id uuid primary key);
    create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') $$;
    grant execute on function public.is_admin() to authenticated, service_role;

    create table public.platform_settings (id boolean primary key default true, customer_cancel_seconds integer not null default 20);
    insert into public.platform_settings default values;
    create function public._customer_cancel_seconds() returns integer language sql stable security definer set search_path = public as $$
      select customer_cancel_seconds from public.platform_settings where id = true $$;

    create table public.favorites (user_id uuid not null, restaurant_id uuid not null);
    alter table public.favorites enable row level security;
    create policy "favorites — owner all" on public.favorites for all
      using (user_id = auth.uid()) with check (user_id = auth.uid());

    create table public.addresses (id uuid primary key default gen_random_uuid(), user_id uuid not null, line text);
    alter table public.addresses enable row level security;
    create policy "addresses — owner all" on public.addresses for all
      using (user_id = auth.uid()) with check (user_id = auth.uid());

    create table public.reviews (id uuid primary key default gen_random_uuid(), user_id uuid not null, order_id uuid, rating int, reply text);
    alter table public.reviews enable row level security;
    create policy "reviews — owner insert" on public.reviews for insert with check (user_id = auth.uid());
    create policy "reviews — all read" on public.reviews for select using (true);
    create policy "reviews — author edit" on public.reviews for update using (user_id = auth.uid()) with check (user_id = auth.uid());
    create policy "reviews — shop reply" on public.reviews for update using (public.is_admin() or current_setting('test.shop', true) = 'yes');

    create table public.orders (
      id uuid primary key default gen_random_uuid(), customer_id uuid not null, restaurant_id uuid,
      status text not null default 'placed', tip integer default 0, created_at timestamptz not null default now(),
      cancelled_by text, coupon_code text, discount integer, discount_funded_by text, zone_id uuid);
    alter table public.orders enable row level security;
    create policy "orders — customer insert" on public.orders for insert with check (customer_id = auth.uid());
    create policy "orders — read" on public.orders for select using (customer_id = auth.uid() or public.is_admin());

    create table public.order_items (order_id uuid, menu_item_id uuid, qty integer, price integer);
    create table public.coupons (code text primary key, funded_by text);
    insert into public.coupons values ('SAVE10', 'deligro');
    create table public.coupon_items (code text, menu_item_id uuid);
    create table public.coupon_redemptions (code text, order_id uuid, customer_id uuid, discount integer, unique (code, order_id));
    create function public.price_coupon(c public.coupons, s integer, r uuid, u uuid, z uuid, e integer) returns jsonb
      language sql as $$ select jsonb_build_object('ok', true, 'discount', 10) $$;
    create function public.recompute_order_total(oid uuid) returns void language sql as $$ select 1 $$;

    grant select, insert, update, delete on public.favorites, public.addresses, public.reviews to authenticated;
    grant select, insert, update on public.orders to authenticated;
    grant select on public.profiles to authenticated;

    insert into public.profiles (id, role) values ('${ANNA}', 'customer'), ('${BEN}', 'customer'), ('${ADMIN}', 'admin');
    insert into public.restaurants (id) values ('${SHOP}');
    insert into public.orders (id, customer_id, restaurant_id) values
      ('${ORDER_A}', '${ANNA}', '${SHOP}'), ('${ORDER_B}', '${BEN}', '${SHOP}'), ('${ORDER_C}', '${ANNA}', '${SHOP}');
    insert into public.order_items values ('${ORDER_A}', null, 1, 100);
  `);

  await db.exec(read("0052_role_feature_flags.sql"));
  await db.exec(read("0184_admin_console_feature_switches.sql"));
  // 0141 widens the feature key check; these keys already fit 0052's.

  // Before 0200: the role check refuses a customer switch, which is the app's "apply 0200" message.
  const before = await db
    .query(`insert into public.role_feature_flags (role, feature, enabled) values ('customer', 'customer.tips', false)`)
    .then(() => "stored")
    .catch(() => "refused");
  check("before 0200 a customer switch is refused", before === "refused", before);

  await db.exec(read("0200_customer_feature_switches.sql"));
  await db.exec(read("0201_customer_switches_in_the_database.sql"));
  await db.exec(read("0200_customer_feature_switches.sql"));
  await db.exec(read("0201_customer_switches_in_the_database.sql"));
  check("0200 and 0201 re-run cleanly", true);

  async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    await db.exec(`set test.uid = '${uid}'; set role authenticated;`);
    try {
      return await fn();
    } finally {
      await db.exec(`reset role; set test.uid = '';`);
    }
  }
  const setFlag = (feature: string, enabled: boolean, subject: string | null = null) =>
    db.query(
      `insert into public.role_feature_flags (role, feature, subject_kind, subject_id, enabled)
       values ('customer', $1, $2, $3, $4)`,
      [feature, subject ? "profile" : "role", subject, enabled],
    );
  const clear = () => db.exec(`delete from public.role_feature_flags where role = 'customer'`);
  const flagOn = async (uid: string, feature: string, def = true) => {
    const r = await as(uid, () => db.query<{ on: boolean }>(`select public.customer_feature_on($1, $2) as on`, [feature, def]));
    return r.rows[0].on;
  };
  const tryWrite = (sql: string, params: unknown[] = []) =>
    db.query(sql, params).then((r) => ({ ok: true as const, rows: r.affectedRows ?? 0 })).catch((e: Error) => ({ ok: false as const, error: e.message, rows: 0 }));

  console.log("\ncustomer_feature_on");
  check("no row: the default", (await flagOn(ANNA, "customer.tips")) === true);
  check("no row, default off: off", (await flagOn(ANNA, "customer.self_pickup", false)) === false);
  await setFlag("customer.tips", false);
  check("role-wide off applies", (await flagOn(ANNA, "customer.tips")) === false);
  await setFlag("customer.tips", true, ANNA);
  check("a person's own on beats it", (await flagOn(ANNA, "customer.tips")) === true);
  check("everyone else still off", (await flagOn(BEN, "customer.tips")) === false);
  check("an admin is never off", (await flagOn(ADMIN, "customer.tips")) === true);
  check("another role's key answers false, not its value", (await flagOn(ANNA, "manager.finance.view")) === false);
  await clear();
  const anonRun = await db.exec(`set role anon`).then(() => db.query(`select public.customer_feature_on('customer.tips')`)).then(() => "ran").catch(() => "refused");
  await db.exec(`reset role`);
  check("anon can't call it", anonRun === "refused", anonRun);
  const tableRead = await as(ANNA, () => db.query(`select * from public.role_feature_flags`).then(() => "read").catch(() => "refused"));
  check("a customer still can't read the table", tableRead === "refused", tableRead);

  console.log("\nfavourites");
  check("on: can save", (await as(ANNA, () => tryWrite(`insert into public.favorites values ($1, $2)`, [ANNA, SHOP]))).ok);
  await setFlag("customer.favorites", false);
  check("off: can't save", !(await as(ANNA, () => tryWrite(`insert into public.favorites values ($1, $2)`, [ANNA, SHOP]))).ok);
  const seen = await as(ANNA, () => db.query(`select * from public.favorites`));
  check("off: reads as empty, cleanly", seen.rows.length === 0, seen.rows);
  await as(ANNA, () => db.query(`delete from public.favorites`));
  await clear();
  const after = await as(ANNA, () => db.query(`select * from public.favorites`));
  check("off: delete did nothing, and they come back when on", after.rows.length === 1, after.rows);

  console.log("\nsaved addresses");
  check("on: can add", (await as(ANNA, () => tryWrite(`insert into public.addresses (user_id, line) values ($1, 'A')`, [ANNA]))).ok);
  await setFlag("customer.saved_addresses", false, ANNA);
  check("off for Anna: can't add", !(await as(ANNA, () => tryWrite(`insert into public.addresses (user_id, line) values ($1, 'B')`, [ANNA]))).ok);
  check("off for Anna: Ben still can", (await as(BEN, () => tryWrite(`insert into public.addresses (user_id, line) values ($1, 'C')`, [BEN]))).ok);
  const read2 = await as(ANNA, () => db.query(`select * from public.addresses`));
  check("off: an address she already has still reads (old apps need it to order)", read2.rows.length === 1, read2.rows);
  const upd = await as(ANNA, () => tryWrite(`update public.addresses set line = 'Z'`));
  check("off: can't edit", upd.rows === 0, upd);
  await clear();

  console.log("\nreviews");
  await setFlag("customer.reviews", false);
  check("off: can't review", !(await as(ANNA, () => tryWrite(`insert into public.reviews (user_id, order_id, rating) values ($1, $2, 5)`, [ANNA, ORDER_A]))).ok);
  await clear();
  check("on: can review", (await as(ANNA, () => tryWrite(`insert into public.reviews (user_id, order_id, rating) values ($1, $2, 5)`, [ANNA, ORDER_A]))).ok);
  await setFlag("customer.reviews", false);
  const edit = await as(ANNA, () => tryWrite(`update public.reviews set rating = 1`));
  check("off: can't edit their own", edit.rows === 0, edit);
  await db.exec(`set test.shop = 'yes'`);
  const reply = await as(BEN, () => tryWrite(`update public.reviews set reply = 'thanks'`));
  await db.exec(`set test.shop = ''`);
  check("off: someone else's write (a shop's reply) is not blocked", reply.rows === 1, reply);
  await clear();

  console.log("\ntips");
  await setFlag("customer.tips", false);
  check("off: no order with a tip", !(await as(ANNA, () => tryWrite(`insert into public.orders (customer_id, tip) values ($1, 20)`, [ANNA]))).ok);
  check("off: an order with no tip is fine", (await as(ANNA, () => tryWrite(`insert into public.orders (customer_id, tip) values ($1, 0)`, [ANNA]))).ok);
  await clear();
  check("on: a tip is fine", (await as(ANNA, () => tryWrite(`insert into public.orders (customer_id, tip) values ($1, 20)`, [ANNA]))).ok);

  console.log("\npromo codes");
  await setFlag("customer.promo_codes", false);
  const refused = await as(ANNA, () => db.query<{ r: { ok: boolean; error?: string } }>(`select public.apply_coupon_to_order($1, 'SAVE10') as r`, [ORDER_A]));
  check("off: refused with feature_off", refused.rows[0].r.error === "feature_off", refused.rows[0].r);
  await clear();
  const applied = await as(ANNA, () => db.query<{ r: { ok: boolean } }>(`select public.apply_coupon_to_order($1, 'SAVE10') as r`, [ORDER_A]));
  check("on: applies", applied.rows[0].r.ok === true, applied.rows[0].r);

  console.log("\ncancelling");
  const left = (uid: string, order: string) => as(uid, () => db.query<{ s: number }>(`select public.customer_cancel_seconds_left($1) as s`, [order]));
  check("on: seconds are left", (await left(ANNA, ORDER_C)).rows[0].s > 0);
  await setFlag("customer.cancel", false);
  check("off: 0 seconds, so no screen offers the button", (await left(ANNA, ORDER_C)).rows[0].s === 0);
  const off = await as(ANNA, () => tryWrite(`select public.customer_cancel_order($1)`, [ORDER_C]));
  check("off: refused with feature_off", !off.ok && /feature_off/.test(off.error ?? ""), off);
  await clear();
  const yes = await as(ANNA, () => tryWrite(`select public.customer_cancel_order($1)`, [ORDER_C]));
  check("on: cancels", yes.ok, yes);
  await setFlag("customer.cancel", false);
  const replay = await as(ANNA, () => tryWrite(`select public.customer_cancel_order($1)`, [ORDER_C]));
  check("off: a retry of a cancel that already worked still answers ok", replay.ok, replay);
  await clear();
  const notMine = await as(BEN, () => tryWrite(`select public.customer_cancel_order($1)`, [ORDER_A]));
  check("someone else's order is still not_found", !notMine.ok && /not_found/.test(notMine.error ?? ""), notMine);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
