// Runs migration 0060 in an in-process Postgres (PGlite) on synthetic data at a
// realistic shape and checks that it (a) changes the plans it is meant to change,
// (b) returns exactly what the 0010 popularity function returned, and (c) keeps
// the function's grants.
//
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0060.mjs
// (or PGLITE_PATH=<abs path to a pglite install>/node_modules/@electric-sql/pglite/dist/index.js,
//  to use a copy installed outside the repo and leave the lockfile alone).
//
// Proves plan shape and result equality on synthetic data; it is not a
// substitute for EXPLAIN on staging, where the real row counts decide the plan.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const { PGlite } = await import(
  process.env.PGLITE_PATH ? pathToFileURL(process.env.PGLITE_PATH).href : "@electric-sql/pglite"
);
const MIGRATION = readFileSync(new URL("../../../supabase/migrations/0060_perf_indexes.sql", import.meta.url), "utf8");
const db = new PGlite();

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("Building schema and synthetic data…");
await db.exec(`
  create role anon; create role authenticated;
  create type user_role as enum ('customer','restaurant','driver','admin','manager','developer');
  create type order_status as enum ('placed','kitchen','ready','on_the_way','delivered','cancelled');

  create table public.profiles (id uuid primary key, role user_role not null default 'customer', created_at timestamptz not null default now());
  create table public.restaurants (id uuid primary key);
  create table public.menu_items (id uuid primary key, restaurant_id uuid not null references public.restaurants(id));
  create table public.orders (id uuid primary key, customer_id uuid, restaurant_id uuid not null, status order_status not null, created_at timestamptz not null);
  create table public.order_items (id uuid primary key default gen_random_uuid(), order_id uuid not null, menu_item_id uuid, qty int not null);
  create table public.deliveries (id uuid primary key default gen_random_uuid(), order_id uuid unique, driver_id uuid, cod_collected_at timestamptz, cod_collected_amount numeric);

  -- The final-state indexes these queries can already use (0001, 0010, 0057).
  create index menu_items_restaurant_id_idx on public.menu_items (restaurant_id);
  create index order_items_order_id_idx on public.order_items (order_id);
  create index order_items_menu_item_idx on public.order_items (menu_item_id);
  create index orders_restaurant_status_created_idx on public.orders (restaurant_id, status, created_at desc);
  create index orders_created_at_idx on public.orders (created_at desc);
  create index profiles_customer_created_idx on public.profiles (created_at desc) where role = 'customer';
  create index deliveries_driver_id_idx on public.deliveries (driver_id);

  -- 20k profiles: 150 riders, 10 admins, 5 managers, the rest customers.
  insert into public.profiles (id, role, created_at)
  select gen_random_uuid(),
         (case when g <= 150 then 'driver' when g <= 160 then 'admin' when g <= 165 then 'manager' else 'customer' end)::user_role,
         now() - (g % 700) * interval '1 day'
  from generate_series(1, 20000) g;

  -- 60 restaurants × 50 dishes.
  insert into public.restaurants select gen_random_uuid() from generate_series(1, 60);
  insert into public.menu_items (id, restaurant_id)
  select gen_random_uuid(), r.id from public.restaurants r, generate_series(1, 50);

  -- 120k orders over a year; 8% cancelled.
  insert into public.orders (id, customer_id, restaurant_id, status, created_at)
  select gen_random_uuid(), null,
         (select id from public.restaurants order by id offset (g % 60) limit 1),
         (case when g % 13 = 0 then 'cancelled' else 'delivered' end)::order_status,
         now() - (g % 365) * interval '1 day' - (g % 1440) * interval '1 minute'
  from generate_series(1, 120000) g;

  -- 3 items per order, always from the order's own restaurant (what the 0053
  -- guard enforces).
  insert into public.order_items (order_id, menu_item_id, qty)
  select o.id, mi.id, 1 + (k % 3)
  from public.orders o
  cross join generate_series(0, 2) k
  join lateral (
    select id from public.menu_items m where m.restaurant_id = o.restaurant_id
    order by id offset ((abs(hashtext(o.id::text)) + k * 7) % 50) limit 1
  ) mi on true;

  -- One delivery per order; ~40% cash on delivery, collected.
  insert into public.deliveries (order_id, driver_id, cod_collected_at, cod_collected_amount)
  select o.id, null,
         case when abs(hashtext(o.id::text)) % 5 < 2 then o.created_at + interval '40 minutes' end,
         case when abs(hashtext(o.id::text)) % 5 < 2 then 250 end
  from public.orders o;

  -- The 0010 function, as it is in production today.
  create or replace function public.menu_item_popularity(p_restaurant_id uuid, p_days int default 30)
  returns table (menu_item_id uuid, units bigint) language sql stable security definer set search_path = public as $$
    select oi.menu_item_id, sum(oi.qty)::bigint as units
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join public.menu_items mi on mi.id = oi.menu_item_id
    where mi.restaurant_id = p_restaurant_id
      and o.status <> 'cancelled'
      and o.created_at >= now() - make_interval(days => greatest(p_days, 1))
    group by oi.menu_item_id
    order by units desc, oi.menu_item_id;
  $$;
  revoke all on function public.menu_item_popularity(uuid, int) from public;
  grant execute on function public.menu_item_popularity(uuid, int) to anon, authenticated;

  analyze;
`);

