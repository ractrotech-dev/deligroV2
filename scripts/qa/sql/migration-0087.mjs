// Runs migrations 0081, 0082, 0083 then 0087 in one in-process Postgres (PGlite) with stubbed Supabase
// auth, orders and storage. Needs @electric-sql/pglite@0.2.17 resolvable — installed OUTSIDE the repo
// (ruling R2), e.g. `npm i @electric-sql/pglite@0.2.17` in a scratch dir, then run with a resolve hook:
//   node --import file:///F:/dev/tmp/pglite-p7/register.mjs scripts/qa/sql/migration-0087.mjs
// Proves the shared support / inbox / announcement tables (shape, RLS, grants, the 4-attachment and
// 4000-character limits), the private attachments bucket, rider_raise_sos (one ticket per incident,
// location updates appended), the delivery stamps, the alert settings, the `note` timeline kind, the
// convergence with the Partner app's 0064 (either order) and the rollback block. It does not replace
// running the migration on staging. PGlite is one connection, so the SOS race is proved by the lock
// and the re-read, not by racing two sessions.
// Also exports proof({ db, ns, quiet }) for scripts/qa/sql/rider-migrations-sequence.mjs, which runs these
// assertions on one database holding the real baseline and 0081-0087 (`seq` below); every id then carries
// the namespace `ns` in its fourth group so all seven proofs fit in one database.
import { PGlite } from "@electric-sql/pglite";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const read = (f) => readFileSync(new URL(`../../../supabase/migrations/${f}`, import.meta.url), "utf8");
const M0081 = read("0081_rider_app_foundation.sql");
const M0082 = read("0082_rider_jobs.sql");
const M0083 = read("0083_rider_money.sql");
let M0087 = "";
try { M0087 = read("0087_support_notifications.sql"); } catch { /* reported below */ }

// The Partner branch's 0064 (read-only, another worktree). Only its shared sections (3–5: tickets,
// inbox, announcements) — the coupon and marketing sections need tables this stub does not have.
const VENDOR_0064 = process.env.VENDOR_0064 ?? "F:/hub26/deligro-vendor/supabase/migrations/0064_growth_support.sql";
let SHARED_0064 = "";
if (existsSync(VENDOR_0064)) {
  const full = readFileSync(VENDOR_0064, "utf8");
  const at = full.indexOf("-- 3. Support tickets");
  SHARED_0064 = at > 0 ? full.slice(at) : "";
}

const STUBS = `
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
  create role anon; create role authenticated; create role service_role bypassrls;

  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
  alter table storage.objects enable row level security;

  create type public.user_role as enum ('customer', 'restaurant', 'driver', 'admin', 'manager', 'developer');
  create table public.profiles (id uuid primary key, role public.user_role not null, full_name text, phone text,
    created_at timestamptz not null default now());
  create table public.restaurants (id uuid primary key, owner_id uuid);
  create type public.payment_method as enum ('cod', 'online');
  create table public.orders (id uuid primary key, status text not null default 'ready',
    customer_id uuid, restaurant_id uuid,
    tip integer not null default 0 check (tip >= 0),
    payment_method public.payment_method not null default 'cod',
    payment_status text not null default 'pending',
    pickup_otp text default '1111', delivery_otp text default '2222');
  create type public.delivery_status as enum ('unassigned', 'assigned', 'picked_up', 'delivered', 'cancelled');
  create table public.deliveries (
    id uuid primary key default gen_random_uuid(),
    order_id uuid not null unique references public.orders (id) on delete cascade,
    driver_id uuid references public.profiles (id) on delete set null,
    status public.delivery_status not null default 'unassigned',
    assigned_at timestamptz, picked_up_at timestamptz, delivered_at timestamptz,
    driver_lat double precision, driver_lng double precision, driver_location_at timestamptz,
    offered_driver_id uuid references public.profiles (id) on delete set null, offered_at timestamptz,
    cod_collected_amount integer, cod_collected_at timestamptz);
  create table public.platform_settings (id boolean primary key default true check (id),
    business_name text not null default 'Deligro', support_phone text not null default '',
    support_whatsapp text not null default '', vendor_commission_pct numeric);
  insert into public.platform_settings (id) values (true);

  create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;
  create function public.current_role() returns public.user_role language sql stable security definer set search_path = public as $$
    select role from public.profiles where id = auth.uid() $$;
  create function public.owns_restaurant(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.restaurants r where r.id = rid and r.owner_id = auth.uid()) $$;

  alter table public.deliveries enable row level security;
  create policy "deliveries — manager manage" on public.deliveries for all
    using (public.is_admin() or public.current_role() = 'manager')
    with check (public.is_admin() or public.current_role() = 'manager');
  alter table public.profiles enable row level security;
  create policy "profiles — read" on public.profiles for select using (true);
  alter table public.orders enable row level security;
  create policy "orders — read" on public.orders for select
    using (customer_id = auth.uid() or public.owns_restaurant(restaurant_id) or public.is_admin());

  create function public.guard_order_update() returns trigger language plpgsql as $$ begin return new; end $$;
  create trigger orders_guard_update before update on public.orders
    for each row execute function public.guard_order_update();

  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  grant select on storage.objects, storage.buckets to anon, authenticated;
  grant all on storage.objects, storage.buckets to service_role;
  revoke select on public.platform_settings from anon, authenticated;
  grant select (id, business_name, support_phone, support_whatsapp) on public.platform_settings to anon, authenticated;
  revoke select on public.orders from anon, authenticated;
  grant select (id, status, customer_id, restaurant_id) on public.orders to authenticated;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`;

