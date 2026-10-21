// Runs migration 0063 in an in-process Postgres (PGlite) with stubbed Supabase auth helpers.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0063.mjs
// Proves gapless per-shop, per-financial-year invoice numbers and that clients can't set them;
// it does not replace running the migration on staging.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/0063_order_invoices.sql", import.meta.url), "utf8");
const db = new PGlite();

// The schema as 0063 finds it: orders with 0061's guard trigger in place.
await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
  create role anon; create role authenticated; create role service_role bypassrls;
  create type public.order_status as enum ('placed', 'kitchen', 'ready', 'on_the_way', 'delivered', 'cancelled');
  create table public.profiles (id uuid primary key, role text not null);
  create table public.restaurants (id uuid primary key, owner_id uuid);
  create table public.orders (id uuid primary key default gen_random_uuid(), customer_id uuid, restaurant_id uuid references public.restaurants,
    status public.order_status not null default 'placed', total integer default 0, created_at timestamptz not null default now(),
    preparing_at timestamptz);
  create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;
  create function public.owns_restaurant(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.restaurants r where r.id = rid and r.owner_id = auth.uid()) $$;
  alter table public.orders enable row level security;
  create policy "orders — read" on public.orders for select using (customer_id = auth.uid() or public.owns_restaurant(restaurant_id) or public.is_admin());
  create policy "orders — update" on public.orders for update using (public.owns_restaurant(restaurant_id) or public.is_admin());
  -- 0061's guard (locked list trimmed to the columns this harness has).
  create function public.guard_order_update() returns trigger language plpgsql security invoker set search_path = public as $$
  begin
    if public.is_admin() or current_user in ('postgres', 'supabase_admin') then return new; end if;
    if old.total is distinct from new.total then raise exception 'only order status may be changed by this role (attempted: total)'; end if;
    return new;
  end $$;
  create trigger orders_guard_update before update on public.orders for each row execute function public.guard_order_update();
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant select, insert, update on public.orders to authenticated;
  grant all on all tables in schema public to service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`);

const V = "00000000-0000-0000-0000-0000000000a1", V2 = "00000000-0000-0000-0000-0000000000a2";
const R = "00000000-0000-0000-0000-0000000000f1", R2 = "00000000-0000-0000-0000-0000000000f2";
await db.exec(`
  insert into public.profiles values ('${V}','restaurant'),('${V2}','restaurant');
  insert into public.restaurants values ('${R}','${V}'),('${R2}','${V2}');
  -- Already-delivered history the backfill must number: two in FY 2025-26, one in 2026-27, one still cooking.
  insert into public.orders (id, restaurant_id, status, created_at) values
    ('00000000-0000-0000-0000-00000000aa01','${R}','delivered','2026-01-10T10:00:00Z'),
    ('00000000-0000-0000-0000-00000000aa02','${R}','on_the_way','2026-03-31T17:00:00Z'),
    ('00000000-0000-0000-0000-00000000aa03','${R}','delivered','2026-03-31T19:00:00Z'),
    ('00000000-0000-0000-0000-00000000aa04','${R}','kitchen','2026-05-01T10:00:00Z');