const count = async (sql) => (await db.query(sql)).rows[0].n;
console.log(
  `  profiles ${await count("select count(*)::int n from profiles")}, orders ${await count("select count(*)::int n from orders")}, order_items ${await count("select count(*)::int n from order_items")}, deliveries ${await count("select count(*)::int n from deliveries")}`
);

const R = (await db.query("select id from restaurants order by id limit 1")).rows[0].id;
const today = (await db.query("select (now() - interval '3 days')::date::text d")).rows[0].d;

const POP_OLD_BODY = `
  select oi.menu_item_id, sum(oi.qty)::bigint as units
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.menu_items mi on mi.id = oi.menu_item_id
  where mi.restaurant_id = '${R}'
    and o.status <> 'cancelled'
    and o.created_at >= now() - make_interval(days => 30)
  group by oi.menu_item_id order by units desc, oi.menu_item_id`;
const POP_NEW_BODY = `
  select oi.menu_item_id, sum(oi.qty)::bigint as units
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  join public.menu_items mi on mi.id = oi.menu_item_id
  where o.restaurant_id = '${R}'
    and mi.restaurant_id = '${R}'
    and o.status <> 'cancelled'
    and o.created_at >= now() - make_interval(days => 30)
  group by oi.menu_item_id order by units desc, oi.menu_item_id`;

const QUERIES = {
  "riders (role = 'driver')": `select id from public.profiles where role = 'driver'`,
  "alert recipients (role in admin, manager)": `select id from public.profiles where role in ('admin','manager')`,
  "cash ledger collected today": `select cod_collected_amount from public.deliveries
     where cod_collected_at >= '${today}T00:00:00+05:30' and cod_collected_at <= '${today}T23:59:59.999+05:30'
       and cod_collected_amount is not null`,
};

async function explain(sql) {
  const res = await db.query(`explain (analyze, buffers, format json) ${sql}`);
  const plan = res.rows[0]["QUERY PLAN"][0];
  const nodes = [];
  const walk = (n) => {
    nodes.push(n["Index Name"] ? `${n["Node Type"]} on ${n["Index Name"]}` : n["Node Type"] + (n["Relation Name"] ? ` on ${n["Relation Name"]}` : ""));
    (n.Plans ?? []).forEach(walk);
  };
  walk(plan.Plan);
  const buffers = (plan.Plan["Shared Hit Blocks"] ?? 0) + (plan.Plan["Shared Read Blocks"] ?? 0);
  return { ms: plan["Execution Time"], nodes, buffers };
}

