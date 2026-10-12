// Runs the migration in an in-process Postgres (PGlite) with stubbed Supabase auth helpers.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0058.mjs
// Proves the privilege and function logic; it does not replace running the migration on staging.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/0058_handover_code_privacy.sql", import.meta.url), "utf8");
const db = new PGlite();

await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create role anon; create role authenticated; create role service_role bypassrls;

  create table public.profiles (id uuid primary key, role text not null);
  create table public.restaurants (id uuid primary key, owner_id uuid);
  create table public.orders (id uuid primary key, customer_id uuid, restaurant_id uuid, status text default 'placed',
    total numeric default 0, pickup_otp text default '4321', delivery_otp text default '8765', created_at timestamptz default now());
  create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;
  create function public.owns_restaurant(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.restaurants r where r.id = rid and r.owner_id = auth.uid()) $$;

  alter table public.orders enable row level security;
  create policy "orders — read" on public.orders for select
    using (customer_id = auth.uid() or public.owns_restaurant(restaurant_id) or public.is_admin());
  create policy "orders — update" on public.orders for update
    using (public.owns_restaurant(restaurant_id) or public.is_admin());
  create policy "orders — insert" on public.orders for insert with check (customer_id = auth.uid());

  -- Supabase default: full table grants to the API roles.
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;

  -- A definer function that selects every column, like apply_coupon_to_order.
  create function public.touch_order(oid uuid) returns numeric language plpgsql security definer set search_path = public as $$
    declare o public.orders%rowtype; begin select * into o from public.orders where id = oid; return o.total; end $$;
`);

const C = "00000000-0000-0000-0000-0000000000c1", V = "00000000-0000-0000-0000-0000000000a1", V2 = "00000000-0000-0000-0000-0000000000a2", A = "00000000-0000-0000-0000-0000000000d1";
const R = "00000000-0000-0000-0000-0000000000f1", O = "00000000-0000-0000-0000-000000000001";
await db.exec(`
  insert into public.profiles values ('${C}','customer'),('${V}','customer'),('${V2}','customer'),('${A}','admin');
  insert into public.restaurants values ('${R}','${V}');
  insert into public.orders (id, customer_id, restaurant_id) values ('${O}','${C}','${R}');
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
const denied = (r) => !r.ok && /permission denied/.test(r.msg);

console.log("\n── the codes are no longer readable by the table ──");
for (const [who, uid] of [["customer", C], ["vendor", V], ["admin", A]]) {
  ok(`${who}: select delivery_otp is denied`, denied(await as("authenticated", uid, `select delivery_otp from public.orders`)));
  ok(`${who}: select pickup_otp is denied`, denied(await as("authenticated", uid, `select pickup_otp from public.orders`)));
  ok(`${who}: select * is denied (no screen may use it)`, denied(await as("authenticated", uid, `select * from public.orders`)));
}
ok("anon cannot read orders at all", denied(await as("anon", null, `select id from public.orders`)));

console.log("\n── every other column still works ──");
const cols = await as("authenticated", C, `select id, customer_id, restaurant_id, status, total, created_at from public.orders`);
ok("customer reads their order's other columns", cols.ok && cols.rows.length === 1);
ok("vendor reads their shop's order", (await as("authenticated", V, `select id, status, total from public.orders`)).rows?.length === 1);
ok("a stranger sees no rows (RLS unchanged)", (await as("authenticated", V2, `select id from public.orders`)).rows?.length === 0);

console.log("\n── writes still work ──");
ok("vendor update ... returning id", (await as("authenticated", V, `update public.orders set status = 'kitchen' where id = '${O}' and status = 'placed' returning id`)).rows?.length === 1);
ok("customer insert ... returning id", (await as("authenticated", C, `insert into public.orders (id, customer_id, restaurant_id) values (gen_random_uuid(), '${C}', '${R}') returning id`)).rows?.length === 1);
ok("customer insert without returning", (await as("authenticated", C, `insert into public.orders (id, customer_id, restaurant_id) values (gen_random_uuid(), '${C}', '${R}')`)).ok);

console.log("\n── the narrow readers ──");
let r = await as("authenticated", C, `select public.my_delivery_otp('${O}') as otp`);
ok("the customer gets their own delivery code", r.rows?.[0].otp === "8765");
r = await as("authenticated", V, `select public.my_delivery_otp('${O}') as otp`);
ok("the vendor does NOT get the delivery code", r.rows?.[0].otp === null);
r = await as("authenticated", V2, `select public.my_delivery_otp('${O}') as otp`);
ok("a stranger does not either", r.rows?.[0].otp === null);
r = await as("authenticated", V, `select * from public.kitchen_pickup_otps(array['${O}']::uuid[])`);
ok("the owning vendor gets the pickup code", r.rows?.length === 1 && r.rows[0].pickup_otp === "4321");
r = await as("authenticated", C, `select * from public.kitchen_pickup_otps(array['${O}']::uuid[])`);
ok("the customer does NOT get the pickup code", r.rows?.length === 0);
r = await as("authenticated", V2, `select * from public.kitchen_pickup_otps(array['${O}']::uuid[])`);
ok("another vendor does not", r.rows?.length === 0);
r = await as("authenticated", A, `select * from public.kitchen_pickup_otps(array['${O}']::uuid[])`);
ok("admin does", r.rows?.length === 1);
ok("anon cannot call either function", denied(await as("anon", null, `select public.my_delivery_otp('${O}')`)) && denied(await as("anon", null, `select * from public.kitchen_pickup_otps(array['${O}']::uuid[])`)));

console.log("\n── server side is unaffected ──");
r = await as("service_role", null, `select pickup_otp, delivery_otp from public.orders where id = '${O}'`);
ok("service role still reads both codes", r.rows?.[0].pickup_otp === "4321" && r.rows[0].delivery_otp === "8765");
r = await as("authenticated", C, `select public.touch_order('${O}') as t`);
ok("a SECURITY DEFINER select * (apply_coupon_to_order style) still works", r.ok);

console.log("\n── a later column is invisible until granted (documented trap) ──");
await db.exec(`alter table public.orders add column note text default 'x'`);
ok("new column: permission denied for authenticated", denied(await as("authenticated", C, `select note from public.orders`)));
await db.exec(`grant select (note) on public.orders to authenticated`);
ok("...visible once granted", (await as("authenticated", C, `select note from public.orders`)).ok);

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);
ok("...and the later grant survives a re-run", (await as("authenticated", C, `select id, note from public.orders`)).ok);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
