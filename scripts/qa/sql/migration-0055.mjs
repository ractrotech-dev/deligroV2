// Runs the migration in an in-process Postgres (PGlite) with stubbed Supabase auth helpers.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/<file>
// Proves the trigger / policy / grant logic; it does not replace running the migration on staging.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/0055_order_delivery_integrity.sql", import.meta.url), "utf8");
const db = new PGlite();

await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;

  create type order_status as enum ('placed','kitchen','ready','on_the_way','delivered','cancelled');
  create type payment_status as enum ('pending','authorized','paid','failed','refunded');

  create table public.profiles (id uuid primary key, role text not null);
  create table public.restaurants (id uuid primary key, owner_id uuid);
  create table public.menu_items (id uuid primary key, restaurant_id uuid, name text, price numeric, discount_price numeric, available boolean default true);
  create table public.orders (
    id uuid primary key, customer_id uuid, restaurant_id uuid,
    status order_status not null default 'placed',
    payment_status payment_status not null default 'pending',
    total numeric default 0, delivery_fee numeric default 0, tax_amount numeric default 0, tip numeric default 0,
    pickup_otp text default '1111', delivery_otp text default '2222',
    external_id text, idempotency_key text);
  create table public.order_items (id uuid primary key default gen_random_uuid(), order_id uuid, menu_item_id uuid, name text, qty int, price numeric);
  create table public.payments (id uuid primary key default gen_random_uuid(), order_id uuid);
  create table public.deliveries (id uuid primary key default gen_random_uuid(), order_id uuid, driver_id uuid);
  alter table public.orders enable row level security;
  alter table public.deliveries enable row level security;
  create policy "orders — read" on public.orders for select using (true);
  create policy "orders — update" on public.orders for update using (true);
  create policy "deliveries — driver update" on public.deliveries for update using (true);

  create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;
  create function public.is_manager() returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select role = 'manager' from public.profiles where id = auth.uid()), false) $$;
  create function public.owns_restaurant(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.restaurants r where r.id = rid and r.owner_id = auth.uid()) $$;

  create policy "orders — manager update" on public.orders for update using (public.is_manager()) with check (public.is_manager());
  create policy "orders — manager read" on public.orders for select using (public.is_manager());
  create role svc_role bypassrls;
  grant usage on schema public, auth to svc_role;
  grant all on all tables in schema public to svc_role;
  grant execute on all functions in schema public to svc_role;
  grant execute on all functions in schema auth to svc_role;
  create role app_user;
  grant usage on schema public, auth to app_user;
  grant all on all tables in schema public to app_user;
  grant execute on all functions in schema public to app_user;
  grant execute on all functions in schema auth to app_user;
`);

// Apply the migration exactly as written.
await db.exec(MIGRATION);

// The 0053 triggers the migration's functions plug into.
await db.exec(`
  create trigger orders_guard_update before update on public.orders for each row execute function public.guard_order_update();
  create trigger order_items_guard_insert before insert on public.order_items for each row execute function public.guard_order_item_insert();
`);

const U = {
  customer: "00000000-0000-0000-0000-0000000000c1",
  vendor: "00000000-0000-0000-0000-0000000000a1",
  vendor2: "00000000-0000-0000-0000-0000000000a2",
  manager: "00000000-0000-0000-0000-0000000000b1",
  admin: "00000000-0000-0000-0000-0000000000d1",
  rider: "00000000-0000-0000-0000-0000000000e1",
};
const R = "00000000-0000-0000-0000-0000000000f1";
const O = "00000000-0000-0000-0000-000000000001";
const M = "00000000-0000-0000-0000-0000000000aa";

await db.exec(`
  insert into public.profiles values
   ('${U.customer}','customer'),('${U.vendor}','customer'),('${U.vendor2}','customer'),
   ('${U.manager}','manager'),('${U.admin}','admin'),('${U.rider}','driver');
  insert into public.restaurants values ('${R}','${U.vendor}');
  insert into public.menu_items values ('${M}','${R}','Naan',30,null,true);
`);

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) passed++; else failed++; console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`); }

async function as(uid, jwtRole, sql) {
  await db.exec(`set role ${jwtRole === "service_role" ? "svc_role" : "app_user"}; select set_config('test.uid','${uid ?? ""}',false), set_config('test.jwt','${jwtRole ? JSON.stringify({ role: jwtRole }) : ""}',false);`);
  try { const r = sql.trim().toLowerCase().startsWith("update") ? await db.query(sql + " returning id") : null; if (r) return r.rows.length ? { ok: true } : { ok: false, msg: "0 rows (hidden by RLS)" }; await db.exec(sql); return { ok: true }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec("reset role"); }
}
async function reset(status = "placed", pay = "pending") {
  await db.exec(`delete from public.order_items; delete from public.payments; delete from public.orders;
    insert into public.orders (id, customer_id, restaurant_id, status, payment_status) values ('${O}','${U.customer}','${R}','${status}','${pay}');`);
}
const set = (col, val) => `update public.orders set ${col} = ${val} where id = '${O}'`;

