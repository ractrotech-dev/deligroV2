// Runs migration 0062 in an in-process Postgres (PGlite) with stubbed Supabase auth helpers.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0062.mjs
// Proves shop hours, stock, schedules, variants and add-ons; it does not replace running the migration on staging.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/0062_store_inventory_options.sql", import.meta.url), "utf8");
const db = new PGlite();

// The schema as 0062 finds it (0001, 0017, 0019, 0053/0055 guards).
await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
  create role anon; create role authenticated; create role service_role bypassrls;
  create type public.order_status as enum ('placed', 'kitchen', 'ready', 'on_the_way', 'delivered', 'cancelled');

  create table public.profiles (id uuid primary key, role text not null);
  create table public.restaurants (id uuid primary key, owner_id uuid, approved boolean default true,
    is_open boolean not null default true, opening_time time, closing_time time, weekly_off text[] not null default '{}');
  create table public.menu_items (id uuid primary key default gen_random_uuid(), restaurant_id uuid references public.restaurants,
    name text not null, price integer not null check (price >= 0), discount_price integer, available boolean not null default true);
  create table public.orders (id uuid primary key default gen_random_uuid(), customer_id uuid, restaurant_id uuid,
    status public.order_status not null default 'placed', payment_status text not null default 'pending', total integer default 0);
  create table public.order_items (id uuid primary key default gen_random_uuid(), order_id uuid references public.orders,
    menu_item_id uuid references public.menu_items, name text, qty integer, price integer);
  create table public.payments (id uuid primary key default gen_random_uuid(), order_id uuid);

  create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;
  create function public.owns_restaurant(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.restaurants r where r.id = rid and r.owner_id = auth.uid()) $$;

  alter table public.restaurants enable row level security;
  create policy "restaurants — read" on public.restaurants for select using (true);
  create policy "restaurants — owner update" on public.restaurants for update using (owner_id = auth.uid() or public.is_admin());
  alter table public.menu_items enable row level security;
  create policy "menu — read" on public.menu_items for select using (
    exists (select 1 from public.restaurants r where r.id = restaurant_id and r.approved) or public.owns_restaurant(restaurant_id) or public.is_admin());
  create policy "menu — owner manage" on public.menu_items for all
    using (public.owns_restaurant(restaurant_id) or public.is_admin()) with check (public.owns_restaurant(restaurant_id) or public.is_admin());
  alter table public.orders enable row level security;
  create policy "orders — read" on public.orders for select using (customer_id = auth.uid() or public.owns_restaurant(restaurant_id) or public.is_admin());
  create policy "orders — insert" on public.orders for insert with check (customer_id = auth.uid());
  create policy "orders — update" on public.orders for update using (customer_id = auth.uid() or public.owns_restaurant(restaurant_id) or public.is_admin());
  alter table public.order_items enable row level security;
  create policy "order_items — read" on public.order_items for select using (exists (select 1 from public.orders o where o.id = order_id));
  create policy "order_items — customer insert" on public.order_items for insert
    with check (exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));

  -- 0055's item guard, verbatim in substance.
  create function public.guard_order_item_insert() returns trigger language plpgsql security invoker set search_path = public as $$
  declare o record; m record;
  begin
    if public.is_admin() or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
       or current_user in ('postgres', 'supabase_admin') then return new; end if;
    select customer_id, restaurant_id, status, payment_status into o from public.orders where id = new.order_id;
    if not found or o.customer_id is distinct from auth.uid() or o.status <> 'placed' then
      raise exception 'order_items: you can only add items to your own new order'; end if;
    select name, price, discount_price, available into m from public.menu_items where id = new.menu_item_id and restaurant_id = o.restaurant_id;
    if not found then raise exception 'order_items: item is not on this restaurant''s menu'; end if;
    if m.available is not true then raise exception 'order_items: item is sold out'; end if;
    new.price := m.price; new.name := m.name; return new;
  end $$;
  create trigger order_items_guard_insert before insert on public.order_items for each row execute function public.guard_order_item_insert();

  grant usage on schema public, auth to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`);

const C = "00000000-0000-0000-0000-0000000000c1", V = "00000000-0000-0000-0000-0000000000a1", V2 = "00000000-0000-0000-0000-0000000000a2";
const R = "00000000-0000-0000-0000-0000000000f1", R2 = "00000000-0000-0000-0000-0000000000f2";
const PIZZA = "00000000-0000-0000-0000-000000000b01", NAAN = "00000000-0000-0000-0000-000000000b02", OTHER = "00000000-0000-0000-0000-000000000b03";
await db.exec(`
  insert into public.profiles values ('${C}','customer'),('${V}','restaurant'),('${V2}','restaurant');
  insert into public.restaurants (id, owner_id) values ('${R}','${V}'),('${R2}','${V2}');
  insert into public.menu_items (id, restaurant_id, name, price) values
    ('${PIZZA}','${R}','Pizza',200), ('${NAAN}','${R}','Naan',40), ('${OTHER}','${R2}','Elsewhere',99);