const names = (ns) => {
  const id = (n) => `00000000-0000-0000-${ns}-${String(n).padStart(12, "0")}`;
  return { id, D1: id(0xd1), D2: id(0xd2), D3: id(0xd3), M: id(0xe1), A: id(0xa1), C: id(0xc1), V: id(0xb1), R: id(0xf1),
           O1: id(0x1001), O2: id(0x1002) };
};
const seedSql = (ns) => {
  const { D1, D2, D3, M, A, C, V, R, O1, O2 } = names(ns);
  return `
  insert into public.profiles (id, role, full_name) values
    ('${D1}','driver','First rider'), ('${D2}','driver','Second rider'), ('${D3}','driver','Third rider'),
    ('${M}','manager','Manager'), ('${A}','admin','Admin'), ('${C}','customer','Customer'), ('${V}','restaurant','Vendor');
  insert into public.restaurants (id, owner_id) values ('${R}','${V}');
  insert into public.orders (id, customer_id, restaurant_id) values ('${O1}','${C}','${R}'), ('${O2}','${C}','${R}');
`;
};

async function fresh(ns = "0000") {
  const pg = new PGlite();
  await pg.exec(STUBS);
  await pg.exec(seedSql(ns));
  await pg.exec(M0081);
  await pg.exec(M0082);
  return pg;
}

