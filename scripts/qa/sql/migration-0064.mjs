// Runs migration 0064 in an in-process Postgres (PGlite) with stubbed Supabase auth helpers.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0064.mjs
// Proves coupon start dates, marketing requests, tickets, the inbox and announcements are
// readable by the right people only and writable by no client; it does not replace staging.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/0064_growth_support.sql", import.meta.url), "utf8");
const db = new PGlite();

// The schema as 0064 finds it (0001, 0031, 0041 in substance).
await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
  create role anon; create role authenticated; create role service_role bypassrls;
  create table public.profiles (id uuid primary key, role text not null);
  create table public.restaurants (id uuid primary key, owner_id uuid, offer text, offer_expires_at timestamptz);
  create table public.orders (id uuid primary key default gen_random_uuid(), customer_id uuid, restaurant_id uuid);
  create table public.coupons (code text primary key, kind text not null, value numeric(10,2) not null,
    min_order numeric(10,2) not null default 0, max_discount numeric(10,2), active boolean not null default true,
    expires_at timestamptz, created_at timestamptz not null default now(), max_per_customer integer, max_redemptions integer,
    restaurant_id uuid references public.restaurants, funded_by text not null default 'platform', label text, created_by uuid);
  create table public.coupon_redemptions (id uuid primary key default gen_random_uuid(), code text not null, order_id uuid,
    customer_id uuid, discount integer not null default 0, created_at timestamptz not null default now());
  create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;
  create function public.owns_restaurant(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.restaurants r where r.id = rid and r.owner_id = auth.uid()) $$;
  create function public.promo_amount_text(n numeric) returns text language sql immutable as $$
    select case when n = trunc(n) then trunc(n)::text else n::text end $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`);

const ADMIN = "00000000-0000-0000-0000-0000000000ad", V = "00000000-0000-0000-0000-0000000000a1", V2 = "00000000-0000-0000-0000-0000000000a2";
const C = "00000000-0000-0000-0000-0000000000c1", RIDER = "00000000-0000-0000-0000-0000000000d1", MGR = "00000000-0000-0000-0000-0000000000e1";
const OWNER_CUSTOMER = "00000000-0000-0000-0000-0000000000c2";
const R = "00000000-0000-0000-0000-0000000000f1", R2 = "00000000-0000-0000-0000-0000000000f2", R3 = "00000000-0000-0000-0000-0000000000f3";
await db.exec(`
  insert into public.profiles values ('${ADMIN}','admin'),('${V}','restaurant'),('${V2}','restaurant'),('${C}','customer'),
    ('${RIDER}','driver'),('${MGR}','manager'),('${OWNER_CUSTOMER}','customer');
  insert into public.restaurants (id, owner_id) values ('${R}','${V}'),('${R2}','${V2}'),('${R3}','${OWNER_CUSTOMER}');
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
const count = (r) => (r.ok ? r.rows.length : -1);

await db.exec(MIGRATION);

console.log("\n── coupons that start later ──");
await db.exec(`insert into public.coupons (code, kind, value, restaurant_id, funded_by, starts_at, expires_at) values
  ('SOON', 'flat', 50, '${R}', 'vendor', now() + interval '2 days', now() + interval '9 days'),
  ('NOW', 'percent', 10, '${R2}', 'vendor', now() - interval '1 hour', null)`);
const price = async (code, rid) => (await db.query(`select public.price_coupon(c, 500, '${rid}', null) as p from public.coupons c where code = '${code}'`)).rows[0].p;
ok("a code is refused before it starts", (await price("SOON", R)).error === "not_started");
ok("a started code prices", (await price("NOW", R2)).discount === 50);
let bad = null; try { await db.query(`insert into public.coupons (code, kind, value, starts_at, expires_at) values ('X','flat',1, now(), now() - interval '1 day')`); } catch (e) { bad = e.message; }
ok("a code can't end before it starts", /coupons_window/.test(bad ?? ""));
await db.query(`select public.refresh_restaurant_offer('${R}')`);
ok("the shop badge ignores a code that hasn't started", (await db.query(`select offer from public.restaurants where id = '${R}'`)).rows[0].offer === null);
await db.exec(`update public.coupons set starts_at = now() - interval '5 minutes' where code = 'SOON'`);
ok("refresh_due_offers finds the shop once it starts", (await db.query(`select public.refresh_due_offers() as n`)).rows[0].n >= 1);
ok("…and the badge goes up", (await db.query(`select offer from public.restaurants where id = '${R}'`)).rows[0].offer === "₹50 OFF");
ok("clients can't call refresh_due_offers", fails(await as("authenticated", V, `select public.refresh_due_offers()`), /permission denied/));

console.log("\n── marketing requests ──");
await db.exec(`insert into public.marketing_requests (id, restaurant_id, requested_by, kind, title, details) values
  ('00000000-0000-0000-0000-00000000b001','${R}','${V}','banner','Diwali banner','Home banner for a week');
  insert into public.marketing_request_updates (request_id, status, actor_id, actor_role) values ('00000000-0000-0000-0000-00000000b001','pending','${V}','vendor');`);
