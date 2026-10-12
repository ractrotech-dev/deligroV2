// Runs the migration in an in-process Postgres (PGlite) with stubbed Supabase auth helpers.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/<file>
// Proves the trigger / policy / grant logic; it does not replace running the migration on staging.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/0056_review_refund_coupon_guards.sql", import.meta.url), "utf8");
const db = new PGlite();

await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
  create type refund_status as enum ('pending','approved','rejected');

  create table public.profiles (id uuid primary key, role text not null, phone text, wallet_balance numeric(10,2) not null default 0);
  create table public.restaurants (id uuid primary key, owner_id uuid, name text, approved boolean default true, status text default 'live',
    commission_pct numeric, accept_cod boolean default true, accept_online boolean default true, cod_max_order numeric, other_charges_per_order numeric,
    settlement_cycle text, rating numeric default 0, rating_count int default 0, rating_sum int default 0, promoted boolean default false,
    sort_position smallint, owner_phone_verified boolean default false);
  create table public.orders (id uuid primary key, customer_id uuid, restaurant_id uuid, status text default 'placed',
    total numeric default 0, discount numeric default 0, coupon_code text, discount_funded_by text);
  create table public.order_items (id uuid primary key default gen_random_uuid(), order_id uuid, qty int, price numeric);
  create table public.reviews (id uuid primary key default gen_random_uuid(), user_id uuid, order_id uuid, restaurant_id uuid,
    rating int, comment text, status text default 'published', created_at timestamptz default now(), edited_at timestamptz,
    food_quality int, packaging int, delivery_experience int, value_for_money int, photos text[]);
  create table public.review_replies (id uuid primary key default gen_random_uuid(), review_id uuid, author_id uuid, reply_text text, edited_at timestamptz, removed_at timestamptz);
  create table public.refunds (id uuid primary key default gen_random_uuid(), order_id uuid, amount int, reason text,
    status refund_status not null default 'pending', decided_by uuid, requested_by uuid, origin text not null default 'customer',
    provider_refund_id text, settled_at timestamptz);
  create table public.coupons (code text primary key, funded_by text default 'platform');
  create table public.coupon_redemptions (code text, order_id uuid unique, customer_id uuid, discount int);

  create function public.review_window_open(oid uuid) returns boolean language sql stable as $$ select true $$;
  create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;
  create function public.price_coupon(c public.coupons, subtotal integer, rid uuid, customer uuid) returns jsonb language sql as $$ select jsonb_build_object('ok', true, 'discount', 10) $$;
  create function public.recompute_order_total(oid uuid) returns void language sql as $$ select 1 $$;

  -- the 0034 definer lock this migration replaces
  create function public.lock_restaurant_privileged_fields() returns trigger language plpgsql security definer set search_path = public as $$ begin return new; end $$;
  create trigger lock_restaurant_fields before update on public.restaurants for each row execute function public.lock_restaurant_privileged_fields();

  -- reviews_apply_rating: SECURITY DEFINER, updates restaurants inside a customer's request
  create function public.reviews_apply_rating() returns trigger language plpgsql security definer set search_path = public as $$
    begin update public.restaurants set rating_sum = rating_sum + new.rating, rating_count = rating_count + 1, rating = 4 where id = new.restaurant_id; return null; end $$;
  create trigger reviews_rating_trg after insert on public.reviews for each row execute function public.reviews_apply_rating();

  create function public.guard_profile_phone() returns trigger language plpgsql as $$ begin return new; end $$;
  create trigger profiles_guard_phone before update on public.profiles for each row execute function public.guard_profile_phone();

  alter table public.reviews enable row level security;
  alter table public.review_replies enable row level security;
  alter table public.refunds enable row level security;
  alter table public.restaurants enable row level security;
  alter table public.profiles enable row level security;
  create policy "reviews — author edit own" on public.reviews for update using (user_id = auth.uid()) with check (user_id = auth.uid());
  create policy "reviews — read" on public.reviews for select using (true);
  create policy "replies — all" on public.review_replies for all using (true) with check (true);
  create policy "refunds — customer request" on public.refunds for insert with check (status = 'pending');
  create policy "refunds — read" on public.refunds for select using (true);
  create policy "restaurants — owner update" on public.restaurants for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
  create policy "restaurants — read" on public.restaurants for select using (true);
  create policy "profiles — own" on public.profiles for all using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

  -- Supabase's default: new tables are fully granted to authenticated.
  create role authenticated; create role anon; create role service_role;
  create role svc bypassrls;
  grant usage on schema public, auth to authenticated, svc;
  grant all on all tables in schema public to authenticated, svc;
  grant execute on all functions in schema public to authenticated, svc;
  grant execute on all functions in schema auth to authenticated, svc;
