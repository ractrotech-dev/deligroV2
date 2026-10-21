// Runs migration 0061 in an in-process Postgres (PGlite) with stubbed Supabase auth helpers.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0061.mjs
// Proves the policy, guard and trigger logic; it does not replace running the migration on staging.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/0061_vendor_app_foundation.sql", import.meta.url), "utf8");
const db = new PGlite();

// The schema as 0061 finds it: the order guard from 0055, the column grants
// from 0058, and the money tables readable by admins only (0001, 0028, 0048).
await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
  create role anon; create role authenticated; create role service_role bypassrls;

  create type public.order_status as enum ('placed', 'kitchen', 'ready', 'on_the_way', 'delivered', 'cancelled');
  create type public.vendor_settlement_status as enum ('draft', 'paid', 'void');

  create table public.profiles (id uuid primary key, role text not null);
  create table public.restaurants (id uuid primary key, owner_id uuid);
  create table public.orders (id uuid primary key, customer_id uuid, restaurant_id uuid,
    status public.order_status not null default 'placed', total numeric default 0,
    cancellation_reason text, created_at timestamptz default now());
  create table public.refunds (id uuid primary key default gen_random_uuid(), order_id uuid references public.orders, amount integer);
  create table public.vendor_settlements (id uuid primary key, restaurant_id uuid,
    status public.vendor_settlement_status not null default 'draft', net_payable integer default 0, notes text);
  create table public.vendor_settlement_orders (id uuid primary key default gen_random_uuid(),
    settlement_id uuid references public.vendor_settlements on delete cascade, order_id uuid references public.orders);
  create table public.settlement_corrections (id uuid primary key default gen_random_uuid(), restaurant_id uuid,
    order_id uuid references public.orders, amount integer);
  create table public.platform_settings (id integer primary key default 1,
    customer_apk_version_code integer not null default 1);
  insert into public.platform_settings default values;

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

  alter table public.refunds enable row level security;
  create policy "refunds — read" on public.refunds for select using (
    exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()) or public.is_admin());
  alter table public.vendor_settlements enable row level security;
  create policy "vendor_settlements — admin read" on public.vendor_settlements for select using (public.is_admin());
  alter table public.vendor_settlement_orders enable row level security;
  create policy "vendor_settlement_orders — admin read" on public.vendor_settlement_orders for select using (public.is_admin());
  alter table public.settlement_corrections enable row level security;
  create policy "settlement_corrections — admin read" on public.settlement_corrections for select using (public.is_admin());

  -- 0055's guard, verbatim.
  create function public.guard_order_update() returns trigger
  language plpgsql security invoker set search_path = public as $$
  declare
    locked constant text[] := array[
      'id', 'customer_id', 'restaurant_id', 'total', 'delivery_fee', 'tax_amount', 'tip',
      'address', 'created_at', 'payment_method', 'payment_status',
      'accepted_at', 'ready_at', 'cancelled_at', 'channel', 'placed_by',
      'coupon_code', 'discount', 'discount_funded_by', 'cancelled_by',
      'pickup_otp', 'delivery_otp', 'external_id', 'idempotency_key'];
    col text; old_row jsonb := to_jsonb(old); new_row jsonb := to_jsonb(new);
  begin
    if public.is_admin()
       or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
       or current_user in ('postgres', 'supabase_admin') then
      return new;
    end if;
    foreach col in array locked loop
      if (old_row -> col) is distinct from (new_row -> col) then
        raise exception 'only order status may be changed by this role (attempted: %)', col;
      end if;
    end loop;
    return new;
  end; $$;
  create trigger guard_order_update before update on public.orders
    for each row execute function public.guard_order_update();

  -- Supabase default: full table grants to the API roles...
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
  -- ...narrowed as the real migrations narrow them.
  revoke select on public.orders from anon, authenticated;
  grant select (id, customer_id, restaurant_id, status, total, cancellation_reason, created_at) on public.orders to authenticated;
  revoke insert, update, delete on public.vendor_settlements, public.vendor_settlement_orders from anon, authenticated;
  revoke all on public.settlement_corrections from anon, authenticated;
  grant select on public.settlement_corrections to authenticated;