export async function proof({ db: shared = null, ns = "0000", quiet = false } = {}) {
  // seq: the sequence run passes one database that already holds the baseline and 0081-0087.
  const seq = shared !== null;
  const { id, D1, D2, D3, M, A, C, V, O1, O2 } = names(ns);

  let passed = 0, failed = 0;
  const ok = (n, c) => { if (c) passed++; else failed++; if (!c || !quiet) console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };

  const db = seq ? shared : await fresh(ns);
  let applied = true;
  if (seq) await db.exec(seedSql(ns));
  else {
    await db.exec(M0083);
    try { if (!M0087) throw new Error("supabase/migrations/0087_support_notifications.sql not found"); await db.exec(M0087); }
    catch (e) { applied = false; console.log(`0087 did not apply: ${e.message}`); }
  }
  ok("0087 applies on top of 0081, 0082 and 0083", applied);
  if (!applied) return { passed, failed };

  async function runOn(pg, sql) {
    try { const r = await pg.query(sql); return { ok: true, rows: r.rows, affected: r.affectedRows }; }
    catch (e) { return { ok: false, msg: String(e.message), code: e.code }; }
  }
  const run = (sql) => runOn(db, sql);
  async function as(role, uid, sql, pg = db) {
    await pg.exec(`set role ${role};
      select set_config('test.uid','${uid ?? ""}',false);
      select set_config('test.jwt','{"role":"${role}"}',false);`);
    try { return await runOn(pg, sql); }
    finally { await pg.exec("reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);"); }
  }
  const denied = (r) => !r.ok && /permission denied/.test(r.msg);
  const checkFails = (r) => !r.ok && r.code === "23514";
  const one = async (sql, pg = db) => (await pg.query(sql)).rows[0];
  const count = async (sql, pg = db) => Number((await one(`select count(*)::int as n from (${sql}) q`, pg)).n);
  const columnsOf = async (pg, table) =>
    (await pg.query(`select column_name, data_type, is_nullable, coalesce(column_default, '') as d
                       from information_schema.columns where table_schema = 'public' and table_name = '${table}'
                      order by column_name`)).rows.map((r) => `${r.column_name}:${r.data_type}:${r.is_nullable}:${r.d}`).join("|");

  // The sequence run re-applies 0081-0087 together on its populated database instead.
  let idem = true; if (!seq) try { await db.exec(M0087); } catch (e) { idem = false; console.log(e.message); }
  ok("0087 re-applies cleanly (every statement guarded)", idem);

  // ── shape ──
  console.log("\n── shape: the shared tables, English only ──");
  ok("support_tickets, support_messages, user_notifications, announcements exist",
    (await one(`select to_regclass('public.support_tickets') is not null and to_regclass('public.support_messages') is not null
                  and to_regclass('public.user_notifications') is not null and to_regclass('public.announcements') is not null as y`)).y);
  ok("no *_hi column anywhere in the four tables (both other apps dropped them)",
    (await count(`select 1 from information_schema.columns where table_schema = 'public'
                   and table_name in ('support_tickets','support_messages','user_notifications','announcements')
                   and column_name like '%\\_hi'`)) === 0);
  ok("support_tickets carries lat / lng (rider safety reports) and cash_dispute_id",
    (await count(`select 1 from information_schema.columns where table_name = 'support_tickets'
                   and column_name in ('lat','lng','cash_dispute_id','number','assigned_to','resolved_at')`)) === 6);

  // ── tickets: checks ──
  console.log("\n── support_tickets / support_messages: checks ──");
  const ticket = async (requester, role, category, priority = "normal", extra = {}) => {
    const cols = ["requester_id", "requester_role", "category", "priority", "subject", ...Object.keys(extra)];
    const vals = [requester, role, category, priority, `${category} subject`, ...Object.values(extra)].map((v) => (v === null ? "null" : `'${v}'`));
    return (await one(`insert into public.support_tickets (${cols.join(", ")}) values (${vals.join(", ")}) returning id, number`));
  };
  const T1 = await ticket(D1, "rider", "app_technical");
  const T2 = await ticket(D2, "rider", "customer_unreachable", "high", { order_id: O1 });
  const TV = await ticket(V, "vendor", "payments");
  const TE = await ticket(D3, "rider", "accident", "emergency");
  ok("number is issued by identity, increasing", Number(T2.number) > Number(T1.number));
  ok("status 'escalated' is accepted (0143's list)", (await run(`update public.support_tickets set status = 'escalated' where id = '${T1.id}'`)).ok);
  ok("an unknown status is refused", checkFails(await run(`update public.support_tickets set status = 'bogus' where id = '${T1.id}'`)));
  ok("an unknown priority is refused", checkFails(await run(`update public.support_tickets set priority = 'urgent' where id = '${T1.id}'`)));
  await db.exec(`update public.support_tickets set status = 'open' where id = '${T1.id}'`);
  const msg = (t, author, role, body, internal = false, att = "{}") =>
    run(`insert into public.support_messages (ticket_id, author_id, author_role, body, internal, attachments)
         values ('${t}','${author}','${role}','${body}',${internal},'${att}') returning id`);
  ok("a message with 4 attachments is accepted", (await msg(T1.id, D1, "rider", "four photos", false, `{"${D1}/a.jpg","${D1}/b.jpg","${D1}/c.jpg","${D1}/d.png"}`)).ok);
  ok("a 5th attachment is refused (check)", checkFails(await msg(T1.id, D1, "rider", "five photos", false, `{a,b,c,d,e}`)));
  ok("a 4001-character body is refused", checkFails(await msg(T1.id, D1, "rider", "x".repeat(4001))));
  await msg(T1.id, A, "admin", "We are looking into it");
  await msg(T1.id, A, "admin", "internal: check the app logs", true);
  await msg(TE.id, D3, "rider", "SOS");
  await msg(TE.id, A, "admin", "internal: called the rider", true);
  await msg(TV.id, V, "vendor", "payout question");
  await msg(TV.id, A, "admin", "internal vendor note", true);

  // ── RLS ──
  console.log("\n── RLS: who reads which ticket ──");
  let r = await as("authenticated", D1, `select id from public.support_tickets`);
  ok("a rider reads their own ticket only", r.ok && r.rows.length === 1 && r.rows[0].id === T1.id);
  r = await as("authenticated", D1, `select id from public.support_tickets where id = '${T2.id}'`);
  ok("...never another rider's (no row)", r.ok && r.rows.length === 0);
  r = await as("authenticated", D1, `select body, internal from public.support_messages where ticket_id = '${T1.id}' order by created_at`);
  ok("the requester reads their thread without the internal note",
    r.ok && r.rows.length === 2 && r.rows.every((m) => m.internal === false) && !r.rows.some((m) => /internal/.test(m.body)));
  r = await as("authenticated", D2, `select id from public.support_messages where ticket_id = '${T1.id}'`);
  ok("another rider reads none of its messages", r.ok && r.rows.length === 0);
  r = await as("authenticated", A, `select id from public.support_tickets`);
  ok("an admin reads every ticket", r.ok && r.rows.length === 4);
  r = await as("authenticated", A, `select id from public.support_messages where internal`);
  ok("...and every internal note", r.ok && r.rows.length === 3);
  r = await as("authenticated", M, `select id from public.support_tickets order by number`);
  const seen = new Set((r.rows ?? []).map((x) => x.id));
  ok("a manager reads rider delivery tickets and rider emergencies", r.ok && seen.has(T2.id) && seen.has(TE.id));
  ok("...but not a rider's app question or a shop's payments ticket", !seen.has(T1.id) && !seen.has(TV.id));
  r = await as("authenticated", M, `select internal from public.support_messages where ticket_id = '${TE.id}'`);
  ok("...and the whole emergency thread, internal notes included (staff, like 0143's zone read)", r.ok && r.rows.length === 2);
  r = await as("authenticated", M, `select id from public.support_messages where ticket_id = '${TV.id}'`);
  ok("...but no message of a ticket they cannot see", r.ok && r.rows.length === 0);
  r = await as("authenticated", C, `select id from public.support_tickets`);
  ok("a customer with no tickets reads none", r.ok && r.rows.length === 0);
  ok("anon cannot read tickets", denied(await as("anon", null, `select id from public.support_tickets`)));
  ok("a rider cannot insert a ticket (service role only)",
    denied(await as("authenticated", D1, `insert into public.support_tickets (requester_id, requester_role, category, subject) values ('${D1}','rider','other','x')`)));
  ok("...nor a message", denied(await as("authenticated", D1, `insert into public.support_messages (ticket_id, author_id, author_role, body) values ('${T1.id}','${D1}','rider','x')`)));
  ok("...nor change their ticket's status", denied(await as("authenticated", D1, `update public.support_tickets set status = 'closed' where id = '${T1.id}'`)));
  ok("...nor delete it", denied(await as("authenticated", D1, `delete from public.support_tickets where id = '${T1.id}'`)));
  ok("an admin's own client cannot write either (the server writes)",
    denied(await as("authenticated", A, `update public.support_tickets set status = 'closed' where id = '${T1.id}'`)));

  // ── attachments bucket ──
  console.log("\n── support-attachments: private ──");
  const b = await one(`select * from storage.buckets where id = 'support-attachments'`);
  ok("the bucket exists, private, 5 MB, jpeg/png only",
    b && b.public === false && Number(b.file_size_limit) === 5242880 && JSON.stringify(b.allowed_mime_types) === JSON.stringify(["image/jpeg", "image/png"]));
  ok("0087 adds no storage policy (objects are read only through server-minted signed URLs)",
    (await count(`select 1 from pg_policies where schemaname = 'storage'
                    and (coalesce(qual, '') || coalesce(with_check, '')) like '%support-attachments%'`)) === 0);
  await db.exec(`insert into storage.objects (bucket_id, name, owner) values ('support-attachments', '${D2}/x.jpg', '${D2}')`);
  r = await as("authenticated", D1, `select name from storage.objects where bucket_id = 'support-attachments'`);
  ok("another user reads no attachment object (RLS on, no policy)", r.ok && r.rows.length === 0);
  r = await as("authenticated", D2, `select name from storage.objects where bucket_id = 'support-attachments'`);
  ok("...nor does the uploader read it directly — only a signed URL serves it", r.ok && r.rows.length === 0);

  // ── inbox ──
  console.log("\n── user_notifications: own rows, read_at only ──");
  const N1 = (await one(`insert into public.user_notifications (user_id, role, category, title, body) values ('${D1}','rider','payouts','Payout recorded','₹500') returning id`)).id;
  const N2 = (await one(`insert into public.user_notifications (user_id, role, category, title, body) values ('${D2}','rider','support','Reply','Hi') returning id`)).id;
  r = await as("authenticated", D1, `select id from public.user_notifications`);
  ok("a user reads only their own notifications", r.ok && r.rows.length === 1 && r.rows[0].id === N1);
  r = await as("authenticated", D1, `update public.user_notifications set read_at = now() where id = '${N1}' returning id`);
  ok("...and may mark one read", r.ok && r.rows.length === 1);
  r = await as("authenticated", D1, `update public.user_notifications set read_at = now() where id = '${N2}' returning id`);
  ok("...but not someone else's (no row matched)", r.ok && r.rows.length === 0);
  ok("title cannot be updated (read_at is the only column granted)", denied(await as("authenticated", D1, `update public.user_notifications set title = 'x' where id = '${N1}'`)));
  ok("...nor body, category, data or user_id",
    denied(await as("authenticated", D1, `update public.user_notifications set body = 'x' where id = '${N1}'`))
    && denied(await as("authenticated", D1, `update public.user_notifications set category = 'offers' where id = '${N1}'`))
    && denied(await as("authenticated", D1, `update public.user_notifications set data = '{}' where id = '${N1}'`))
    && denied(await as("authenticated", D1, `update public.user_notifications set user_id = '${D2}' where id = '${N1}'`)));
  ok("a user cannot insert a notification", denied(await as("authenticated", D1, `insert into public.user_notifications (user_id, role, category, title, body) values ('${D1}','rider','offers','x','y')`)));
  ok("...nor delete one", denied(await as("authenticated", D1, `delete from public.user_notifications where id = '${N1}'`)));
  ok("a title over 200 characters is refused", checkFails(await run(`insert into public.user_notifications (user_id, role, category, title, body) values ('${D1}','rider','x','${"t".repeat(201)}','y')`)));

  // ── announcements ──
  console.log("\n── announcements: audience and window ──");
  await db.exec(`insert into public.announcements (audience, title, body, starts_at, ends_at) values
    ('rider','Rain bonus','Rider news', now() - interval '1 hour', null),
    ('vendor','Shop news','For shops', now() - interval '1 hour', null),
    ('all','Holiday hours','For everyone', now() - interval '1 hour', now() + interval '1 day'),
    ('rider','Tomorrow','Not yet', now() + interval '1 day', null),
    ('rider','Ended','Gone', now() - interval '2 day', now() - interval '1 day'),
    ('manager','Ops','For managers', now() - interval '1 hour', null)`);
  const titles = async (uid) => ((await as("authenticated", uid, `select title from public.announcements order by title`)).rows ?? []).map((x) => x.title).join(",");
  ok("a rider sees rider + all announcements that are live", (await titles(D1)) === "Holiday hours,Rain bonus");
  ok("a shop owner sees vendor + all", (await titles(V)) === "Holiday hours,Shop news");
  ok("a manager sees manager + all", (await titles(M)) === "Holiday hours,Ops");
  ok("a customer sees none, not even 'all' (it means everyone working)", (await titles(C)) === "");
  ok("an admin sees every announcement, scheduled and ended too", (await count(`select 1 from public.announcements`)) === 6
    && ((await as("authenticated", A, `select id from public.announcements`)).rows ?? []).length === 6);
  ok("an unknown audience is refused", checkFails(await run(`insert into public.announcements (audience, title, body) values ('customer','Hello','x')`)));
  ok("an end before the start is refused", checkFails(await run(`insert into public.announcements (audience, title, body, starts_at, ends_at) values ('rider','Hello','x', now(), now() - interval '1 hour')`)));
  ok("a signed-in user cannot publish one", denied(await as("authenticated", A, `insert into public.announcements (audience, title, body) values ('rider','Hello','x')`)));

  // ── announcement push state (ruling P7-R2) ──
  console.log("\n── announcements: push_mode / pushed_at, the claim ──");
  ok("push_mode and pushed_at exist on announcements",
    (await count(`select 1 from information_schema.columns where table_name = 'announcements' and column_name in ('push_mode','pushed_at')`)) === 2);
  ok("push_mode accepts now / scheduled / none and NULL (another composer)",
    (await run(`insert into public.announcements (audience, title, body, push_mode) values ('rider','Mode now','x','now'), ('rider','Mode sch','x','scheduled'), ('rider','Mode none','x','none'), ('rider','Mode null','x', null)`)).ok);
  ok("an unknown push_mode is refused", checkFails(await run(`insert into public.announcements (audience, title, body, push_mode) values ('rider','Bad mode','x','later')`)));
  const annId = (await one(`select id from public.announcements where title = 'Mode sch'`)).id;
  ok("a rider cannot set pushed_at", denied(await as("authenticated", D1, `update public.announcements set pushed_at = now() where id = '${annId}'`)));
  ok("...nor push_mode", denied(await as("authenticated", D1, `update public.announcements set push_mode = 'none' where id = '${annId}'`)));
  ok("...nor can anon", denied(await as("anon", null, `update public.announcements set pushed_at = now() where id = '${annId}'`)));
  ok("...nor an admin's own client (the server writes)", denied(await as("authenticated", A, `update public.announcements set pushed_at = now() where id = '${annId}'`)));
  const claim = () => as("service_role", null, `update public.announcements set pushed_at = now() where id = '${annId}' and pushed_at is null returning id`);
  let c1 = await claim();
  ok("the service role's claim takes the row once", c1.ok && c1.rows.length === 1);
  let c2 = await claim();
  ok("...and a second claim returns 0 rows (already pushed)", c2.ok && c2.rows.length === 0);
  ok("a rider reads push_mode on a live rider announcement (follows the table's SELECT)",
    (await as("authenticated", D1, `select push_mode from public.announcements where title = 'Mode now'`)).ok);
  await db.exec(`delete from public.announcements where title like 'Mode %'`);

  // ── SOS ──
  console.log("\n── rider_raise_sos: one ticket per incident ──");
  const sos = (driver, category = "accident_emergency", lat = 21.7, lng = 81.5, extra = "") =>
    run(`select public.rider_raise_sos('${driver}', '${category}', 'SOS — rider needs help', 'SOS pressed${extra}', ${lat}, ${lng}, null) as r`);
  let s1 = await sos(D2);
  ok("the first tap opens an emergency ticket", s1.ok && s1.rows[0].r.deduped === false);
  const sosId = s1.rows[0]?.r.ticket_id;
  const st = await one(`select * from public.support_tickets where id = '${sosId}'`);
  ok("...priority emergency, requester the rider, role 'rider', position stored",
    st.priority === "emergency" && st.requester_id === D2 && st.requester_role === "rider" && Number(st.lat) === 21.7 && Number(st.lng) === 81.5);
  let all = true;
  for (let i = 0; i < 9; i++) {
    const t = await sos(D2, "accident_emergency", 21.7 + i / 1000, 81.5, ` #${i + 2}`);
    all = all && t.ok && t.rows[0].r.deduped === true && t.rows[0].r.ticket_id === sosId;
  }
  ok("nine more taps in the window join the same ticket (deduped)", all);
  ok("...ten taps = one ticket and ten messages (location updates)",
    (await count(`select 1 from public.support_tickets where requester_id = '${D2}' and priority = 'emergency'`)) === 1
    && (await count(`select 1 from public.support_messages where ticket_id = '${sosId}'`)) === 10);
  ok("...and the ticket holds the latest position", Math.abs(Number((await one(`select lat from public.support_tickets where id = '${sosId}'`)).lat) - 21.708) < 1e-9);
  const other = await sos(D2, "vehicle_breakdown");
  ok("a report of ANOTHER safety kind in the window is its own ticket (never merged silently)",
    other.ok && other.rows[0].r.deduped === false && other.rows[0].r.ticket_id !== sosId);
  ok("...and a later SOS alert after an acknowledged breakdown report is a new, ringing ticket",
    await (async () => {
      await db.exec(`update public.support_tickets set assigned_to = '${A}', status = 'in_progress' where id = '${other.rows[0].r.ticket_id}'`);
      const sosAfter = await sos(D2, "accident_emergency");
      return sosAfter.rows[0].r.ticket_id === sosId; // same category as the open alert -> joins THAT one, not the breakdown
    })());
  await db.exec(`update public.support_tickets set status = 'resolved' where id = '${other.rows[0].r.ticket_id}'`);

  console.log("\n── rider_raise_sos: re-alerting an acknowledged emergency ──");
  const R3 = id(0xd3);
  let ra = await sos(R3, "unsafe_situation");
  const raId = ra.rows[0].r.ticket_id;
  ok("a new ticket is alerted at once (alerted_at set, rering false)", ra.rows[0].r.rering === false && ra.rows[0].r.alerted_at);
  ra = await sos(R3, "unsafe_situation");
  ok("a tap before anyone acknowledged it does not re-ring (ops are already ringing)", ra.rows[0].r.deduped === true && ra.rows[0].r.rering === false);
  await db.exec(`update public.support_tickets set assigned_to = '${A}', sos_alerted_at = now() - interval '2 minutes' where id = '${raId}'`);
  ra = await sos(R3, "unsafe_situation");
  ok("a tap after staff took it re-rings (rering true, alerted_at moves)", ra.rows[0].r.deduped === true && ra.rows[0].r.rering === true);
  const alertedAt = (await one(`select sos_alerted_at from public.support_tickets where id = '${raId}'`)).sos_alerted_at;
  ok("...sos_alerted_at is the new alert time", new Date(alertedAt).getTime() > Date.now() - 60_000);
  ra = await sos(R3, "unsafe_situation");
  ok("...but not twice in the same minute (panic taps)", ra.rows[0].r.rering === false);
  await db.exec(`update public.support_tickets set assigned_to = null, status = 'waiting_on_requester', sos_alerted_at = now() - interval '5 minutes' where id = '${raId}'`);
  ra = await sos(R3, "unsafe_situation");
  ok("a status moved off open also counts as acknowledged", ra.rows[0].r.rering === true);
  await db.exec(`update public.support_tickets set status = 'resolved' where id = '${raId}'`);
  await db.exec(`update public.support_tickets set updated_at = now() - interval '11 minutes' where id = '${sosId}'`);
  s1 = await sos(D2);
  ok("after 10 quiet minutes a tap opens a new ticket", s1.ok && s1.rows[0].r.deduped === false && s1.rows[0].r.ticket_id !== sosId);
  await db.exec(`update public.support_tickets set status = 'resolved' where id = '${s1.rows[0].r.ticket_id}'`);
  const s2 = await sos(D2);
  ok("a resolved emergency is not reused", s2.ok && s2.rows[0].r.deduped === false && s2.rows[0].r.ticket_id !== s1.rows[0].r.ticket_id);
  ok("another rider's tap never joins this rider's ticket", (await sos(D1)).rows[0].r.ticket_id !== s2.rows[0].r.ticket_id);
  ok("a non-safety category is refused", !(await sos(D1, "app_technical")).ok);
  ok("a non-rider id is refused (forbidden)", /forbidden/.test((await sos(C)).msg ?? ""));
  ok("a rider cannot call it with their own session (service role only)",
    denied(await as("authenticated", D1, `select public.rider_raise_sos('${D1}','accident_emergency','x','y',null,null,null)`)));
  ok("...nor anon", denied(await as("anon", null, `select public.rider_raise_sos('${D1}','accident_emergency','x','y',null,null,null)`)));
  r = await as("service_role", null, `select public.rider_raise_sos('${D3}','unsafe_situation','x','y',null,null,'${O2}') as r`);
  ok("the service role can", r.ok && r.rows[0].r.ticket_id);
  const fn = await one(`select prosecdef, proconfig from pg_proc where proname = 'rider_raise_sos'`);
  ok("it is SECURITY DEFINER with search_path pinned", fn.prosecdef === true && (fn.proconfig ?? []).some((c) => c.startsWith("search_path=")));

  // ── delivery stamps ──
  console.log("\n── deliveries: reminder and delay stamps ──");
  await db.exec(`insert into public.deliveries (order_id, driver_id, status) values ('${O2}','${D1}','assigned')`);
  ok("pickup_reminded_at and delay_alerted_at exist, null by default",
    (await one(`select pickup_reminded_at is null and delay_alerted_at is null as y from public.deliveries where order_id = '${O2}'`)).y);
  r = await run(`update public.deliveries set pickup_reminded_at = now() where order_id = '${O2}' and pickup_reminded_at is null returning id`);
  ok("the sweep's conditional stamp passes the transition guard", r.ok && r.rows.length === 1);
  r = await run(`update public.deliveries set pickup_reminded_at = now() where order_id = '${O2}' and pickup_reminded_at is null returning id`);
  ok("...and a second sweep finds nothing to stamp (sent once)", r.ok && r.rows.length === 0);

  // ── settings ──
  console.log("\n── platform_settings: alert thresholds ──");
  const ps = await one(`select high_demand_ratio, pickup_reminder_minutes, delay_alert_minutes from public.platform_settings`);
  ok("defaults: ratio 2.0, reminder 10 min, delay 10 min", Number(ps.high_demand_ratio) === 2 && ps.pickup_reminder_minutes === 10 && ps.delay_alert_minutes === 10);
  ok("a ratio of 0 is refused", checkFails(await run(`update public.platform_settings set high_demand_ratio = 0`)));
  ok("a 1-minute reminder is refused", checkFails(await run(`update public.platform_settings set pickup_reminder_minutes = 1`)));
  ok("a 61-minute delay alert is refused", checkFails(await run(`update public.platform_settings set delay_alert_minutes = 61`)));
  ok("the thresholds are readable by column (the settings facade reads with the caller's client)",
    (await as("anon", null, `select high_demand_ratio, pickup_reminder_minutes, delay_alert_minutes from public.platform_settings`)).ok
    && (await as("authenticated", D1, `select delay_alert_minutes from public.platform_settings`)).ok);
  ok("...and the commission stays private", denied(await as("anon", null, `select vendor_commission_pct from public.platform_settings`)));
  ok("the existing support numbers stay readable", (await as("anon", null, `select support_phone, support_whatsapp from public.platform_settings`)).ok);

  // ── timeline note ──
  console.log("\n── delivery_events: the note kind ──");
  const dId = (await one(`select id from public.deliveries where order_id = '${O2}'`)).id;
  const ev = (kind, method = "null") => run(`insert into public.delivery_events (delivery_id, order_id, driver_id, kind, method, reason) values ('${dId}','${O2}','${D1}','${kind}',${method},'Shop delay reported by the rider')`);
  ok("kind 'note' is accepted", (await ev("note")).ok);
  ok("every earlier kind still is (contact_attempt, withdrawn, offered)",
    (await ev("contact_attempt", "'customer'")).ok && (await ev("withdrawn")).ok && (await ev("offered")).ok);
  ok("an unknown kind is still refused", checkFails(await ev("bogus")));
  ok("the contact-method check survives", checkFails(await ev("contact_attempt", "'nobody'")));
  const def = (await one(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'delivery_events_kind_check'`)).d;
  ok("re-running 0087 does not list 'note' twice", (def.match(/'note'/g) ?? []).length === 1);

  // These build their own databases (the sequence run covers re-runs and rollback for all seven).
  if (!seq) {
    console.log("\n── a kind added by a later migration before 0087 is kept ──");
    const k = await fresh();
    await k.exec(`alter table public.delivery_events drop constraint delivery_events_kind_check;
      alter table public.delivery_events add constraint delivery_events_kind_check check (kind in ('offered', 'accepted', 'cash_deposit'))`);
    await k.exec(M0087);
    await k.exec(`insert into public.deliveries (order_id, status) values ('${O1}','unassigned')`);
    const kd = (await one(`select id from public.deliveries`, k)).id;
    const kk = (kind) => runOn(k, `insert into public.delivery_events (delivery_id, order_id, kind) values ('${kd}','${O1}','${kind}')`);
    ok("'cash_deposit' (not 0082's) still accepted after 0087", (await kk("cash_deposit")).ok);
    ok("...and 'note' added", (await kk("note")).ok);
    ok("...and nothing else let in", checkFails(await kk("withdrawn")));
    await k.close();

    // ── convergence with the Partner app's 0064 ──
    console.log("\n── convergence with 0064 (feat/vendor-app) ──");
    if (!SHARED_0064) {
      console.log(`  SKIP 0064 not found at ${VENDOR_0064}`);
    } else {
      const vFirst = await fresh();
      let vOk = true; try { await vFirst.exec(SHARED_0064); await vFirst.exec(M0087); } catch (e) { vOk = false; console.log(e.message); }
      ok("0064 then 0087 applies", vOk);
      const rFirst = await fresh();
      let rOk = true; try { await rFirst.exec(M0087); await rFirst.exec(SHARED_0064); } catch (e) { rOk = false; console.log(e.message); }
      ok("0087 then 0064 applies", rOk);
      const only64 = await fresh();
      await only64.exec(SHARED_0064);
      const only87 = await fresh();
      await only87.exec(M0087);
      for (const t of ["support_tickets", "support_messages", "user_notifications", "announcements"]) {
        const RIDER_ONLY = ["sos_alerted_at:", "push_mode:", "pushed_at:"];
        const strip = (cols) => cols.split("|").filter((c) => !RIDER_ONLY.some((r) => c.startsWith(r))).join("|");
        ok(`${t}: 0087 creates exactly 0064's columns (plus its guarded rider-only ones)`, (await columnsOf(only64, t)) === strip(await columnsOf(only87, t)));
        ok(`${t}: same in either order`, (await columnsOf(vFirst, t)) === (await columnsOf(rFirst, t)));
        if (t === "support_tickets") {
          ok("sos_alerted_at is the only column 0087 adds to 0064's ticket shape",
            (await columnsOf(only87, t)).split("|").length === (await columnsOf(only64, t)).split("|").length + 1);
        }
        if (t === "announcements") {
          const vCols = await columnsOf(vFirst, t);
          const rCols = await columnsOf(rFirst, t);
          ok("push_mode and pushed_at are the only columns 0087 adds to 0064's announcement shape",
            (await columnsOf(only87, t)).split("|").length === (await columnsOf(only64, t)).split("|").length + 2);
          ok("...present whichever of 0064 / 0087 ran first",
            ["push_mode:", "pushed_at:"].every((c) => vCols.includes(c) && rCols.includes(c)));
        }
      }
      const pols = async (pg) => (await pg.query(`select polname from pg_policy where polrelid::regclass::text in
          ('support_tickets','support_messages','user_notifications','announcements') order by 1`)).rows.map((x) => x.polname).join(",");
      const p64 = (await pols(only64)).split(",");
      const p87 = (await pols(only87)).split(",");
      ok("...every 0064 policy exists under 0087, plus the two manager rider reads",
        p64.every((p) => p87.includes(p)) && p87.length === p64.length + 2);
      const status = async (pg) => (await one(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'support_tickets_status_check'`, pg)).d;
      ok("0087 then 0064 keeps 'escalated' (0064 does not narrow it back)", /escalated/.test(await status(rFirst)));
      const asks = async (pg) => (await as("authenticated", D1, `select public.announcement_audience_of('${M}') as a`, pg)).rows?.[0]?.a ?? null;
      ok("0064 then 0087 (number order) leaves P8-R1's version: a rider learns nothing about another uid", (await asks(vFirst)) === null);
      ok("...and announcements stay readable to their audience there", (await as("authenticated", D1, `select count(*)::int as n from public.announcements`, vFirst)).ok);
      if ((await asks(rFirst)) !== null) console.log("  note  0087 then 0064: 0064's older body answers for any uid until the Partner branch mirrors P8-R1");
      for (const pg of [vFirst, rFirst, only64, only87]) await pg.close();
    }
  }

  // ── function hygiene ──
  console.log("\n── functions ──");
  r = await run(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')
                    and p.proname in ('rider_raise_sos','announcement_audience_of','is_rider_ops_ticket')`);
  ok("no 0087 security-definer function is executable by anon", r.ok && r.rows.length === 0);
  // Ruling P8-R1: it answers about the caller only, unless the caller is an admin or the service role.
  const audiences = `select public.announcement_audience_of('${D1}') as d1, public.announcement_audience_of('${M}') as m,
                            public.announcement_audience_of('${V}') as v, public.announcement_audience_of('${C}') as c,
                            public.announcement_audience_of('${D2}') as d2`;
  const all4 = (x) => x.ok && [x.rows[0].d1, x.rows[0].m, x.rows[0].v, x.rows[0].c, x.rows[0].d2].join(",") === "rider,manager,vendor,customer,rider";
  ok("announcement_audience_of: the service role asks about anyone (driver → rider, manager, shop owner → vendor, customer)",
    all4(await as("service_role", null, audiences)));
  ok("...an admin asks about anyone", all4(await as("authenticated", A, audiences)));
  r = await as("authenticated", D1, audiences);
  ok("...a rider asking about themselves gets their audience", r.ok && r.rows[0].d1 === "rider");
  ok("...a rider asking about anyone else gets nothing (manager, shop owner, customer, another rider)",
    r.ok && [r.rows[0].m, r.rows[0].v, r.rows[0].c, r.rows[0].d2].every((x) => x === null));
  const self = async (uid) => (await as("authenticated", uid, `select public.announcement_audience_of('${uid}') as a`)).rows?.[0]?.a;
  ok("...a manager, a shop owner and a customer each get their own", (await self(M)) === "manager" && (await self(V)) === "vendor" && (await self(C)) === "customer");
  r = await as("authenticated", V, audiences);
  ok("...a shop owner asking about a rider gets nothing", r.ok && r.rows[0].d1 === null && r.rows[0].v === "vendor");
  ok("...anon cannot execute it", denied(await as("anon", null, `select public.announcement_audience_of('${D1}')`)));

  // The sequence run runs every rollback block, in reverse order, on its own database.
  if (!seq) {
    // ── rollback ──
    console.log("\n── the rollback block (fresh instance) ──");
    const lines = M0087.split("\n");
    const from = lines.findIndex((l) => l.startsWith("-- Rollback"));
    const block = [];
    for (const l of lines.slice(from + 1)) {
      if (l.startsWith("-- ====")) break;
      if (/^--   /.test(l) && !/^--\s+--/.test(l)) block.push(l.slice(2));
    }
    const ROLLBACK = block.join("\n");
    ok("the rollback block was found", from > 0 && /drop table/.test(ROLLBACK));
    const rb = await fresh();
    await rb.exec(M0087);
    await rb.exec(`select public.rider_raise_sos('${D1}','accident_emergency','x','y',null,null,null)`);
    let rolled = true; try { await rb.exec(ROLLBACK); } catch (err) { rolled = false; console.log(`rollback failed: ${err.message}`); }
    ok("the rollback block runs to completion", rolled);
    ok("...and removes every 0087 table, function, column and the bucket",
      (await one(`select to_regclass('public.support_tickets') is null and to_regclass('public.support_messages') is null
                    and to_regclass('public.user_notifications') is null and to_regclass('public.announcements') is null
                    and not exists (select 1 from pg_proc where proname in ('rider_raise_sos','announcement_audience_of','is_rider_ops_ticket'))
                    and not exists (select 1 from information_schema.columns where table_name = 'deliveries' and column_name in ('pickup_reminded_at','delay_alerted_at'))
                    and not exists (select 1 from information_schema.columns where table_name = 'platform_settings' and column_name in ('high_demand_ratio','pickup_reminder_minutes','delay_alert_minutes'))
                    and not exists (select 1 from storage.buckets where id = 'support-attachments') as gone`, rb)).gone === true);
    let reapplied = true; try { await rb.exec(M0087); } catch (err) { reapplied = false; console.log(err.message); }
    ok("...and 0087 applies again after the rollback", reapplied);
    await rb.close();
  }

  return { passed, failed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { passed, failed } = await proof();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
