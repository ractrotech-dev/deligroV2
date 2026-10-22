// Runs migrations 0047, 0081, 0082, 0083 then 0085 in one in-process Postgres (PGlite) with stubbed Supabase
// auth, orders and storage. Needs: npm i --no-save @electric-sql/pglite@0.2.17
// Usage: node scripts/qa/sql/migration-0085.mjs
// Optional: M0150=<path to the Manager branch's 0150_rider_tables_converge.sql> (default: the sibling
// worktree F:\hub26\deligro-manager) to prove 0085's cash tables are IDENTICAL to 0150's "Rider 0085" section,
// in both orders of arrival. It does not replace running the migration on staging.
import { PGlite } from "@electric-sql/pglite";
import { existsSync, readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../../../supabase/migrations/${f}`, import.meta.url), "utf8");
const M0047 = read("0047_cod_handovers_and_expenses.sql");
const M0081 = read("0081_rider_app_foundation.sql");
const M0082 = read("0082_rider_jobs.sql");
const M0083 = read("0083_rider_money.sql");
let M0085 = "";
try { M0085 = read("0085_rider_cash.sql"); } catch { /* reported below */ }
const P0150 = process.env.M0150 ?? "F:/hub26/deligro-manager/supabase/migrations/0150_rider_tables_converge.sql";
const M0150 = existsSync(P0150) ? readFileSync(P0150, "utf8") : "";

const STUBS = `
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
  create role anon; create role authenticated; create role service_role bypassrls;

  -- Supabase default: every table, sequence and function created later in public
  -- is granted to the API roles. The migrations have to take that back themselves.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]);

  create table public.profiles (id uuid primary key, role text not null, full_name text,
    created_at timestamptz not null default now());
  create table public.restaurants (id uuid primary key, owner_id uuid);
  -- 0013: tip is whole rupees; 0025: payment_method enum, not null, default cod.
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
    business_name text not null default 'Deligro', vendor_commission_pct numeric);
  insert into public.platform_settings (id) values (true);

  create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;
  create function public.current_role() returns text language sql stable security definer set search_path = public as $$
    select role from public.profiles where id = auth.uid() $$;
  create function public.owns_restaurant(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.restaurants r where r.id = rid and r.owner_id = auth.uid()) $$;

  alter table public.deliveries enable row level security;
  create policy "deliveries — manager manage" on public.deliveries for all
    using (public.is_admin() or public.current_role() = 'manager')
    with check (public.is_admin() or public.current_role() = 'manager');
  alter table public.profiles enable row level security;
  create policy "profiles — read" on public.profiles for select using (true);
  -- The earnings trigger reads orders as its owner, so the order's RLS must not hide the tip.
  alter table public.orders enable row level security;
  create policy "orders — read" on public.orders for select
    using (customer_id = auth.uid() or public.owns_restaurant(restaurant_id) or public.is_admin());

  create function public.guard_order_update() returns trigger language plpgsql as $$ begin return new; end $$;
  create trigger orders_guard_update before update on public.orders
    for each row execute function public.guard_order_update();

  grant usage on schema public, auth to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  revoke select on public.platform_settings from anon, authenticated;
  grant select (id, business_name) on public.platform_settings to anon, authenticated;
  revoke select on public.orders from anon, authenticated;
  grant select (id, status, customer_id, restaurant_id) on public.orders to authenticated;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`;

async function fresh({ upTo0085 = true } = {}) {
  const d = new PGlite();
  await d.exec(STUBS);
  await d.exec(`
    insert into public.profiles (id, role, full_name, created_at) values
      ('${D1}','driver','First rider','2025-01-02'), ('${D2}','driver','Second rider','2025-01-03'),
      ('${M}','manager','Manager','2025-01-06'), ('${A}','admin','Admin','2025-01-07'),
      ('${C}','customer','Customer','2025-01-08'), ('${V}','vendor','Vendor','2025-01-09');
    insert into public.restaurants (id, owner_id) values ('${R}','${V}');`);
  await d.exec(M0047);
  await d.exec(M0081);
  await d.exec(M0082);
  await d.exec(M0083);
  if (upTo0085 && M0085) await d.exec(M0085);
  return d;
}

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const D1 = id(0xd1), D2 = id(0xd2), M = id(0xe1), A = id(0xa1), C = id(0xc1), V = id(0xb1), R = id(0xf1);

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };
if (!M0085) { console.log("supabase/migrations/0085_rider_cash.sql not found"); process.exit(1); }

let db;
try { db = await fresh(); } catch (e) { console.log(`0085 did not apply: ${e.message}`); process.exit(1); }
ok("0085 applies on top of 0047, 0081, 0082 and 0083", true);

async function run(d, sql) {
  try { const r = await d.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: String(e.message), code: e.code, detail: e.detail }; }
}
async function as(d, role, uid, sql) {
  await d.exec(`set role ${role};
    select set_config('test.uid','${uid ?? ""}',false);
    select set_config('test.jwt','{"role":"${role}"}',false);`);
  try { return await run(d, sql); }
  finally { await d.exec("reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);"); }
}
const denied = (r) => !r.ok && /permission denied/.test(r.msg);
const checkFails = (r, name) => !r.ok && r.code === "23514" && (!name || new RegExp(name).test(r.msg));
const one = async (d, sql) => (await d.query(sql)).rows[0];
const count = async (d, sql) => Number((await one(d, `select count(*)::int as n from (${sql}) q`)).n);

// ── the thresholds ──
console.log("\n── platform_settings: the thresholds ──");
let s = await one(db, `select rider_cash_limit, rider_cash_max_hours from public.platform_settings`);
ok("rider_cash_limit defaults to 5000 and rider_cash_max_hours to 24", s.rider_cash_limit === 5000 && s.rider_cash_max_hours === 24);
ok("a negative limit is refused", checkFails(await run(db, `update public.platform_settings set rider_cash_limit = -1`)));
ok("a limit above 100000 is refused", checkFails(await run(db, `update public.platform_settings set rider_cash_limit = 100001`)));
ok("negative hours are refused", checkFails(await run(db, `update public.platform_settings set rider_cash_max_hours = -1`)));
ok("hours above 720 are refused", checkFails(await run(db, `update public.platform_settings set rider_cash_max_hours = 721`)));
ok("0 (off) and the maximum are accepted",
  (await run(db, `update public.platform_settings set rider_cash_limit = 0, rider_cash_max_hours = 0`)).ok
  && (await run(db, `update public.platform_settings set rider_cash_limit = 100000, rider_cash_max_hours = 720`)).ok);
await db.exec(`update public.platform_settings set rider_cash_limit = 5000, rider_cash_max_hours = 24`);
ok("a rider can read the thresholds (the settings facade reads with the user's client)",
  (await as(db, "authenticated", D1, `select rider_cash_limit, rider_cash_max_hours from public.platform_settings`)).ok);
ok("anon can read them too (same column grant as the rate card)",
  (await as(db, "anon", null, `select rider_cash_limit from public.platform_settings`)).ok);
ok("vendor_commission_pct stays private", denied(await as(db, "anon", null, `select vendor_commission_pct from public.platform_settings`)));
// Who may WRITE platform_settings is 0015's admin-only policy; the stub has no RLS on it, so it is not re-proved here.

// ── the deposit's own rules ──
console.log("\n── cash_deposits ──");
let r = await run(db, `insert into public.cash_deposits (driver_id, amount, method) values ('${D1}', 500, 'cash') returning id`);
ok("a deposit starts 'submitted' with no handover", r.ok && (await one(db, `select status, handover_id from public.cash_deposits where id = '${r.rows[0].id}'`)).status === "submitted");
const SUBMITTED = r.rows[0].id;
ok("amount 0 is refused", checkFails(await run(db, `insert into public.cash_deposits (driver_id, amount, method) values ('${D1}', 0, 'cash')`)));
ok("a negative amount is refused", checkFails(await run(db, `insert into public.cash_deposits (driver_id, amount, method) values ('${D1}', -5, 'cash')`)));
ok("a fractional amount cannot be stored (whole rupees)",
  Number((await run(db, `insert into public.cash_deposits (driver_id, amount, method) values ('${D1}', 5.5, 'cash') returning amount`)).rows?.[0]?.amount ?? 0) !== 5.5);
ok("a method other than cash/upi is refused", checkFails(await run(db, `insert into public.cash_deposits (driver_id, amount, method) values ('${D1}', 5, 'cheque')`)));
ok("a status outside the four is refused", checkFails(await run(db, `insert into public.cash_deposits (driver_id, amount, method, status) values ('${D1}', 5, 'cash', 'done')`)));
ok("a confirmed deposit without a handover raises",
  checkFails(await run(db, `update public.cash_deposits set status = 'confirmed' where id = '${SUBMITTED}'`), "cash_deposits_confirmed_handover"));
ok("a confirmed row cannot be inserted without a handover either",
  checkFails(await run(db, `insert into public.cash_deposits (driver_id, amount, method, status) values ('${D1}', 5, 'cash', 'confirmed')`), "cash_deposits_confirmed_handover"));
ok("a disputed deposit without a note raises",
  checkFails(await run(db, `update public.cash_deposits set status = 'disputed' where id = '${SUBMITTED}'`), "cash_deposits_disputed_note"));
ok("...an insert of a disputed row with no note raises too",
  checkFails(await run(db, `insert into public.cash_deposits (driver_id, amount, method, status) values ('${D1}', 5, 'cash', 'disputed')`), "cash_deposits_disputed_note"));
ok("a disputed deposit with a note is accepted",
  (await run(db, `update public.cash_deposits set status = 'disputed', decision_note = 'Short by 100', decided_by = '${M}', decided_at = now() where id = '${SUBMITTED}'`)).ok);
ok("a withdrawn deposit needs neither", (await run(db, `insert into public.cash_deposits (driver_id, amount, method, status) values ('${D1}', 5, 'upi', 'withdrawn')`)).ok);

const HO = (await one(db, `insert into public.cod_handovers (leg, from_user, to_user, amount, recorded_by)
  values ('rider_to_manager', '${D1}', '${M}', 500, '${M}') returning id`)).id;
const CONF = (await one(db, `insert into public.cash_deposits (driver_id, amount, method, status, handover_id, decided_by, decided_at)
  values ('${D1}', 500, 'cash', 'confirmed', '${HO}', '${M}', now()) returning id`)).id;
ok("a confirmed deposit with its handover is accepted", !!CONF);
ok("a handover linked to a confirmed deposit cannot be deleted (set null would orphan the confirmation)",
  checkFails(await run(db, `delete from public.cod_handovers where id = '${HO}'`)));
ok("the UPI reference is the server's rule; the table stores it as text",
  (await run(db, `insert into public.cash_deposits (driver_id, amount, method, reference) values ('${D1}', 5, 'upi', 'UTR123')`)).ok);

// ── disputes and reminders ──
console.log("\n── cash_disputes and cash_reminders ──");
r = await run(db, `insert into public.cash_disputes (driver_id, day, claimed_amount, message) values ('${D1}', '2025-02-01', 700, 'I collected 700, the app says 600') returning id, status`);
ok("a dispute starts 'open'", r.ok && r.rows[0].status === "open");
const DISP = r.rows[0].id;
ok("a dispute needs a message", !(await run(db, `insert into public.cash_disputes (driver_id, day) values ('${D1}', '2025-02-01')`)).ok);
ok("a dispute status outside open/resolved is refused", checkFails(await run(db, `insert into public.cash_disputes (driver_id, day, message, status) values ('${D1}', '2025-02-01', 'x', 'closed')`)));
ok("claimed_amount is optional", (await run(db, `insert into public.cash_disputes (driver_id, day, message) values ('${D1}', '2025-02-02', 'wrong day')`)).ok);
ok("a reminder row is one per rider", (await run(db, `insert into public.cash_reminders (driver_id, last_sent_at) values ('${D1}', now())`)).ok
  && !(await run(db, `insert into public.cash_reminders (driver_id, last_sent_at) values ('${D1}', now())`)).ok);

// ── RLS and privileges ──
console.log("\n── RLS and privileges ──");
await db.exec(`insert into public.cash_deposits (driver_id, amount, method) values ('${D2}', 250, 'cash');
               insert into public.cash_disputes (driver_id, day, message) values ('${D2}', '2025-02-01', 'other rider');`);
const own = await as(db, "authenticated", D1, `select id, driver_id from public.cash_deposits`);
ok("a rider reads their own deposits", own.ok && own.rows.length > 0 && own.rows.every((x) => x.driver_id === D1));
ok("a rider cannot read another rider's deposits", (await as(db, "authenticated", D1, `select id from public.cash_deposits where driver_id = '${D2}'`)).rows.length === 0);
ok("a rider reads their own disputes and not another's",
  (await as(db, "authenticated", D1, `select driver_id from public.cash_disputes`)).rows.every((x) => x.driver_id === D1)
  && (await as(db, "authenticated", D1, `select id from public.cash_disputes where driver_id = '${D2}'`)).rows.length === 0);
ok("an admin reads every deposit and dispute",
  (await as(db, "authenticated", A, `select id from public.cash_deposits`)).rows.length === (await count(db, `select 1 from public.cash_deposits`))
  && (await as(db, "authenticated", A, `select id from public.cash_disputes`)).rows.length === (await count(db, `select 1 from public.cash_disputes`)));
ok("a manager's own session reads none (the server reads for them, behind requireRole; the zone policy is 0151's)",
  (await as(db, "authenticated", M, `select id from public.cash_deposits`)).rows.length === 0);
ok("a customer reads none", (await as(db, "authenticated", C, `select id from public.cash_deposits`)).rows.length === 0);
ok("anon cannot read deposits or disputes",
  denied(await as(db, "anon", null, `select id from public.cash_deposits`)) && denied(await as(db, "anon", null, `select id from public.cash_disputes`)));
ok("cash_reminders is not readable by anyone signed in",
  denied(await as(db, "authenticated", D1, `select driver_id from public.cash_reminders`)) && denied(await as(db, "authenticated", A, `select driver_id from public.cash_reminders`)));
for (const [who, uid] of [["a rider", D1], ["an admin", A], ["a manager", M]]) {
  ok(`${who} cannot insert, update or delete a deposit`,
    denied(await as(db, "authenticated", uid, `insert into public.cash_deposits (driver_id, amount, method) values ('${uid}', 5, 'cash')`))
    && denied(await as(db, "authenticated", uid, `update public.cash_deposits set amount = 1`))
    && denied(await as(db, "authenticated", uid, `delete from public.cash_deposits`)));
}
ok("nobody signed in writes a dispute or a reminder",
  denied(await as(db, "authenticated", D1, `insert into public.cash_disputes (driver_id, day, message) values ('${D1}', '2025-03-01', 'x')`))
  && denied(await as(db, "authenticated", A, `update public.cash_disputes set status = 'resolved'`))
  && denied(await as(db, "authenticated", D1, `insert into public.cash_reminders (driver_id) values ('${D2}')`)));
ok("the service role writes all three",
  (await as(db, "service_role", null, `insert into public.cash_deposits (driver_id, amount, method) values ('${D2}', 7, 'cash')`)).ok
  && (await as(db, "service_role", null, `update public.cash_disputes set status = 'resolved', resolution = 'fixed', resolved_by = '${M}', resolved_at = now() where id = '${DISP}'`)).ok
  && (await as(db, "service_role", null, `update public.cash_reminders set last_sent_at = now()`)).ok);
ok("RLS is on for all three tables",
  (await count(db, `select 1 from pg_class where relname in ('cash_deposits','cash_disputes','cash_reminders') and relrowsecurity`)) === 3);
ok("deleting a profile removes their deposits, disputes and reminder (on delete cascade)",
  (await run(db, `delete from public.cash_deposits where driver_id = '${D1}' and status = 'confirmed'`)).ok
  && (await run(db, `delete from public.cod_handovers where id = '${HO}'`)).ok
  && (await run(db, `delete from public.profiles where id = '${D1}'`)).ok
  && (await count(db, `select 1 from public.cash_deposits where driver_id = '${D1}'`)) === 0
  && (await count(db, `select 1 from public.cash_disputes where driver_id = '${D1}'`)) === 0
  && (await count(db, `select 1 from public.cash_reminders where driver_id = '${D1}'`)) === 0);

// ── idempotence ──
console.log("\n── idempotence ──");
await db.exec(`update public.platform_settings set rider_cash_limit = 7000, rider_cash_max_hours = 12`);
const before = await count(db, `select 1 from public.cash_deposits`);
let reran = true; try { await db.exec(M0085); await db.exec(M0085); } catch (e) { reran = false; console.log(e.message); }
ok("a re-run (twice) succeeds", reran);
s = await one(db, `select rider_cash_limit, rider_cash_max_hours from public.platform_settings`);
ok("...keeps the thresholds and every row", s.rider_cash_limit === 7000 && s.rider_cash_max_hours === 12 && (await count(db, `select 1 from public.cash_deposits`)) === before);

// ── identical to the Manager branch's 0150 "Rider 0085" section ──
console.log("\n── convergence with the Manager branch's 0150 ──");
if (!M0150) {
  console.log(`  SKIP ${P0150} not found`);
} else {
  const fingerprint = async (d) => {
    const q = async (sql) => (await d.query(sql)).rows.map((x) => Object.values(x).join("|")).sort().join("\n");
    const tables = `('cash_deposits','cash_disputes','cash_reminders')`;
    return [
      await q(`select table_name, column_name, data_type, is_nullable, coalesce(column_default,'') from information_schema.columns
               where table_schema='public' and table_name in ${tables}`),
      await q(`select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint
               where conrelid::regclass::text in ('cash_deposits','cash_disputes','cash_reminders')`),
      await q(`select tablename, indexname, indexdef from pg_indexes where schemaname='public' and tablename in ${tables}`),
      await q(`select tablename, policyname, cmd, coalesce(qual,''), coalesce(with_check,'') from pg_policies where tablename in ${tables}`),
      await q(`select relname, relrowsecurity::text from pg_class where relname in ${tables}`),
      await q(`select table_name, grantee, privilege_type from information_schema.role_table_grants
               where table_schema='public' and table_name in ${tables} and grantee in ('anon','authenticated','service_role')`),
    ].join("\n--\n");
  };
  // a: 0085 first, then 0150.  b: 0150 first, then 0085.  c: 0150 alone.
  let a, b, c, applied150 = true;
  try {
    a = await fresh(); await a.exec(M0150);
    b = await fresh({ upTo0085: false }); await b.exec(M0150); await b.exec(M0085);
    c = await fresh({ upTo0085: false }); await c.exec(M0150);
  } catch (e) { applied150 = false; console.log(`0150 did not apply here: ${e.message}`); }
  ok("0150 applies after 0085, and 0085 applies after 0150", applied150);
  if (applied150) {
    const fa = await fingerprint(a), fb = await fingerprint(b), fc = await fingerprint(c);
    ok("the cash tables are identical whichever migration lands first", fa === fb);
    ok("...and identical to 0150 alone (0085 adds nothing to them)", fb === fc);
    ok("...the only thing 0085 adds beyond 0150 is the two threshold columns",
      (await count(b, `select 1 from information_schema.columns where table_name='platform_settings' and column_name in ('rider_cash_limit','rider_cash_max_hours')`)) === 2
      && (await count(c, `select 1 from information_schema.columns where table_name='platform_settings' and column_name in ('rider_cash_limit','rider_cash_max_hours')`)) === 0);
    if (fa !== fb || fb !== fc) {
      const x = fb.split("\n"), y = fc.split("\n");
      console.log(`  a/b/c differ; first b-vs-c lines: ${x.filter((l) => !y.includes(l)).slice(0, 5).join(" ;; ")} <> ${y.filter((l) => !x.includes(l)).slice(0, 5).join(" ;; ")}`);
    }
  }
}

// ── the rollback block ──
console.log("\n── the rollback block (fresh instance) ──");
const lines = M0085.split("\n");
const from = lines.findIndex((l) => l.startsWith("-- Rollback"));
const block = [];
for (const l of lines.slice(from + 1)) {
  if (l.startsWith("-- ====")) break;
  if (/^--   /.test(l) && !/^--\s+--/.test(l)) block.push(l.slice(2));
}
const ROLLBACK = block.join("\n");
ok("the rollback block was found", from > 0 && /drop table/.test(ROLLBACK));
const rb = await fresh();
await rb.exec(`insert into public.cash_deposits (driver_id, amount, method) values ('${D2}', 5, 'cash')`);
let rolled = true; try { await rb.exec(ROLLBACK); } catch (err) { rolled = false; console.log(`rollback failed: ${err.message}`); }
ok("the rollback block runs to completion", rolled);
ok("...and removes the tables and both columns",
  (await one(rb, `select to_regclass('public.cash_deposits') is null and to_regclass('public.cash_disputes') is null
                    and to_regclass('public.cash_reminders') is null
                    and not exists (select 1 from information_schema.columns where table_name='platform_settings' and column_name in ('rider_cash_limit','rider_cash_max_hours')) as gone`)).gone === true);
ok("...leaves cod_handovers and the rest of platform_settings alone",
  (await count(rb, `select 1 from information_schema.columns where table_name='cod_handovers'`)) > 0
  && (await run(rb, `select rider_base_fee from public.platform_settings`)).ok);
let reapplied = true; try { await rb.exec(M0085); } catch (err) { reapplied = false; console.log(err.message); }
ok("...and 0085 applies again after the rollback", reapplied);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
