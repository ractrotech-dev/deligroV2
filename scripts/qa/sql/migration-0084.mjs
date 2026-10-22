// Runs migration 0084 (rider ratings + default targets) in one in-process Postgres (PGlite) with stubbed
// Supabase auth and the base tables it touches (profiles, orders, deliveries, platform_settings), with the
// same RLS and Supabase default privileges production has. 0084 needs nothing from 0081-0083.
// Needs PGlite 0.2.17, installed OUTSIDE the repo (node_modules is shared between worktrees):
//   mkdir F:\dev\tmp\pglite && cd F:\dev\tmp\pglite && npm i @electric-sql/pglite@0.2.17
// Usage: NODE_PATH=F:\dev\tmp\pglite\node_modules node scripts/qa/sql/migration-0084.mjs
//   (ESM ignores NODE_PATH, so the script resolves PGlite itself; set PGLITE_DIR to override the location.)
// Proves the ratings table (one per order, 1-5, 300 characters), who can read and write it (customer, rider,
// admin, anon), that customer_id never reaches anyone signed in, the my_rider_ratings view, the default
// targets, idempotency, convergence with the Manager branch's 0150 copy in either order, and the rollback.
// It does not replace running the migration on staging.
// Also exports proof({ db, ns, quiet }) for scripts/qa/sql/rider-migrations-sequence.mjs, which runs these
// assertions on one database holding the real baseline and 0081-0087 (`seq` below); every id then carries
// the namespace `ns` in its fourth group so all seven proofs fit in one database.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const dir = process.env.PGLITE_DIR ?? process.env.NODE_PATH?.split(/[;:]/)[0] ?? "F:/dev/tmp/pglite/node_modules";
let PGlite;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  const req = createRequire(pathToFileURL(`${dir.replace(/\\/g, "/")}/`).href);
  ({ PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite")).href));
}

const M0084 = readFileSync(new URL("../../../supabase/migrations/0084_rider_ratings_targets.sql", import.meta.url), "utf8");
const ROLLBACK = M0084.split(/\r?\n/)
  .filter((l, i, all) => i > all.findIndex((x) => x.startsWith("-- Rollback:")) && /^--   +\S/.test(l))
  .map((l) => l.replace(/^--\s+/, ""))
  .join("\n");
if (!/drop table if exists public\.rider_ratings/.test(ROLLBACK)) throw new Error("rollback block not found in 0084");

const STUBS = `
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create role anon; create role authenticated; create role service_role bypassrls;

  -- Supabase default: every table, sequence and function created later in public
  -- is granted to the API roles. The migration has to take that back itself.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  create table public.profiles (id uuid primary key, role text not null, full_name text);
  create table public.restaurants (id uuid primary key, owner_id uuid);
  create table public.orders (id uuid primary key, status text not null default 'ready',
    customer_id uuid, restaurant_id uuid);
  create type public.delivery_status as enum ('unassigned', 'assigned', 'picked_up', 'delivered', 'cancelled');
  create table public.deliveries (
    id uuid primary key default gen_random_uuid(),
    order_id uuid not null unique references public.orders (id) on delete cascade,
    driver_id uuid references public.profiles (id) on delete set null,
    status public.delivery_status not null default 'unassigned');
  -- 0032: platform_settings is column-granted; a new column is invisible until granted on purpose.
  create table public.platform_settings (id boolean primary key default true check (id),
    business_name text not null default 'Deligro', vendor_commission_pct numeric);
  insert into public.platform_settings (id) values (true);

  create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;
  create function public.owns_restaurant(rid uuid) returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.restaurants r where r.id = rid and r.owner_id = auth.uid()) $$;

  -- 0001: the policies production has. A customer cannot read deliveries.
  alter table public.profiles enable row level security;
  create policy "profiles — read" on public.profiles for select using (true);
  alter table public.orders enable row level security;
  create policy "orders — read" on public.orders for select
    using (customer_id = auth.uid() or public.owns_restaurant(restaurant_id) or public.is_admin());
  alter table public.deliveries enable row level security;
  create policy "deliveries — read" on public.deliveries for select
    using (driver_id = auth.uid()
           or exists (select 1 from public.orders o where o.id = order_id and public.owns_restaurant(o.restaurant_id))
           or public.is_admin());
  create policy "deliveries — admin manage" on public.deliveries for all
    using (public.is_admin()) with check (public.is_admin());

  grant usage on schema public, auth to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  revoke select on public.platform_settings from anon, authenticated;
  grant select (id, business_name) on public.platform_settings to anon, authenticated;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`;


const names = (ns) => {
  const id = (n) => `00000000-0000-0000-${ns}-${String(n).padStart(12, "0")}`;
  return { id, D1: id(0xd1), D2: id(0xd2), C1: id(0xc1), C2: id(0xc2), A: id(0xa1), V: id(0xb1), R: id(0xf1),
           O: (n) => id(0x1000 + n) };
};

// The proof's rows. On the sequence database 0082's insert guard admits a delivery born delivered or
// picked up only as a correction (an import), so there each delivery carries a correction_reason.
async function seedRows(db, ns, seq) {
  const { D1, D2, C1, C2, A, V, R, O } = names(ns);
  const corr = seq ? ", correction_reason" : "";
  const why = seq ? ", 'fixture:0084'" : "";
  await db.exec(`
    insert into public.profiles (id, role, full_name) values
      ('${D1}','driver','Rider one'), ('${D2}','driver','Rider two'),
      ('${C1}','customer','Customer one'), ('${C2}','customer','Customer two'),
      ('${A}','admin','Admin'), ('${V}','restaurant','Vendor');
    insert into public.restaurants (id, owner_id) values ('${R}','${V}');
    -- O(1): C1's delivered order by D1.  O(2): C1's order still on the road with D1.
    -- O(3): C2's delivered order by D1.  O(4): C1's delivered order by D2.
    -- O(5): ${A}'s own delivered order by D1 (an admin who is also a customer; see the policy proof).
    insert into public.orders (id, status, customer_id, restaurant_id) values
      ('${O(1)}','delivered','${C1}','${R}'), ('${O(2)}','on_the_way','${C1}','${R}'),
      ('${O(3)}','delivered','${C2}','${R}'), ('${O(4)}','delivered','${C1}','${R}'),
      ('${O(5)}','delivered','${A}','${R}'), ('${O(6)}','on_the_way','${A}','${R}');
    insert into public.deliveries (order_id, driver_id, status${corr}) values
      ('${O(1)}','${D1}','delivered'${why}), ('${O(2)}','${D1}','picked_up'${why}),
      ('${O(3)}','${D1}','delivered'${why}), ('${O(4)}','${D2}','delivered'${why}),
      ('${O(5)}','${D1}','delivered'${why}), ('${O(6)}','${D1}','picked_up'${why});
  `);
}

async function fresh(ns = "0000") {
  const db = new PGlite();
  await db.exec(STUBS);
  await seedRows(db, ns, false);
  return db;
}

export async function proof({ db: shared = null, ns = "0000", quiet = false } = {}) {
  // seq: the sequence run passes one database that already holds the baseline and 0081-0087.
  const seq = shared !== null;
  const { id, D1, D2, C1, C2, A, O } = names(ns);
  const db = seq ? shared : await fresh(ns);
  if (seq) await seedRows(db, ns, true);

  let passed = 0, failed = 0;
  const ok = (n, c) => { if (c) passed++; else failed++; if (!c || !quiet) console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };

  async function run(d, sql) {
    try { const r = await d.query(sql); return { ok: true, rows: r.rows }; }
    catch (e) { return { ok: false, msg: String(e.message), code: e.code }; }
  }
  async function as(d, role, uid, sql) {
    await d.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false);`);
    try { return await run(d, sql); }
    finally { await d.exec("reset role; select set_config('test.uid','',false);"); }
  }
  const denied = (r) => !r.ok && /permission denied/.test(r.msg);
  const rlsRefused = (r) => !r.ok && /row-level security/.test(r.msg);
  const code = (r, c) => !r.ok && r.code === c;
  const one = async (d, sql) => (await d.query(sql)).rows[0];
  const count = async (d, sql) => Number((await one(d, `select count(*)::int as n from (${sql}) q`)).n);

  // ── applies ──
  console.log("\n── applies, and applies again ──");
  let applied = true;
  if (!seq) {
    try { await db.exec(M0084); } catch (e) { applied = false; console.log(`0084 did not apply: ${e.message}`); }
  }
  ok("0084 applies on the base schema", applied);
  if (!applied) return { passed, failed };
  // The sequence run re-applies 0081-0087 together on its populated database instead.
  let again = true;
  if (!seq) try { await db.exec(M0084); } catch (e) { again = false; console.log(e.message); }
  ok("...and applies a second time (idempotent)", again);

  const snapshot = async (d) => JSON.stringify({
    cols: (await d.query(`select column_name, data_type, is_nullable, column_default from information_schema.columns
                           where table_schema='public' and table_name='rider_ratings' order by column_name`)).rows,
    policies: (await d.query(`select policyname, cmd, qual, with_check from pg_policies
                               where schemaname='public' and tablename='rider_ratings' order by policyname`)).rows,
    colGrants: (await d.query(`select grantee, column_name, privilege_type from information_schema.column_privileges
                                where table_schema='public' and table_name='rider_ratings'
                                  and grantee in ('anon','authenticated','service_role') order by 1,2,3`)).rows,
    tabGrants: (await d.query(`select grantee, privilege_type from information_schema.table_privileges
                                where table_schema='public' and table_name in ('rider_ratings','my_rider_ratings')
                                  and grantee in ('anon','authenticated','service_role') order by 1,2`)).rows,
    view: (await d.query(`select pg_get_viewdef('public.my_rider_ratings'::regclass) as d`)).rows[0].d,
    viewOpts: (await d.query(`select reloptions::text as o from pg_class where oid = 'public.my_rider_ratings'::regclass`)).rows[0].o,
    rls: (await d.query(`select relrowsecurity from pg_class where oid = 'public.rider_ratings'::regclass`)).rows[0].relrowsecurity,
    indexes: (await d.query(`select indexname from pg_indexes where schemaname='public' and tablename='rider_ratings' order by 1`)).rows,
  });

  // ── the table ──
  console.log("\n── rider_ratings: columns and checks ──");
  const cols = (await db.query(`select column_name from information_schema.columns where table_name='rider_ratings'`)).rows.map((r) => r.column_name).sort();
  ok("columns: id, order_id, driver_id, customer_id, rating, comment, created_at",
    JSON.stringify(cols) === JSON.stringify(["comment", "created_at", "customer_id", "driver_id", "id", "order_id", "rating"]));
  const ins = (o, d, c, rating, comment = null) =>
    `insert into public.rider_ratings (order_id, driver_id, customer_id, rating, comment)
     values ('${o}','${d}','${c}',${rating},${comment === null ? "null" : `'${comment}'`})`;
  ok("rating 0 is refused", code(await run(db, ins(O(1), D1, C1, 0)), "23514"));
  ok("rating 6 is refused", code(await run(db, ins(O(1), D1, C1, 6)), "23514"));
  ok("a 301-character comment is refused", code(await run(db, ins(O(1), D1, C1, 5, "x".repeat(301))), "23514"));
  ok("a 300-character comment is accepted", (await run(db, ins(O(1), D1, C1, 5, "x".repeat(300)))).ok);
  ok("a second rating for the same order is refused (23505)", code(await run(db, ins(O(1), D1, C1, 4)), "23505"));
  ok("a rating needs a real rider (foreign key)", code(await run(db, ins(O(3), id(0x999), C2, 4)), "23503"));
  ok("an empty comment is allowed (null)", (await run(db, ins(O(3), D1, C2, 3))).ok);
  await db.exec(`delete from public.rider_ratings`);

  // ── reading ──
  console.log("\n── who reads what ──");
  await db.exec(`
    insert into public.rider_ratings (order_id, driver_id, customer_id, rating, comment) values
      ('${O(1)}','${D1}','${C1}',5,'Quick and polite'),
      ('${O(3)}','${D1}','${C2}',2,'Late'),
      ('${O(4)}','${D2}','${C1}',4,null)`);
  const own = "select id, order_id, driver_id, rating, comment, created_at from public.rider_ratings";
  ok("anon cannot read the table", denied(await as(db, "anon", null, own)));
  ok("anon cannot read the view", denied(await as(db, "anon", null, "select * from public.my_rider_ratings")));
  ok("anon cannot insert", denied(await as(db, "anon", null, ins(O(1), D1, C1, 5))));
  let r = await as(db, "authenticated", C1, own);
  ok("a customer reads only their own ratings (2 of 3)", r.ok && r.rows.length === 2 && r.rows.every((x) => [O(1), O(4)].includes(x.order_id)));
  ok("...and the table gives a customer no customer_id column", denied(await as(db, "authenticated", C1, "select customer_id from public.rider_ratings")));
  ok("...nor via select *", denied(await as(db, "authenticated", C1, "select * from public.rider_ratings")));
  r = await as(db, "authenticated", D1, own);
  ok("a rider sees NO rows of the table itself", r.ok && r.rows.length === 0);
  ok("a rider cannot select customer_id", denied(await as(db, "authenticated", D1, "select customer_id from public.rider_ratings")));
  ok("a rider cannot select * from the table", denied(await as(db, "authenticated", D1, "select * from public.rider_ratings")));
  r = await as(db, "authenticated", D1, "select * from public.my_rider_ratings order by rating");
  ok("a rider reads their own ratings through my_rider_ratings (2: Late 2, Quick 5)",
    r.ok && r.rows.length === 2 && r.rows[0].comment === "Late" && r.rows[1].comment === "Quick and polite");
  ok("...the view has no customer_id", r.ok && !("customer_id" in r.rows[0]));
  ok("...and other riders' ratings are not in it", r.ok && r.rows.every((x) => x.driver_id === D1));
  r = await as(db, "authenticated", D2, "select rating from public.my_rider_ratings");
  ok("the other rider sees only theirs (1)", r.ok && r.rows.length === 1 && Number(r.rows[0].rating) === 4);
  r = await as(db, "authenticated", C2, "select count(*)::int as n from public.my_rider_ratings");
  ok("a customer's view is empty (they are nobody's rider)", r.ok && r.rows[0].n === 0);
  r = await as(db, "authenticated", A, own);
  ok("an admin reads all ratings (3)", r.ok && r.rows.length === 3);
  ok("...but not customer_id either (the server reads it with the service role)", denied(await as(db, "authenticated", A, "select customer_id from public.rider_ratings")));
  r = await as(db, "service_role", null, "select customer_id from public.rider_ratings");
  ok("the service role reads customer_id", r.ok && r.rows.length === 3);

  // ── writing ──
  console.log("\n── who writes ──");
  const upd = "update public.rider_ratings set rating = 5";
  const del = "delete from public.rider_ratings";
  for (const [who, uid] of [["a customer", C1], ["a rider", D1], ["an admin", A]]) {
    ok(`${who} cannot update`, denied(await as(db, "authenticated", uid, upd)));
    ok(`${who} cannot delete`, denied(await as(db, "authenticated", uid, del)));
  }
  ok("anon cannot update", denied(await as(db, "anon", null, upd)));
  ok("a rider cannot update through the view", denied(await as(db, "authenticated", D1, "update public.my_rider_ratings set rating = 5")));
  ok("a rider cannot delete through the view", denied(await as(db, "authenticated", D1, "delete from public.my_rider_ratings")));
  ok("a rider cannot insert through the view", denied(await as(db, "authenticated", D1,
    `insert into public.my_rider_ratings (order_id, driver_id, rating) values ('${O(2)}','${D1}',5)`)));
  ok("nothing changed", (await count(db, "select 1 from public.rider_ratings where rating = 5")) === 1);
  r = await as(db, "service_role", null, `update public.rider_ratings set comment = 'edited' where order_id = '${O(4)}'`);
  ok("the service role can update (admin tools write through it)", r.ok);

  // ── the insert policy ──
  console.log("\n── the insert policy ──");
  await db.exec(`delete from public.rider_ratings`);
  // FINDING: a customer cannot read deliveries, so the policy's EXISTS (orders join deliveries) sees nothing
  // under the customer's own rights and refuses even the valid case. That fails closed; the API inserts with the
  // service role after checking the same conditions. The policy logic itself is proved below with an admin who is
  // also the customer (an admin can read deliveries), so each condition is shown to bite.
  ok("a customer's own-session insert for their delivered order is refused today (deliveries unreadable to them)",
    rlsRefused(await as(db, "authenticated", C1, ins(O(1), D1, C1, 5))));
  ok("...a rider cannot rate either", rlsRefused(await as(db, "authenticated", D1, ins(O(1), D1, D1, 5))));
  ok("the service role inserts a rating (the API route's path)", (await as(db, "service_role", null, ins(O(1), D1, C1, 5, "Great"))).ok);
  ok("...and a second one for the same order is a 23505 whoever writes it", code(await as(db, "service_role", null, ins(O(1), D1, C1, 4)), "23505"));
  await db.exec(`delete from public.rider_ratings`);
  ok("policy: the order's customer, delivered, the delivery's rider -> allowed", (await as(db, "authenticated", A, ins(O(5), D1, A, 5, "ok"))).ok);
  ok("policy: a second rating -> 23505", code(await as(db, "authenticated", A, ins(O(5), D1, A, 3)), "23505"));
  await db.exec(`delete from public.rider_ratings`);
  ok("policy: an undelivered order -> refused", rlsRefused(await as(db, "authenticated", A, ins(O(6), D1, A, 5))));
  ok("policy: someone else's order -> refused", rlsRefused(await as(db, "authenticated", A, ins(O(1), D1, A, 5))));
  ok("policy: customer_id of another person -> refused", rlsRefused(await as(db, "authenticated", A, ins(O(5), D1, C1, 5))));
  ok("policy: a rider who did not deliver it -> refused", rlsRefused(await as(db, "authenticated", A, ins(O(5), D2, A, 5))));
  ok("policy: a 301-character comment -> raises", code(await as(db, "authenticated", A, ins(O(5), D1, A, 5, "y".repeat(301))), "23514"));
  ok("nothing was written by the refused attempts", (await count(db, "select 1 from public.rider_ratings")) === 0);

  // ── targets ──
  console.log("\n── platform_settings: default targets ──");
  let s = await one(db, "select rider_daily_target, rider_weekly_target from public.platform_settings");
  ok("both default to 0 (no default target)", s.rider_daily_target === 0 && s.rider_weekly_target === 0);
  ok("a negative daily target is refused", code(await run(db, "update public.platform_settings set rider_daily_target = -1"), "23514"));
  ok("a negative weekly target is refused", code(await run(db, "update public.platform_settings set rider_weekly_target = -1"), "23514"));
  ok("a daily target above 1000 is refused", code(await run(db, "update public.platform_settings set rider_daily_target = 1001"), "23514"));
  ok("a weekly target above 5000 is refused", code(await run(db, "update public.platform_settings set rider_weekly_target = 5001"), "23514"));
  ok("sensible targets are accepted", (await run(db, "update public.platform_settings set rider_daily_target = 12, rider_weekly_target = 70")).ok);
  ok("a rider can read the targets (the settings facade reads with the caller's client)",
    (await as(db, "authenticated", D1, "select rider_daily_target, rider_weekly_target from public.platform_settings")).rows?.[0]?.rider_weekly_target === 70);
  ok("anon can read them too", (await as(db, "anon", null, "select rider_daily_target from public.platform_settings")).ok);
  ok("vendor_commission_pct stays private", denied(await as(db, "anon", null, "select vendor_commission_pct from public.platform_settings")));

  // ── convergence with the Manager branch's 0150 ──
  // Convergence and rollback build their own databases (the sequence run does both for all seven).
  if (!seq) {
    console.log("\n── convergence with 0150's copy (either order) ──");
    // The statements below are a copy of the Rider-0084 parts of the Manager branch's
    // supabase/migrations/0150_rider_tables_converge.sql (sections 1 and 4, rider_ratings only).
    const M0150_COPY = `
    begin;
    create table if not exists public.rider_ratings (
      id          uuid primary key default gen_random_uuid(),
      order_id    uuid not null unique,
      driver_id   uuid not null references public.profiles (id) on delete cascade,
      customer_id uuid not null references public.profiles (id) on delete cascade,
      rating      smallint not null check (rating between 1 and 5),
      comment     text check (comment is null or char_length(comment) <= 300),
      created_at  timestamptz not null default now()
    );
    create index if not exists rider_ratings_driver_idx on public.rider_ratings (driver_id, created_at desc);
    create or replace view public.my_rider_ratings
    with (security_invoker = false) as
      select id, order_id, driver_id, rating, comment, created_at
        from public.rider_ratings
       where driver_id = auth.uid();
    alter table public.rider_ratings enable row level security;
    drop policy if exists "rider_ratings — customer insert" on public.rider_ratings;
    create policy "rider_ratings — customer insert" on public.rider_ratings for insert
      with check (
        customer_id = auth.uid()
        and exists (
          select 1 from public.orders o
            join public.deliveries d on d.order_id = o.id
           where o.id = rider_ratings.order_id
             and o.customer_id = auth.uid()
             and o.status = 'delivered'
             and d.driver_id = rider_ratings.driver_id
        )
      );
    drop policy if exists "rider_ratings — read" on public.rider_ratings;
    create policy "rider_ratings — read" on public.rider_ratings for select
      using (customer_id = auth.uid() or public.is_admin());
    revoke all on public.rider_ratings from anon, authenticated;
    grant select (id, order_id, driver_id, rating, comment, created_at) on public.rider_ratings to authenticated;
    grant insert on public.rider_ratings to authenticated;
    grant select on public.my_rider_ratings to authenticated;
    revoke all on public.my_rider_ratings from anon;
    grant select, insert, update, delete on public.rider_ratings to service_role;
    commit;`;
    const a = await fresh(); await a.exec(M0084); await a.exec(M0150_COPY);
    const b = await fresh(); await b.exec(M0150_COPY); await b.exec(M0084);
    const c = await fresh(); await c.exec(M0084);
    const sa = await snapshot(a), sb = await snapshot(b), sc = await snapshot(c);
    ok("0084 then 0150 leaves exactly what 0084 alone leaves", sa === sc);
    ok("0150 then 0084 leaves exactly what 0084 alone leaves", sb === sc);
    ok("...so the order they land in does not matter", sa === sb);
    ok("the view is still read-only for a rider after 0150 then 0084",
      denied(await as(b, "authenticated", D1, "delete from public.my_rider_ratings")));
    // Documented difference: 0150 alone leaves the view's default write privileges on authenticated.
    const only150 = await fresh(); await only150.exec(M0150_COPY);
    const leak = await as(only150, "authenticated", D1, "delete from public.my_rider_ratings");
    console.log(`  note  0150 alone: a rider deleting through the view is ${leak.ok ? "ALLOWED (0150 lacks the revoke; 0084 adds it)" : "refused"}`);

    // ── rollback ──
    console.log("\n── rollback ──");
    let rolled = true;
    try { await db.exec(ROLLBACK); } catch (e) { rolled = false; console.log(`rollback failed: ${e.message}`); }
    ok("the rollback block runs to completion", rolled);
    ok("...and removes the table, the view and both settings columns",
      (await one(db, `select to_regclass('public.rider_ratings') is null and to_regclass('public.my_rider_ratings') is null
                        and not exists (select 1 from information_schema.columns where table_name = 'platform_settings'
                                          and column_name in ('rider_daily_target','rider_weekly_target')) as gone`)).gone === true);
    let reapplied = true; try { await db.exec(M0084); } catch (e) { reapplied = false; console.log(e.message); }
    ok("...and 0084 applies again after the rollback", reapplied);
  }

  return { passed, failed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { passed, failed } = await proof();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
