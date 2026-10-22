// Runs migrations 0047, 0081, 0082, 0083 then 0085 in one in-process Postgres (PGlite) with stubbed Supabase
// auth, orders and storage. Needs: npm i --no-save @electric-sql/pglite@0.2.17
// Usage: node scripts/qa/sql/migration-0085.mjs
// Optional: M0150=<path to the Manager branch's 0150_rider_tables_converge.sql> (default: the sibling
// worktree F:\hub26\deligro-manager) to prove 0085's cash tables are IDENTICAL to 0150's "Rider 0085" section,
// in both orders of arrival. It does not replace running the migration on staging.
// Also exports proof({ db, ns, quiet }) for scripts/qa/sql/rider-migrations-sequence.mjs, which runs these
// assertions on one database holding the real baseline and 0081-0087 (`seq` below); every id then carries
// the namespace `ns` in its fourth group so all seven proofs fit in one database.
import { PGlite } from "@electric-sql/pglite";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const read = (f) => readFileSync(new URL(`../../../supabase/migrations/${f}`, import.meta.url), "utf8");
const M0047 = read("0047_cod_handovers_and_expenses.sql");
const M0081 = read("0081_rider_app_foundation.sql");
const M0082 = read("0082_rider_jobs.sql");
const M0083 = read("0083_rider_money.sql");
let M0085 = "";
try { M0085 = read("0085_rider_cash.sql"); } catch { /* reported below */ }
// This tree's own 0150 once the branches are merged, else the env or the sibling worktree.
const OWN0150 = new URL("../../../supabase/migrations/0150_rider_tables_converge.sql", import.meta.url);
const P0150 = existsSync(OWN0150) ? OWN0150 : (process.env.M0150 ?? "F:/hub26/deligro-manager/supabase/migrations/0150_rider_tables_converge.sql");
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

const names = (ns) => {
  const id = (n) => `00000000-0000-0000-${ns}-${String(n).padStart(12, "0")}`;
  return { id, D1: id(0xd1), D2: id(0xd2), M: id(0xe1), A: id(0xa1), C: id(0xc1), V: id(0xb1), R: id(0xf1) };
};

async function seedRows(d, ns) {
  const { D1, D2, M, A, C, V, R } = names(ns);
  await d.exec(`
    insert into public.profiles (id, role, full_name, created_at) values
      ('${D1}','driver','First rider','2025-01-02'), ('${D2}','driver','Second rider','2025-01-03'),
      ('${M}','manager','Manager','2025-01-06'), ('${A}','admin','Admin','2025-01-07'),
      ('${C}','customer','Customer','2025-01-08'), ('${V}','restaurant','Vendor','2025-01-09');
    insert into public.restaurants (id, owner_id) values ('${R}','${V}');`);
}

async function fresh({ upTo0085 = true, ns = "0000" } = {}) {
  const d = new PGlite();
  await d.exec(STUBS);
  await seedRows(d, ns);
  await d.exec(M0047);
  await d.exec(M0081);
  await d.exec(M0082);
  await d.exec(M0083);
  if (upTo0085 && M0085) await d.exec(M0085);
  return d;
}