// Median of 5 to keep one slow run from deciding the comparison.
async function timed(sql) {
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await explain(sql));
  runs.sort((a, b) => a.ms - b.ms);
  return runs[2];
}

console.log("\n═══ before 0060 ═══");
const before = {};
for (const [name, sql] of Object.entries(QUERIES)) {
  before[name] = await timed(sql);
  console.log(`  ${name}: ${before[name].ms.toFixed(2)} ms, ${before[name].buffers} buffers — ${before[name].nodes.join(" → ")}`);
}
before.popularity = await timed(POP_OLD_BODY);
console.log(`  popularity (0010 body): ${before.popularity.ms.toFixed(2)} ms, ${before.popularity.buffers} buffers — ${before.popularity.nodes.join(" → ")}`);

const oldResults = new Map();
for (const { id } of (await db.query("select id from restaurants")).rows) {
  oldResults.set(id, JSON.stringify((await db.query("select * from menu_item_popularity($1, 30)", [id])).rows));
}

console.log("\n═══ apply 0060 exactly as written ═══");
await db.exec(MIGRATION);
await db.exec("analyze");
check("migration applies cleanly", true);

console.log("\n═══ after 0060 ═══");
const after = {};
for (const [name, sql] of Object.entries(QUERIES)) {
  after[name] = await timed(sql);
  console.log(`  ${name}: ${after[name].ms.toFixed(2)} ms, ${after[name].buffers} buffers — ${after[name].nodes.join(" → ")}`);
}
after.popularity = await timed(POP_NEW_BODY);
console.log(`  popularity (0060 body): ${after.popularity.ms.toFixed(2)} ms, ${after.popularity.buffers} buffers — ${after.popularity.nodes.join(" → ")}`);

console.log("\n═══ checks ═══");
const uses = (r, idx) => r.nodes.some((n) => n.includes(idx));
check("riders lookup uses profiles_staff_role_idx", uses(after["riders (role = 'driver')"], "profiles_staff_role_idx"));
check(
  "alert-recipient lookup uses profiles_staff_role_idx",
  uses(after["alert recipients (role in admin, manager)"], "profiles_staff_role_idx")
);
check("cash ledger day uses deliveries_cod_collected_at_idx", uses(after["cash ledger collected today"], "deliveries_cod_collected_at_idx"));
check(
  "popularity starts from the restaurant's orders (orders_restaurant_status_created_idx)",
  uses(after.popularity, "orders_restaurant_status_created_idx")
);
for (const name of [...Object.keys(QUERIES), "popularity"]) {
  check(`${name}: reads fewer buffers`, after[name].buffers < before[name].buffers, `${before[name].buffers} → ${after[name].buffers}`);
}

let same = 0;
for (const [id, rows] of oldResults) {
  const now = JSON.stringify((await db.query("select * from menu_item_popularity($1, 30)", [id])).rows);
  if (now === rows) same++;
}
check(`popularity returns identical rows for all ${oldResults.size} restaurants`, same === oldResults.size, `${same}/${oldResults.size}`);

const grants = (
  await db.query(`select grantee from information_schema.routine_privileges
    where routine_name = 'menu_item_popularity' and privilege_type = 'EXECUTE' order by grantee`)
).rows.map((r) => r.grantee);
check("execute granted to anon and authenticated, not PUBLIC", grants.includes("anon") && grants.includes("authenticated") && !grants.includes("PUBLIC"), grants.join(", "));
const secdef = (await db.query("select prosecdef from pg_proc where proname = 'menu_item_popularity'")).rows[0].prosecdef;
check("still SECURITY DEFINER with the same signature", secdef === true);

const sizes = (
  await db.query(`select relname, pg_relation_size(oid) b from pg_class where relname in ('profiles_staff_role_idx','deliveries_cod_collected_at_idx','profiles','deliveries')`)
).rows;
console.log(`\n  sizes: ${sizes.map((s) => `${s.relname} ${(Number(s.b) / 1024).toFixed(0)} KB`).join(", ")}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