`);

await db.exec(MIGRATION);

const C = "00000000-0000-0000-0000-0000000000c1", V = "00000000-0000-0000-0000-0000000000a1", A = "00000000-0000-0000-0000-0000000000d1";
const R1 = "00000000-0000-0000-0000-0000000000f1", R2 = "00000000-0000-0000-0000-0000000000f2";
const O1 = "00000000-0000-0000-0000-000000000001";
await db.exec(`
  insert into public.profiles (id, role) values ('${C}','customer'),('${V}','customer'),('${A}','admin');
  insert into public.restaurants (id, owner_id, name) values ('${R1}','${V}','Mine'),('${R2}','${A}','Competitor');
  insert into public.orders (id, customer_id, restaurant_id, status) values ('${O1}','${C}','${R1}','delivered');
`);

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };
async function as(uid, role, sql) {
  const r = role === "service_role" ? "svc" : "authenticated";
  await db.exec(`set role ${r}; select set_config('test.uid','${uid ?? ""}',false), set_config('test.jwt','${role ? JSON.stringify({ role }) : ""}',false);`);
  try {
    const q = /^\s*(update|insert|delete)/i.test(sql) ? await db.query(sql + " returning 1 as x") : (await db.exec(sql), { rows: [1] });
    return { ok: q.rows.length > 0, msg: q.rows.length ? "" : "0 rows" };
  } catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec("reset role"); }
}

console.log("\n── reviews ──");
let r = await as(C, "authenticated", `insert into public.reviews (user_id, order_id, restaurant_id, rating) values ('${C}','${O1}','${R2}',1)`);
ok("review against a shop the order was NOT from is refused", !r.ok);
await db.exec("delete from public.reviews");
r = await as(C, "authenticated", `insert into public.reviews (user_id, order_id, restaurant_id, rating) values ('${C}','${O1}','${R1}',5)`);
ok("review for the order's own shop is accepted", r.ok);
ok("...and the SECURITY DEFINER rating trigger could still update restaurants", (await db.query(`select rating_count from public.restaurants where id='${R1}'`)).rows[0].rating_count === 1);
r = await as(C, "authenticated", `update public.reviews set comment = 'edited' where user_id = '${C}'`);
ok("author can edit comment", r.ok);
r = await as(C, "authenticated", `update public.reviews set restaurant_id = '${R2}' where user_id = '${C}'`);
ok("author cannot re-point restaurant_id", !r.ok && /permission denied/.test(r.msg));
r = await as(C, "authenticated", `update public.reviews set created_at = now() + interval '1 year' where user_id = '${C}'`);
ok("author cannot reset created_at", !r.ok && /permission denied/.test(r.msg));
r = await as(C, "authenticated", `update public.reviews set order_id = gen_random_uuid() where user_id = '${C}'`);
ok("author cannot change order_id", !r.ok && /permission denied/.test(r.msg));
await db.exec(`insert into public.review_replies (review_id, author_id, reply_text) select id, '${V}', 'thanks' from public.reviews limit 1`);
r = await as(V, "authenticated", `update public.review_replies set reply_text = 'ok'`);
ok("vendor can edit reply text", r.ok);
r = await as(V, "authenticated", `update public.review_replies set review_id = gen_random_uuid()`);
ok("vendor cannot move a reply to another review", !r.ok && /permission denied/.test(r.msg));

console.log("\n── refunds ──");
r = await as(C, "authenticated", `insert into public.refunds (order_id, amount, origin, requested_by, decided_by, provider_refund_id, settled_at) values ('${O1}', 50, 'admin', '${A}', '${A}', 'rfnd_squat', now())`);
ok("customer insert is accepted", r.ok);
const row = (await db.query(`select origin, requested_by, decided_by, provider_refund_id, settled_at, status from public.refunds where order_id='${O1}'`)).rows[0];
ok("origin forced to customer", row.origin === "customer");
ok("requested_by forced to the caller", row.requested_by === C);
ok("decided_by, provider_refund_id, settled_at cleared", row.decided_by === null && row.provider_refund_id === null && row.settled_at === null);
await db.exec("delete from public.refunds");
r = await as(null, "service_role", `insert into public.refunds (order_id, amount, origin, provider_refund_id) values ('${O1}', 50, 'system', 'rfnd_1')`);
ok("service role keeps its own provenance", r.ok && (await db.query(`select origin from public.refunds`)).rows[0].origin === "system");
await db.exec(`update public.refunds set status = 'approved'`);
r = await as(null, "service_role", `insert into public.refunds (order_id, amount, status) values ('${O1}', 50, 'approved')`);
ok("a second APPROVED refund for one order is refused", !r.ok && /unique|duplicate/i.test(r.msg));
r = await as(null, "service_role", `insert into public.refunds (order_id, amount, status) values ('${O1}', 50, 'pending')`);
ok("a pending one beside an approved one is still allowed", r.ok);

console.log("\n── restaurants ──");
r = await as(V, "authenticated", `update public.restaurants set name = 'Renamed' where id = '${R1}'`);
ok("vendor can rename own shop", r.ok);
for (const [col, val] of [["rating", "5"], ["rating_count", "999"], ["rating_sum", "999"], ["promoted", "true"], ["sort_position", "1"], ["owner_phone_verified", "true"], ["commission_pct", "0"], ["approved", "false"], ["accept_cod", "false"]]) {
  r = await as(V, "authenticated", `update public.restaurants set ${col} = ${val} where id = '${R1}'`);
  ok(`vendor cannot set ${col}`, !r.ok && /admin-only/.test(r.msg));
}
r = await as(A, "authenticated", `update public.restaurants set promoted = true, sort_position = 2 where id = '${R2}'`);
ok("admin can set promoted/sort_position", r.ok);

console.log("\n── wallet ──");
r = await as(C, "authenticated", `update public.profiles set wallet_balance = 500 where id = '${C}'`);
ok("customer cannot raise own wallet", !r.ok && /wallet_balance/.test(r.msg));
r = await as(A, "authenticated", `update public.profiles set wallet_balance = 500 where id = '${C}'`);
ok("admin can adjust a wallet", r.ok);
r = await as(null, "service_role", `update public.profiles set wallet_balance = -1 where id = '${C}'`);
ok("negative balance is refused even for the service role", !r.ok && /nonneg/.test(r.msg));

console.log("\n── coupon function ──");
await db.exec(`insert into public.coupons (code) values ('SAVE10'); update public.orders set status='placed', coupon_code=null where id='${O1}';`);
let call = await db.query(`select public.apply_coupon_to_order('${O1}','save10') as res`).catch((e) => ({ err: e.message }));
ok("apply_coupon_to_order compiles and runs with the lock line", call.rows?.[0]?.res?.ok === true || (console.log("   ", call.err ?? JSON.stringify(call.rows)), false));
const src = (await db.query(`select prosrc from pg_proc where proname='apply_coupon_to_order'`)).rows[0].prosrc;
ok("the lock precedes price_coupon", src.indexOf("pg_advisory_xact_lock") > 0 && src.indexOf("pg_advisory_xact_lock") < src.indexOf("priced := public.price_coupon("));

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