`);

const C = "00000000-0000-0000-0000-0000000000c1", C2 = "00000000-0000-0000-0000-0000000000c2";
const V = "00000000-0000-0000-0000-0000000000a1", V2 = "00000000-0000-0000-0000-0000000000a2", A = "00000000-0000-0000-0000-0000000000d1";
const R = "00000000-0000-0000-0000-0000000000f1", R2 = "00000000-0000-0000-0000-0000000000f2";
const O_KITCHEN = "00000000-0000-0000-0000-000000000001", O_PLACED = "00000000-0000-0000-0000-000000000002";
const O_FLOW = "00000000-0000-0000-0000-000000000003", O_OTHER = "00000000-0000-0000-0000-000000000004";
const O_PREP = "00000000-0000-0000-0000-000000000005";
const S_PAID = "00000000-0000-0000-0000-0000000000e1", S_DRAFT = "00000000-0000-0000-0000-0000000000e2", S_OTHER = "00000000-0000-0000-0000-0000000000e3";

await db.exec(`
  insert into public.profiles values ('${C}','customer'),('${C2}','customer'),('${V}','restaurant'),('${V2}','restaurant'),('${A}','admin');
  insert into public.restaurants values ('${R}','${V}'),('${R2}','${V2}');
  insert into public.orders (id, customer_id, restaurant_id, status) values
    ('${O_KITCHEN}','${C}','${R}','kitchen'), ('${O_PLACED}','${C}','${R}','placed'),
    ('${O_OTHER}','${C}','${R2}','kitchen'), ('${O_PREP}','${C}','${R}','placed');
  insert into public.refunds (order_id, amount) values ('${O_KITCHEN}', 50), ('${O_OTHER}', 70);
  insert into public.vendor_settlements (id, restaurant_id, status, net_payable) values
    ('${S_PAID}','${R}','paid',900), ('${S_DRAFT}','${R}','draft',300), ('${S_OTHER}','${R2}','paid',400);
  insert into public.vendor_settlement_orders (settlement_id, order_id) values
    ('${S_PAID}','${O_KITCHEN}'), ('${S_DRAFT}','${O_PLACED}'), ('${S_OTHER}','${O_OTHER}');
  insert into public.settlement_corrections (restaurant_id, order_id, amount) values ('${R}','${O_KITCHEN}',20), ('${R2}','${O_OTHER}',30);
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
const ids = (r) => (r.rows ?? []).map((x) => x.id).sort();

console.log("\n── vendors read their own settlements, never drafts or other shops ──");
let r = await as("authenticated", V, `select id from public.vendor_settlements`);
ok("vendor sees exactly their paid settlement", JSON.stringify(ids(r)) === JSON.stringify([S_PAID]));
r = await as("authenticated", V, `select settlement_id from public.vendor_settlement_orders`);
ok("vendor sees only the lines of that settlement", r.rows?.length === 1 && r.rows[0].settlement_id === S_PAID);
r = await as("authenticated", V, `select amount from public.settlement_corrections`);
ok("vendor sees their shop's corrections only", r.rows?.length === 1 && r.rows[0].amount === 20);
r = await as("authenticated", V2, `select id from public.vendor_settlements`);
ok("the other vendor sees only theirs", JSON.stringify(ids(r)) === JSON.stringify([S_OTHER]));
r = await as("authenticated", C, `select id from public.vendor_settlements`);
ok("a customer sees none", r.rows?.length === 0);
r = await as("authenticated", A, `select id from public.vendor_settlements`);
ok("admin still sees all three, drafts included", r.rows?.length === 3);
ok("vendor still cannot write a settlement",
  fails(await as("authenticated", V, `update public.vendor_settlements set net_payable = 1 where id = '${S_PAID}'`), /permission denied/));

console.log("\n── vendors read refunds on their own orders (the zero-refunds bug) ──");
r = await as("authenticated", V, `select amount from public.refunds`);
ok("vendor reads the refund on their order", r.rows?.length === 1 && r.rows[0].amount === 50);
r = await as("authenticated", V2, `select amount from public.refunds`);
ok("other vendor reads only theirs", r.rows?.length === 1 && r.rows[0].amount === 70);
r = await as("authenticated", C, `select amount from public.refunds`);
ok("customer still reads refunds on their orders", r.rows?.length === 2);

console.log("\n── the Preparing step ──");
ok("vendor cannot stamp preparing_at directly",
  fails(await as("authenticated", V, `update public.orders set preparing_at = now() where id = '${O_KITCHEN}'`), /only order status may be changed/));