`);

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };
async function as(role, uid, sql) {
  await db.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec("reset role"); }
}
const fails = (r, re) => !r.ok && re.test(r.msg);
const inv = async (id) => (await db.query(`select invoice_no from public.orders where id = '${id}'`)).rows[0].invoice_no;

await db.exec(MIGRATION);

console.log("\n── financial year (IST) ──");
const fy = async (t) => (await db.query(`select public.invoice_fy('${t}'::timestamptz) as f`)).rows[0].f;
ok("1 April IST starts the year", (await fy("2026-03-31T18:30:00Z")) === "2026-27");
ok("31 March IST ends it", (await fy("2026-03-31T18:29:00Z")) === "2025-26");
ok("January belongs to the year that began last April", (await fy("2027-01-15T00:00:00Z")) === "2026-27");
ok("a century turn pads the short year", (await fy("2099-06-01T00:00:00Z")) === "2099-00");

console.log("\n── backfill ──");
ok("the oldest delivered order is 00001 of its year", (await inv("00000000-0000-0000-0000-00000000aa01")) === "INV/2025-26/00001");
ok("31 Mar 22:30 IST is still FY 2025-26, numbered next", (await inv("00000000-0000-0000-0000-00000000aa02")) === "INV/2025-26/00002");
ok("31 Mar 19:00Z is 1 Apr 00:30 IST — FY 2026-27 starts at 00001", (await inv("00000000-0000-0000-0000-00000000aa03")) === "INV/2026-27/00001");
ok("an order still cooking has none", (await inv("00000000-0000-0000-0000-00000000aa04")) === null);

console.log("\n── assigned when the kitchen's part is done ──");
const cur = (await db.query(`select public.invoice_fy(now()) as f`)).rows[0].f;
await db.exec(`insert into public.orders (id, restaurant_id, status) values
  ('00000000-0000-0000-0000-0000000000b1','${R}','kitchen'),
  ('00000000-0000-0000-0000-0000000000b2','${R}','kitchen'),
  ('00000000-0000-0000-0000-0000000000b3','${R2}','kitchen')`);
const base = (await db.query(`select coalesce(max(last_no),0) as n from public.invoice_counters where restaurant_id = '${R}' and fy = '${cur}'`)).rows[0].n;
await as("authenticated", V, `update public.orders set status = 'ready' where id = '00000000-0000-0000-0000-0000000000b1'`);
ok("ready is not yet invoiced", (await inv("00000000-0000-0000-0000-0000000000b1")) === null);
const r1 = await as("authenticated", V, `update public.orders set status = 'on_the_way' where id = '00000000-0000-0000-0000-0000000000b1'`);
ok("the vendor's status change is not blocked by the guard", r1.ok);
ok("on_the_way stamps the next number", (await inv("00000000-0000-0000-0000-0000000000b1")) === `INV/${cur}/${String(base + 1).padStart(5, "0")}`);
await as("authenticated", V, `update public.orders set status = 'delivered' where id = '00000000-0000-0000-0000-0000000000b1'`);
ok("delivered keeps the same number", (await inv("00000000-0000-0000-0000-0000000000b1")) === `INV/${cur}/${String(base + 1).padStart(5, "0")}`);
await as("authenticated", V2, `update public.orders set status = 'delivered' where id = '00000000-0000-0000-0000-0000000000b3'`);
ok("another shop counts from its own 00001", (await inv("00000000-0000-0000-0000-0000000000b3")) === `INV/${cur}/00001`);

console.log("\n── gapless ──");
await db.exec("begin");
await db.exec(`update public.orders set status = 'delivered' where id = '00000000-0000-0000-0000-0000000000b2'`);
await db.exec("rollback");
ok("a rolled-back change hands its number back", (await inv("00000000-0000-0000-0000-0000000000b2")) === null);
await as("authenticated", V, `update public.orders set status = 'delivered' where id = '00000000-0000-0000-0000-0000000000b2'`);
ok("…so the next order takes it", (await inv("00000000-0000-0000-0000-0000000000b2")) === `INV/${cur}/${String(base + 2).padStart(5, "0")}`);

console.log("\n── nobody else sets it ──");
ok("the vendor cannot write an invoice number", fails(await as("authenticated", V, `update public.orders set invoice_no = 'INV/X/1' where id = '00000000-0000-0000-0000-0000000000b2'`), /only order status|permission denied/));
ok("…nor clear one", fails(await as("authenticated", V, `update public.orders set invoice_no = null where id = '00000000-0000-0000-0000-0000000000b2'`), /only order status|permission denied/));
ok("clients cannot read the counters", fails(await as("authenticated", V, `select * from public.invoice_counters`), /permission denied/));
ok("the vendor reads their invoice numbers", (await as("authenticated", V, `select invoice_no from public.orders where id = '00000000-0000-0000-0000-0000000000b2'`)).rows?.[0]?.invoice_no?.startsWith("INV/"));
let dup = null;
try { await db.query(`update public.orders set invoice_no = 'INV/2025-26/00001' where id = '00000000-0000-0000-0000-00000000aa02'`); } catch (e) { dup = String(e.message); }
ok("even the owner can't give two orders of one shop the same number", /duplicate key|unique/.test(dup ?? ""));

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);
ok("…without renumbering", (await inv("00000000-0000-0000-0000-00000000aa01")) === "INV/2025-26/00001");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