ok("the owner reads their request", count(await as("authenticated", V, `select id from public.marketing_requests`)) === 1);
ok("…and its timeline", count(await as("authenticated", V, `select id from public.marketing_request_updates`)) === 1);
ok("another vendor reads nothing", count(await as("authenticated", V2, `select id from public.marketing_requests`)) === 0);
ok("admins read it", count(await as("authenticated", ADMIN, `select id from public.marketing_requests`)) === 1);
ok("a vendor can't insert directly", fails(await as("authenticated", V, `insert into public.marketing_requests (restaurant_id, requested_by, kind, title, details) values ('${R}','${V}','banner','Hello','x')`), /permission denied/));
ok("…nor approve their own", fails(await as("authenticated", V, `update public.marketing_requests set status = 'approved'`), /permission denied/));
let k = null; try { await db.query(`insert into public.marketing_requests (restaurant_id, requested_by, kind, title, details) values ('${R}','${V}','spam','Hello','x')`); } catch (e) { k = e.message; }
ok("an unknown kind is refused", /check/.test(k ?? ""));

console.log("\n── support tickets ──");
await db.exec(`insert into public.support_tickets (id, requester_id, requester_role, category, subject) values
  ('00000000-0000-0000-0000-00000000c001','${V}','vendor','payments','Payout missing');
  insert into public.support_messages (ticket_id, author_id, author_role, body, internal) values
  ('00000000-0000-0000-0000-00000000c001','${V}','vendor','Last week not paid', false),
  ('00000000-0000-0000-0000-00000000c001','${ADMIN}','admin','Check bank details first', true),
  ('00000000-0000-0000-0000-00000000c001','${ADMIN}','admin','Looking into it', false);`);
ok("the requester reads their ticket", count(await as("authenticated", V, `select id from public.support_tickets`)) === 1);
ok("…and only the non-internal messages", count(await as("authenticated", V, `select id from public.support_messages`)) === 2);
ok("someone else reads nothing", count(await as("authenticated", V2, `select id from public.support_messages`)) === 0);
ok("admins read the internal note too", count(await as("authenticated", ADMIN, `select id from public.support_messages`)) === 3);
ok("no client writes tickets", fails(await as("authenticated", V, `insert into public.support_tickets (requester_id, requester_role, category, subject) values ('${V}','vendor','x','y')`), /permission denied/));
ok("no client writes messages", fails(await as("authenticated", V, `insert into public.support_messages (ticket_id, author_id, author_role, body) values ('00000000-0000-0000-0000-00000000c001','${V}','vendor','z')`), /permission denied/));
let st = null; try { await db.query(`update public.support_tickets set status = 'lost'`); } catch (e) { st = e.message; }
ok("an unknown status is refused", /check/.test(st ?? ""));

console.log("\n── notification inbox ──");
await db.exec(`insert into public.user_notifications (id, user_id, role, category, title, body) values
  ('00000000-0000-0000-0000-00000000d001','${V}','vendor','orders','New order','#A1B2'),
  ('00000000-0000-0000-0000-00000000d002','${V2}','vendor','orders','New order','#C3D4')`);
ok("a user reads their own notifications only", count(await as("authenticated", V, `select id from public.user_notifications`)) === 1);
ok("they can mark one read", (await as("authenticated", V, `update public.user_notifications set read_at = now() where id = '00000000-0000-0000-0000-00000000d001' returning id`)).rows?.length === 1);
ok("…but not rewrite it", fails(await as("authenticated", V, `update public.user_notifications set title = 'x' where id = '00000000-0000-0000-0000-00000000d001'`), /permission denied/));
ok("…nor touch someone else's", (await as("authenticated", V, `update public.user_notifications set read_at = now() where id = '00000000-0000-0000-0000-00000000d002' returning id`)).rows?.length === 0);
ok("clients can't insert notifications", fails(await as("authenticated", V, `insert into public.user_notifications (user_id, role, category, title, body) values ('${V}','vendor','x','y','z')`), /permission denied/));

console.log("\n── announcements ──");
await db.exec(`insert into public.announcements (audience, title, body, starts_at, ends_at) values
  ('vendor', 'For shops', 'b', now() - interval '1 hour', null),
  ('rider', 'For riders', 'b', now() - interval '1 hour', null),
  ('all', 'For everyone working', 'b', now() - interval '1 hour', null),
  ('vendor', 'Tomorrow', 'b', now() + interval '1 day', null),
  ('vendor', 'Over', 'b', now() - interval '2 days', now() - interval '1 day')`);
const titles = async (uid) => ((await as("authenticated", uid, `select title from public.announcements order by title`)).rows ?? []).map((r) => r.title);
ok("a vendor sees vendor + all, live only", JSON.stringify(await titles(V)) === JSON.stringify(["For everyone working", "For shops"]));
ok("a customer who owns a shop counts as a vendor", (await titles(OWNER_CUSTOMER)).includes("For shops"));
ok("a rider sees rider + all", JSON.stringify(await titles(RIDER)) === JSON.stringify(["For everyone working", "For riders"]));
ok("a manager sees only 'all' here", JSON.stringify(await titles(MGR)) === JSON.stringify(["For everyone working"]));
ok("a plain customer sees none", (await titles(C)).length === 0);
ok("anon sees none", fails(await as("anon", null, `select title from public.announcements`), /permission denied/));
ok("no client writes announcements", fails(await as("authenticated", V, `insert into public.announcements (audience, title, body) values ('vendor','Hello','x')`), /permission denied/));

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