export async function proof({ db: shared = null, ns = "0000", quiet = false } = {}) {
  // seq: the sequence run passes one database that already holds the baseline and 0081-0087.
  const seq = shared !== null;
  const { id, D1, D2, M, A, C } = names(ns);

  let passed = 0, failed = 0;
  const ok = (n, c) => { if (c) passed++; else failed++; if (!c || !quiet) console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };
  if (!M0085) { console.log("supabase/migrations/0085_rider_cash.sql not found"); return { passed, failed: failed + 1 }; }

  let db = shared;
  if (seq) await seedRows(db, ns);
  else try { db = await fresh({ ns }); } catch (e) { console.log(`0085 did not apply: ${e.message}`); return { passed, failed: failed + 1 }; }
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

  // A fixture handover for a day the rider has a deposit: written the way the decision function writes one (flag on).
  await db.exec(`select set_config('deligro.deposit_confirm','on',false)`);
  const HO = (await one(db, `insert into public.cod_handovers (leg, from_user, to_user, amount, recorded_by)
    values ('rider_to_manager', '${D1}', '${M}', 500, '${M}') returning id`)).id;
  await db.exec(`select set_config('deligro.deposit_confirm','',false)`);
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
  const hg = await one(db, `select has_function_privilege('anon', 'public.guard_manual_rider_handover()', 'execute') as a,
                                   has_function_privilege('authenticated', 'public.guard_manual_rider_handover()', 'execute') as u,
                                   has_function_privilege('anon', 'public.ops_decide_cash_deposit(uuid,uuid,text,text,uuid,text)', 'execute') as da`);
  ok("guard_manual_rider_handover (SECURITY DEFINER, trigger-only): no EXECUTE for anon or authenticated (0054)", !hg.a && !hg.u);
  ok("ops_decide_cash_deposit: no EXECUTE for anon", !hg.da);
  ok("RLS is on for all three tables",
    (await count(db, `select 1 from pg_class where relname in ('cash_deposits','cash_disputes','cash_reminders') and relrowsecurity`)) === 3);
  ok("deleting a profile removes their deposits, disputes and reminder (on delete cascade)",
    (await run(db, `delete from public.cash_deposits where driver_id = '${D1}' and status = 'confirmed'`)).ok
    && (await run(db, `delete from public.cod_handovers where id = '${HO}'`)).ok
    && (await run(db, `delete from public.profiles where id = '${D1}'`)).ok
    && (await count(db, `select 1 from public.cash_deposits where driver_id = '${D1}'`)) === 0
    && (await count(db, `select 1 from public.cash_disputes where driver_id = '${D1}'`)) === 0
    && (await count(db, `select 1 from public.cash_reminders where driver_id = '${D1}'`)) === 0);

  // ── the deposit decision: one function, one transaction (ruling P5-R3) ──
  console.log("\n── ops_decide_cash_deposit and guard_manual_rider_handover ──");
  {
    // On the sequence database the block continues on the shared one; rider 1 was deleted just above.
    const d = seq ? db : await fresh({ ns });
    if (seq) await d.exec(`insert into public.profiles (id, role, full_name) values ('${D1}', 'driver', 'First rider')`);
    const call = (actor, dep, decision, note = null) =>
      as(d, "service_role", null,
        `select public.ops_decide_cash_deposit('${actor}', '${dep}', '${decision}', ${note === null ? "null" : `'${note}'`}, null, null) as r`);
    const mk = async (driver, over = "") =>
      (await one(d, `insert into public.cash_deposits (driver_id, amount, method${over ? ", " + over.split("|")[0] : ""})
                     values ('${driver}', 500, 'upi'${over ? ", " + over.split("|")[1] : ""}) returning id`)).id;
    const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
    const handovers = (driver) => count(d, `select 1 from public.cod_handovers where from_user = '${driver}'`);

    ok("the function exists with 0152's signature, service role only",
      (await count(d, `select 1 from pg_proc where proname = 'ops_decide_cash_deposit' and pronargs = 6`)) === 1
      && denied(await as(d, "authenticated", A, `select public.ops_decide_cash_deposit('${A}', '${id(1)}', 'confirm', null, null, null)`))
      && denied(await as(d, "anon", null, `select public.ops_decide_cash_deposit('${A}', '${id(1)}', 'confirm', null, null, null)`)));
    ok("it locks the deposit row", /for update/i.test((await one(d, `select prosrc from pg_proc where proname = 'ops_decide_cash_deposit'`)).prosrc));

    // confirm
    const dep1 = await mk(D1, "manager_id, reference|'" + M + "', 'UTR9'");
    let r = await call(A, dep1, "confirm");
    ok("confirm succeeds and returns the handover id", r.ok && r.rows[0].r.status === "confirmed" && r.rows[0].r.replayed === false);
    const h = await one(d, `select * from public.cod_handovers where from_user = '${D1}'`);
    const dep1row = await one(d, `select *, ((created_at at time zone 'Asia/Kolkata')::date)::text as day from public.cash_deposits where id = '${dep1}'`);
    ok("...one rider_to_manager handover: from the rider, to the NAMED manager, recorded by the confirmer, the deposit's amount",
      (await handovers(D1)) === 1 && h.leg === "rider_to_manager" && h.to_user === M && h.recorded_by === A && h.amount === 500);
    ok("...dated to the deposit's IST day, with a note naming the method and reference",
      day(h.handover_date) === dep1row.day && /Deposit upi UTR9/.test(h.note));
    ok("...and the deposit is confirmed, linked to it, decided by the confirmer",
      dep1row.status === "confirmed" && dep1row.handover_id === h.id && dep1row.decided_by === A && dep1row.decided_at !== null);
    // replay
    r = await call(A, dep1, "confirm");
    ok("a replayed confirm is refused (already_decided) and writes no second handover",
      !r.ok && /already_decided/.test(r.msg) && r.code === "22023" && (await handovers(D1)) === 1);
    ok("...and a dispute after a confirm is refused too", !(await call(A, dep1, "dispute", "too late")).ok);
    // unnamed manager: the confirmer receives it
    const dep2 = await mk(D2);
    await call(M, dep2, "confirm");
    ok("an unnamed deposit goes to whoever confirms it", (await one(d, `select to_user from public.cod_handovers where from_user = '${D2}'`)).to_user === M);

    // a confirmation the next day is dated to the deposit's day
    const old = await mk(D1, `created_at|now() - interval '26 hours'`);
    // a different rider so the same-day manual-handover rule is not involved
    const oldDep = await mk(D2, `created_at|now() - interval '50 hours'`);
    r = await call(M, oldDep, "confirm");
    const oh = await one(d, `select (handover_date)::text as hd, ((select (created_at at time zone 'Asia/Kolkata')::date from public.cash_deposits where id = '${oldDep}'))::text as dd,
                                    ((now() at time zone 'Asia/Kolkata')::date)::text as today
                               from public.cod_handovers where id = (select handover_id from public.cash_deposits where id = '${oldDep}')`);
    ok("a deposit confirmed days later is dated to the day it was declared, not today", r.ok && oh.hd === oh.dd && oh.hd !== oh.today);

    // manual handover for the deposit's day
    const D3x = id(0xd3), D4x = id(0xd4);
    await d.exec(`insert into public.profiles (id, role, full_name) values ('${D3x}','driver','Third'), ('${D4x}','driver','Fourth')`);
    await d.exec(`insert into public.cod_handovers (leg, from_user, to_user, amount, recorded_by, handover_date)
                  values ('rider_to_manager', '${D3x}', '${M}', 300, '${M}', current_date - 40)`); // an old manual one: other day
    const dep3 = await mk(D3x);
    r = await call(M, dep3, "confirm");
    ok("a manual handover on ANOTHER day does not block the confirmation", r.ok);
    const dep4 = await mk(D4x);
    const manual = (driver, amount = 500) => run(d, `insert into public.cod_handovers (leg, from_user, to_user, amount, recorded_by, handover_date)
      values ('rider_to_manager', '${driver}', '${M}', ${amount}, '${M}', (now() at time zone 'Asia/Kolkata')::date)`);
    r = await manual(D4x);
    ok("a hand-written handover on a day the rider has a submitted deposit is refused by the guard (deposit_exists)",
      !r.ok && /deposit_exists/.test(r.msg) && r.code === "23505" && (await handovers(D4x)) === 0);
    await d.exec(`delete from public.cash_deposits where id = '${dep4}'`);
    ok("...with no deposit that day the manual handover is accepted", (await manual(D4x)).ok);
    const dep5 = await mk(D4x); // the rider declares after the manager wrote the same cash by hand
    // (declared later the same day: the deposit insert is not guarded, only the handover is)
    r = await call(M, dep5, "confirm");
    ok("a manual same-day handover blocks the confirmation: manual_handover_exists (23505), nothing written, the deposit stays submitted",
      !r.ok && /manual_handover_exists/.test(r.msg) && r.code === "23505" && (await handovers(D4x)) === 1
      && (await one(d, `select status from public.cash_deposits where id = '${dep5}'`)).status === "submitted");
    ok("...the deposit can still be disputed", (await call(M, dep5, "dispute", "Already recorded by hand")).ok);
    ok("a handover that IS linked to another deposit is not 'manual' (the second deposit of a day confirms)",
      await (async () => {
        const a = await mk(D1);
        const b = await mk(D1);
        return (await call(M, a, "confirm")).ok && (await call(M, b, "confirm")).ok;
      })());

    // atomic: a failure after the insert leaves nothing
    const dep6 = await mk(D2);
    await d.exec(`update public.cash_deposits set amount = 777 where id = '${dep6}'`);
    await d.exec(`create function public.__boom() returns trigger language plpgsql as $$ begin if new.amount = 777 then raise exception 'boom'; end if; return new; end $$;
                  create constraint trigger __boom after insert on public.cod_handovers deferrable initially immediate for each row execute function public.__boom();`);
    const before = await handovers(D2);
    r = await call(M, dep6, "confirm");
    ok("a failure mid-confirmation rolls back whole: no handover, the deposit still 'submitted' and unclaimed",
      !r.ok && /boom/.test(r.msg) && (await handovers(D2)) === before
      && (await one(d, `select status, handover_id, decided_by from public.cash_deposits where id = '${dep6}'`)).status === "submitted"
      && (await one(d, `select handover_id from public.cash_deposits where id = '${dep6}'`)).handover_id === null);
    await d.exec(`drop trigger __boom on public.cod_handovers; drop function public.__boom();`);
    r = await call(M, dep6, "confirm");
    ok("...and the retry then writes exactly one", r.ok && (await handovers(D2)) === before + 1);

    // dispute
    const dep7 = await mk(D2);
    ok("a dispute needs a note of at least 3 characters (note_required)",
      !(await call(M, dep7, "dispute")).ok && !(await call(M, dep7, "dispute", "  ")).ok && /note_required/.test((await call(M, dep7, "dispute", "ab")).msg));
    const handoversBefore = await count(d, `select 1 from public.cod_handovers`);
    r = await call(M, dep7, "dispute", "Only 400 reached me");
    const disputed = await one(d, `select status, decision_note, decided_by, handover_id from public.cash_deposits where id = '${dep7}'`);
    ok("a dispute with a note records it, writes no handover",
      r.ok && disputed.status === "disputed" && disputed.decision_note === "Only 400 reached me" && disputed.decided_by === M
      && disputed.handover_id === null && (await count(d, `select 1 from public.cod_handovers`)) === handoversBefore);
    ok("a note over 500 characters is refused", !(await call(M, await mk(D2), "dispute", "x".repeat(501))).ok);
    ok("an unknown decision is refused (invalid_transition)", /invalid_transition/.test((await call(M, await mk(D2), "approve")).msg));

    // who may call
    ok("only a manager or admin profile may decide (a rider, a customer, an unknown id: forbidden 42501)",
      (await call(D1, await mk(D2), "confirm")).code === "42501"
      && (await call(C, await mk(D2), "confirm")).code === "42501"
      && (await call(id(0x99), await mk(D2), "confirm")).code === "42501");
    ok("an unknown deposit answers forbidden (0152: no oracle for which ids exist)", (await call(M, id(0xdead), "confirm")).code === "42501");

    // the guard and its flag
    ok("a hand-written rider_to_manager leg on a day with a submitted deposit is refused: deposit_exists",
      await (async () => {
        await mk(D3x); // submitted today
        const x = await run(d, `insert into public.cod_handovers (leg, from_user, amount, recorded_by, handover_date)
                                values ('rider_to_manager', '${D3x}', 10, '${M}', (now() at time zone 'Asia/Kolkata')::date)`);
        return !x.ok && /deposit_exists/.test(x.msg) && x.code === "23505";
      })());
    ok("...a leg to the owner, or one for a rider with no deposit that day, is not touched",
      (await run(d, `insert into public.cod_handovers (leg, from_user, amount, recorded_by, handover_date)
                     values ('manager_to_owner', '${D3x}', 10, '${M}', (now() at time zone 'Asia/Kolkata')::date)`)).ok
      && (await run(d, `insert into public.cod_handovers (leg, from_user, amount, recorded_by, handover_date)
                        values ('rider_to_manager', '${D3x}', 10, '${M}', current_date - 200)`)).ok);
    ok("...a withdrawn or disputed deposit does not block a manual handover that day",
      await (async () => {
        const D5x = id(0xd5);
        await d.exec(`insert into public.profiles (id, role, full_name) values ('${D5x}','driver','Fifth');
          insert into public.cash_deposits (driver_id, amount, method, status) values ('${D5x}', 5, 'cash', 'withdrawn');
          insert into public.cash_deposits (driver_id, amount, method, status, decision_note) values ('${D5x}', 5, 'cash', 'disputed', 'no');`);
        return (await manual(D5x, 10)).ok;
      })());
    ok("the flag is transaction-local: after a confirmation the guard is on again for a manual insert",
      await (async () => {
        const dd = await mk(D1);
        await call(M, dd, "confirm");
        const x = await run(d, `insert into public.cod_handovers (leg, from_user, amount, recorded_by, handover_date)
                                values ('rider_to_manager', '${D3x}', 10, '${M}', (now() at time zone 'Asia/Kolkata')::date)`);
        return !x.ok && /deposit_exists/.test(x.msg) && ((await one(d, `select coalesce(current_setting('deligro.deposit_confirm', true), '') as f`)).f === "");
      })());
  }

  // Convergence, re-runs and rollback build their own databases (the sequence run re-applies and rolls back all seven).
  if (!seq) {
    // ── convergence of the decision function and guard with 0152 ──
    console.log("\n── convergence with the Manager branch's 0152 ──");
    {
      const P0152 = process.env.M0152 ?? "F:/hub26/deligro-manager/supabase/migrations/0152_payment_requests_cash_exceptions.sql";
      if (!existsSync(P0152)) {
        console.log(`  SKIP ${P0152} not found`);
      } else {
        const t152 = readFileSync(P0152, "utf8");
        const g = t152.indexOf("create or replace function public.guard_manual_rider_handover()");
        const guardEnd = t152.indexOf("for each row execute function public.guard_manual_rider_handover();", g);
        const GUARD152 = t152.slice(g, guardEnd + "for each row execute function public.guard_manual_rider_handover();".length);
        ok("0152's guard block was found", g > 0 && guardEnd > g);
        const defs = async (d) => (await d.query(`select pg_get_functiondef(p.oid) as f from pg_proc p where p.proname = 'guard_manual_rider_handover'`)).rows[0].f
          + (await d.query(`select pg_get_triggerdef(t.oid) as f from pg_trigger t where t.tgname = 'guard_manual_rider_handover'`)).rows[0].f;
        const mine = await fresh();
        const mineDefs = (await defs(mine)).split(String.fromCharCode(13)).join("");
        const theirs = await fresh({ upTo0085: false });
        await theirs.exec(`create table public.cash_deposits (id uuid primary key default gen_random_uuid(), driver_id uuid, status text, created_at timestamptz default now())`);
        await theirs.exec(GUARD152);
        const theirDefs = (await defs(theirs)).split(String.fromCharCode(13)).join("");
        ok("the guard function and trigger are identical to 0152's (same definition text)", theirDefs === mineDefs);
        if (theirDefs !== mineDefs) console.log(JSON.stringify([mineDefs, theirDefs]).slice(0, 1500));
        // 0152's function present first: 0085 must not replace it
        const first = await fresh({ upTo0085: false });
        await first.exec(`create function public.ops_decide_cash_deposit(p_actor uuid, p_deposit uuid, p_decision text, p_note text, p_zone uuid, p_client_action_id text)
                          returns jsonb language sql as $$ select '{"manager":"version"}'::jsonb $$`);
        await first.exec(M0085);
        ok("when 0152's function is already there, 0085 leaves it alone",
          /manager.*version/.test((await one(first, `select prosrc from pg_proc where proname = 'ops_decide_cash_deposit'`)).prosrc));
        ok("...and when 0085 landed first, a later create or replace supersedes it (same signature)",
          await (async () => {
            await mine.exec(`create or replace function public.ops_decide_cash_deposit(p_actor uuid, p_deposit uuid, p_decision text, p_note text, p_zone uuid, p_client_action_id text)
                             returns jsonb language sql as $$ select '{"later":"0152"}'::jsonb $$`);
            return /0152/.test((await one(mine, `select prosrc from pg_proc where proname = 'ops_decide_cash_deposit'`)).prosrc)
              && (await count(mine, `select 1 from pg_proc where proname = 'ops_decide_cash_deposit'`)) === 1;
          })());
      }
    }

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
    } else if (!/create table/i.test(M0150)) {
      // Since the branches merged, 0150 is only a guard that 0084–0086 are
      // applied: 0085 is the one definition of the cash tables.
      ok("0150 is now only a guard and defines none of the cash tables (0085 is the one definition)",
        !/cash_deposits\s*\(/i.test(M0150) && /apply the Rider migrations 0084, 0085 and 0086 before 0150/.test(M0150));
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
  }

  return { passed, failed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { passed, failed } = await proof();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