r = await as("authenticated", V2, `select public.start_preparing('${O_KITCHEN}') as t`);
ok("another vendor cannot start preparing this order", fails(r, /invalid_transition/));
r = await as("authenticated", V, `select public.start_preparing('${O_PLACED}') as t`);
ok("an order not yet accepted cannot start preparing", fails(r, /invalid_transition/));
r = await as("authenticated", V, `select public.start_preparing('${O_KITCHEN}') as t`);
ok("owner starts preparing an accepted order", r.ok && r.rows[0].t !== null);
r = await as("authenticated", V, `select public.start_preparing('${O_KITCHEN}') as t`);
ok("starting twice is refused", fails(r, /invalid_transition/));
r = await as("authenticated", V, `select kind from public.order_status_events where order_id = '${O_KITCHEN}' and kind = 'preparing'`);
ok("one preparing event is recorded", r.rows?.length === 1);
r = await as("authenticated", V, `select preparing_at from public.orders where id = '${O_KITCHEN}'`);
ok("preparing_at is readable by the vendor", r.ok && r.rows[0].preparing_at !== null);
ok("anon cannot call start_preparing",
  fails(await as("anon", null, `select public.start_preparing('${O_KITCHEN}')`), /permission denied/));

console.log("\n── per-order prep time ──");
r = await as("authenticated", V, `update public.orders set status = 'kitchen', prep_minutes = 25 where id = '${O_PREP}' returning prep_minutes`);
ok("vendor sets prep time while accepting", r.ok && r.rows[0].prep_minutes === 25);
ok("prep time out of range is refused",
  fails(await as("authenticated", V, `update public.orders set prep_minutes = 500 where id = '${O_PREP}'`), /orders_prep_minutes_range/));
await as("authenticated", V, `update public.orders set status = 'ready' where id = '${O_PREP}'`);
ok("prep time is locked once the order is ready",
  fails(await as("authenticated", V, `update public.orders set prep_minutes = 30 where id = '${O_PREP}'`), /prep_minutes_locked/));
ok("admin may still correct it", (await as("authenticated", A, `update public.orders set prep_minutes = 30 where id = '${O_PREP}'`)).ok);

console.log("\n── status history ──");
await as("authenticated", C, `insert into public.orders (id, customer_id, restaurant_id) values ('${O_FLOW}','${C}','${R}')`);
await as("authenticated", V, `update public.orders set status = 'kitchen' where id = '${O_FLOW}'`);
await as("authenticated", V, `update public.orders set status = 'cancelled', cancellation_reason = 'Out of stock' where id = '${O_FLOW}'`);
r = await as("authenticated", V, `select from_status, to_status, actor_id, reason from public.order_status_events
  where order_id = '${O_FLOW}' and kind = 'status' order by id`);
ok("placing and two changes give three status events", r.rows?.length === 3);
ok("the first is the order being placed", r.rows?.[0].from_status === null && r.rows[0].to_status === "placed" && r.rows[0].actor_id === C);
ok("the accept is attributed to the vendor", r.rows?.[1].from_status === "placed" && r.rows[1].to_status === "kitchen" && r.rows[1].actor_id === V);
ok("the cancellation carries its reason", r.rows?.[2].to_status === "cancelled" && r.rows[2].reason === "Out of stock");
r = await as("authenticated", C, `select id from public.order_status_events where order_id = '${O_FLOW}'`);
ok("the order's customer reads its history", r.rows?.length === 3);
r = await as("authenticated", C2, `select id from public.order_status_events`);
ok("an unrelated customer reads none", r.rows?.length === 0);
r = await as("authenticated", V2, `select id from public.order_status_events where order_id = '${O_FLOW}'`);
ok("another vendor reads none", r.rows?.length === 0);
ok("nobody can forge an event",
  fails(await as("authenticated", V, `insert into public.order_status_events (order_id, restaurant_id, kind, to_status) values ('${O_FLOW}','${R}','status','delivered')`), /permission denied/));
ok("nobody can rewrite history",
  fails(await as("authenticated", A, `delete from public.order_status_events`), /permission denied/));

console.log("\n── Partner app release track ──");
r = await as("service_role", null, `select vendor_apk_version_code, vendor_apk_min_version_code, vendor_apk_url, vendor_apk_notes from public.platform_settings`);
ok("vendor track columns exist with defaults", r.ok && r.rows[0].vendor_apk_version_code === 1 && r.rows[0].vendor_apk_url === "");
ok("minimum above latest is refused",
  fails(await as("service_role", null, `update public.platform_settings set vendor_apk_min_version_code = 5, vendor_apk_version_code = 3`), /platform_settings_vendor_apk_versions/));

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);
r = await as("authenticated", V, `select id from public.vendor_settlements`);
ok("...and the policies still hold after a re-run", JSON.stringify(ids(r)) === JSON.stringify([S_PAID]));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