console.log("\n── status machine ──");
for (const [from, to, who, expect] of [
  ["placed", "kitchen", "vendor", true], ["placed", "cancelled", "vendor", true],
  ["kitchen", "ready", "vendor", true], ["kitchen", "cancelled", "vendor", true], ["ready", "cancelled", "vendor", true],
  ["placed", "delivered", "vendor", false], ["kitchen", "delivered", "vendor", false], ["ready", "on_the_way", "vendor", false],
  ["delivered", "cancelled", "vendor", false], ["cancelled", "placed", "vendor", false], ["cancelled", "kitchen", "vendor", false],
  ["delivered", "placed", "vendor", false],
  ["placed", "kitchen", "manager", true], ["kitchen", "ready", "manager", true], ["ready", "on_the_way", "manager", true], ["on_the_way", "delivered", "manager", true],
  ["placed", "delivered", "manager", false], ["kitchen", "cancelled", "manager", false], ["delivered", "cancelled", "manager", false],
  ["placed", "kitchen", "rider", false], ["on_the_way", "delivered", "rider", false],
  ["placed", "kitchen", "customer", false], ["placed", "cancelled", "customer", false],
  ["placed", "kitchen", "vendor2", false],
  ["delivered", "placed", "admin", true], ["cancelled", "kitchen", "admin", true],
]) {
  await reset(from);
  const r = await as(U[who], null, set("status", `'${to}'`));
  ok(`${who}: ${from} -> ${to} ${expect ? "allowed" : "refused"}`, r.ok === expect);
}
await reset("cancelled");
ok("service_role JWT is exempt (cancelled -> delivered)", (await as(U.customer, "service_role", set("status", "'delivered'"))).ok);
await reset("ready");
ok("postgres-owned definer calls are exempt", (await db.exec(set("status", "'delivered'")), true));

console.log("\n── locked columns ──");
for (const col of ["pickup_otp", "delivery_otp", "external_id", "idempotency_key"]) {
  await reset("placed");
  const r = await as(U.vendor, null, set(col, "'hacked'"));
  ok(`vendor cannot change ${col}`, !r.ok && /only order status/.test(r.msg ?? ""));
  await reset("ready");
  const m = await as(U.manager, null, set(col, "'hacked'"));
  ok(`manager cannot change ${col}`, !m.ok);
}
await reset("placed");
ok("vendor status-only update passes both guards", (await as(U.vendor, null, set("status", "'kitchen'"))).ok);
await reset("placed");
ok("vendor cannot change total", !(await as(U.vendor, null, set("total", "1"))).ok);
await reset("placed");
ok("admin may change an OTP", (await as(U.admin, null, set("delivery_otp", "'9999'"))).ok);

console.log("\n── order_items after payment starts ──");
const ins = `insert into public.order_items (order_id, menu_item_id, qty) values ('${O}','${M}',1)`;
await reset("placed", "pending");
ok("customer can add items to a fresh unpaid order", (await as(U.customer, null, ins)).ok);
await reset("placed", "pending");
await db.exec(`insert into public.payments (order_id) values ('${O}')`);
{
  const r = await as(U.customer, null, ins);
  ok("refused once a payments row exists", !r.ok && /payment has started/.test(r.msg ?? ""));
}
await reset("placed", "paid");
{
  const r = await as(U.customer, null, ins);
  ok("refused when payment_status is paid", !r.ok && /payment has started/.test(r.msg ?? ""));
}
await reset("placed", "pending");
ok("another customer cannot add items", !(await as(U.vendor2, null, ins)).ok);
await reset("kitchen", "pending");
ok("refused once the kitchen has the order", !(await as(U.customer, null, ins)).ok);
await reset("placed", "paid");
ok("service role may still insert (phone orders)", (await as(null, "service_role", ins)).ok);

console.log("\n── policies ──");
const pol = await db.query(`select policyname, qual, cmd from pg_policies where schemaname='public' and tablename in ('orders','deliveries') order by 1`);
const names = pol.rows.map((r) => r.policyname);
ok("deliveries — driver update is gone", !names.includes("deliveries — driver update"));
ok("orders policies recreated", names.includes("orders — read") && names.includes("orders — update"));
ok("no policy mentions the active-driver helper", pol.rows.every((r) => !String(r.qual).includes("is_active_driver_for")));

console.log("\n── idempotent ──");
let rerun = true;
try { await db.exec(MIGRATION); } catch (e) { rerun = false; console.log(e.message); }
ok("migration can be applied twice", rerun);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