`);

await db.exec(MIGRATION);

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };
async function as(role, uid, sql) {
  await db.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec("reset role"); }
}
const fails = (r, re) => !r.ok && re.test(r.msg);
const status = async (rid = R) => (await as("service_role", null, `select public.restaurant_status_now('${rid}') as s`)).rows[0].s;
const reset = (rid = R) => db.exec(`update public.restaurants set is_open = true, closed_until = null,
  opening_time = null, closing_time = null, weekly_off = '{}' where id = '${rid}'; delete from public.store_holidays where restaurant_id = '${rid}';`);
const istNow = `(now() at time zone 'Asia/Kolkata')`;
let n = 0;
async function newOrder(rid = R) {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;
  await db.exec(`insert into public.orders (id, customer_id, restaurant_id) values ('${id}','${C}','${rid}')`);
  return id;
}
const addItem = (oid, item, qty = 1, options = null) =>
  as("authenticated", C, `insert into public.order_items (order_id, menu_item_id, qty, options) values
    ('${oid}','${item}',${qty}, ${options ? `'${JSON.stringify(options)}'::jsonb` : "null"}) returning name, price, options`);

console.log("\n── is the shop open right now ──");
ok("no hours set → open", (await status()) === "open");
await db.exec(`update public.restaurants set is_open = false where id = '${R}'`);
ok("switched off → closed", (await status()) === "closed");
await reset();
await db.exec(`update public.restaurants set closed_until = now() + interval '1 hour' where id = '${R}'`);
ok("closed until later → temporarily_closed", (await status()) === "temporarily_closed");
await db.exec(`update public.restaurants set closed_until = now() - interval '1 minute' where id = '${R}'`);
ok("a temporary close that has passed → open", (await status()) === "open");
await reset();
await db.exec(`update public.restaurants set opening_time = (${istNow})::time + interval '1 hour', closing_time = (${istNow})::time + interval '2 hours' where id = '${R}'`);
ok("outside opening hours → outside_hours", (await status()) === "outside_hours");
await db.exec(`update public.restaurants set opening_time = (${istNow})::time + interval '2 hours', closing_time = (${istNow})::time + interval '1 hour' where id = '${R}'`);
ok("hours that run past midnight include now → open", (await status()) === "open");
await reset();
await db.exec(`update public.restaurants set weekly_off = array[to_char(${istNow}, 'FMDay')] where id = '${R}'`);
ok("today is the weekly off → weekly_off", (await status()) === "weekly_off");
await reset();
await db.exec(`insert into public.store_holidays (restaurant_id, starts_on, ends_on) values ('${R}', (${istNow})::date, (${istNow})::date + 1)`);
ok("a holiday covering today → holiday", (await status()) === "holiday");
await reset();

console.log("\n── orders respect it ──");
await db.exec(`update public.restaurants set closed_until = now() + interval '1 hour' where id = '${R}'`);
ok("an item can't be added while the shop is closed", fails(await addItem(await newOrder(), NAAN), /restaurant_closed/));
await reset();
let r = await addItem(await newOrder(), NAAN, 2);
ok("…and can once it's open again", r.ok && r.rows[0].price === 40);

console.log("\n── variants and add-ons ──");
const G = "00000000-0000-0000-0000-000000000d01", G2 = "00000000-0000-0000-0000-000000000d02";
const VS = "00000000-0000-0000-0000-000000000e01", VL = "00000000-0000-0000-0000-000000000e02";
const CHEESE = "00000000-0000-0000-0000-000000000c11", OLIVE = "00000000-0000-0000-0000-000000000c12", DIP = "00000000-0000-0000-0000-000000000c13";
r = await as("authenticated", V, `insert into public.menu_item_variants (id, menu_item_id, name, price) values ('${VS}','${PIZZA}','Small',200),('${VL}','${PIZZA}','Large',350)`);
ok("the owner adds variants", r.ok);
ok("another vendor cannot", fails(await as("authenticated", V2, `insert into public.menu_item_variants (menu_item_id, name, price) values ('${PIZZA}','Huge',999)`), /row-level security/));
await as("authenticated", V, `insert into public.menu_item_addon_groups (id, menu_item_id, name, min_select, max_select) values
  ('${G}','${PIZZA}','Toppings',0,2), ('${G2}','${PIZZA}','Dip',1,1)`);
r = await as("authenticated", V, `insert into public.menu_item_addons (id, group_id, name, price) values
  ('${CHEESE}','${G}','Extra cheese',40),('${OLIVE}','${G}','Olives',30),('${DIP}','${G2}','Garlic dip',20)`);
ok("the owner adds add-ons", r.ok);
ok("a customer reads them", (await as("authenticated", C, `select id from public.menu_item_addons`)).rows?.length === 3);
ok("an item with variants needs one chosen", fails(await addItem(await newOrder(), PIZZA, 1, { addonIds: [DIP] }), /choose a size|variant/));
ok("a group's minimum is enforced", fails(await addItem(await newOrder(), PIZZA, 1, { variantId: VL }), /Dip/));
ok("a group's maximum is enforced", fails(await addItem(await newOrder(), PIZZA, 1, { variantId: VL, addonIds: [CHEESE, OLIVE, DIP, DIP] }), /Dip|at most/));
r = await addItem(await newOrder(), PIZZA, 2, { variantId: VL, addonIds: [CHEESE, DIP] });
ok("variant price + add-ons is the unit price", r.ok && r.rows[0].price === 350 + 40 + 20);
ok("the name carries the variant", r.rows?.[0].name === "Pizza (Large)");
ok("the options snapshot is stored", r.rows?.[0].options?.variant?.name === "Large" && r.rows[0].options.addons.length === 2);
ok("an add-on from another item is refused", fails(await addItem(await newOrder(), NAAN, 1, { addonIds: [CHEESE] }), /add-on/));
await db.exec(`update public.menu_item_variants set available = false where id = '${VL}'`);
ok("an unavailable variant is refused", fails(await addItem(await newOrder(), PIZZA, 1, { variantId: VL, addonIds: [DIP] }), /variant/));

console.log("\n── stock ──");
await as("authenticated", V, `update public.menu_items set stock_qty = 3, low_stock_at = 1 where id = '${NAAN}'`);
ok("more than is left is refused", fails(await addItem(await newOrder(), NAAN, 4), /only 3 left/));
const so = await newOrder();
await addItem(so, NAAN, 3);
r = await as("service_role", null, `select stock_qty, available, sold_out_by_stock from public.menu_items where id = '${NAAN}'`);
ok("ordering takes it out of stock", r.rows[0].stock_qty === 0);
ok("…and at zero the dish turns sold out", r.rows[0].available === false && r.rows[0].sold_out_by_stock === true);
await as("authenticated", C, `update public.orders set status = 'cancelled' where id = '${so}'`);
r = await as("service_role", null, `select stock_qty, available, sold_out_by_stock from public.menu_items where id = '${NAAN}'`);
ok("a cancelled order puts the stock back and the dish back on", r.rows[0].stock_qty === 3 && r.rows[0].available === true && r.rows[0].sold_out_by_stock === false);
await as("authenticated", V, `update public.menu_items set stock_qty = 0 where id = '${NAAN}'`);
ok("the vendor setting stock to 0 marks it sold out", (await as("service_role", null, `select available from public.menu_items where id = '${NAAN}'`)).rows[0].available === false);
await as("authenticated", V, `update public.menu_items set stock_qty = 10 where id = '${NAAN}'`);
ok("restocking brings it back", (await as("service_role", null, `select available from public.menu_items where id = '${NAAN}'`)).rows[0].available === true);
await as("authenticated", V, `update public.menu_items set available = false where id = '${NAAN}'`);
await as("authenticated", V, `update public.menu_items set stock_qty = 12 where id = '${NAAN}'`);
ok("restocking does not undo a manual sold-out", (await as("service_role", null, `select available from public.menu_items where id = '${NAAN}'`)).rows[0].available === false);
await as("authenticated", V, `update public.menu_items set available = true, stock_qty = null where id = '${NAAN}'`);

console.log("\n── availability schedule ──");
await as("authenticated", V, `update public.menu_items set available_days = array[((extract(dow from ${istNow})::int + 1) % 7)::smallint] where id = '${NAAN}'`);
ok("a dish not offered today is refused", fails(await addItem(await newOrder(), NAAN), /not available right now/));
await as("authenticated", V, `update public.menu_items set available_days = null, available_from = (${istNow})::time + interval '1 hour', available_to = (${istNow})::time + interval '2 hours' where id = '${NAAN}'`);
ok("a dish outside its hours is refused", fails(await addItem(await newOrder(), NAAN), /not available right now/));
await as("authenticated", V, `update public.menu_items set available_from = null, available_to = null where id = '${NAAN}'`);
ok("with no schedule it can be ordered", (await addItem(await newOrder(), NAAN)).ok);

console.log("\n── holidays ──");
ok("the owner adds a holiday", (await as("authenticated", V, `insert into public.store_holidays (restaurant_id, starts_on, ends_on, note) values ('${R}','2026-11-12','2026-11-13','Diwali')`)).ok);
ok("another vendor cannot", fails(await as("authenticated", V2, `insert into public.store_holidays (restaurant_id, starts_on, ends_on) values ('${R}','2026-12-01','2026-12-01')`), /row-level security/));
ok("an end before the start is refused", fails(await as("authenticated", V, `insert into public.store_holidays (restaurant_id, starts_on, ends_on) values ('${R}','2026-12-05','2026-12-01')`), /store_holidays_range/));
ok("customers can read holidays", (await as("anon", null, `select id from public.store_holidays where restaurant_id = '${R}'`)).rows?.length === 1);

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
