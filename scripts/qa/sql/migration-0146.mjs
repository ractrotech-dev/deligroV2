// Runs migration 0146 (manager products) in an in-process Postgres (PGlite) on
// top of manager-base.mjs + 0142, with the 0062 menu/stock pieces it extends.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0146.mjs
// Proves moderation (restricted listings, parked prices, hiding), what customers
// can read and order, the change history, flags, stock adjustment and zone
// scoping; it does not replace staging.
import { managerBase, readMigration, id, IDS } from "./manager-base.mjs";

const MIGRATION = readMigration("0146_manager_products.sql");
const { db, ZA, ZB } = await managerBase();
const { A, M, MB, C, V, R1, R2 } = IDS;
await db.exec(readMigration("0142_manager_orders_live.sql"));

// The 0001/0062 menu, stock and order-line pieces 0146 extends (abridged, same shapes).
await db.exec(`
  alter table public.restaurants add column if not exists approved boolean not null default true;
  alter table public.orders add column if not exists payment_status text not null default 'pending';
  create table public.payments (id uuid primary key default gen_random_uuid(), order_id uuid);
  create table public.menu_items (id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references public.restaurants, name text not null, description text,
    price integer not null, discount_price integer, image_url text, category text, veg boolean default true,
    available boolean not null default true, stock_qty integer, low_stock_at integer,
    sold_out_by_stock boolean not null default false, available_days smallint[], available_from time, available_to time);
  alter table public.order_items add column if not exists menu_item_id uuid references public.menu_items, add column if not exists options jsonb;
  create table public.menu_item_variants (id uuid primary key default gen_random_uuid(), menu_item_id uuid, name text, price integer, available boolean default true);
  create table public.menu_item_addon_groups (id uuid primary key default gen_random_uuid(), menu_item_id uuid, name text,
    min_select int default 0, max_select int default 1, sort_order int default 0);
  create table public.menu_item_addons (id uuid primary key default gen_random_uuid(), group_id uuid, name text, price int default 0,
    available boolean default true, sort_order int default 0);
  create function public.restaurant_status_now(p uuid, p_at timestamptz default now()) returns text language sql as $$ select 'open' $$;

  create function public.menu_stock_rules() returns trigger language plpgsql security invoker set search_path = public as $$
  begin
    if new.stock_qty is not null and new.stock_qty = 0 then
      if new.available then new.available := false; new.sold_out_by_stock := true; end if;
    elsif tg_op = 'UPDATE' and old.sold_out_by_stock then
      new.available := true; new.sold_out_by_stock := false;
    end if;
    return new;
  end; $$;
  create trigger menu_items_stock_rules before insert or update of stock_qty on public.menu_items
    for each row execute function public.menu_stock_rules();
  create function public.take_stock() returns trigger language plpgsql security definer set search_path = public as $$
  begin
    update public.menu_items set stock_qty = greatest(0, stock_qty - new.qty) where id = new.menu_item_id and stock_qty is not null;
    return null;
  end; $$;
  create trigger order_items_take_stock after insert on public.order_items for each row execute function public.take_stock();

  alter table public.menu_items enable row level security;
  create policy "menu — read" on public.menu_items for select using (
    exists (select 1 from public.restaurants r where r.id = restaurant_id and r.approved)
    or public.owns_restaurant(restaurant_id) or public.is_admin());
  create policy "menu — owner manage" on public.menu_items for all
    using (public.owns_restaurant(restaurant_id) or public.is_admin())
    with check (public.owns_restaurant(restaurant_id) or public.is_admin());
  alter table public.order_items enable row level security;
  create policy "order_items — customer insert" on public.order_items for insert
    with check (exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));
  create policy "order_items — customer read" on public.order_items for select
    using (exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));
  grant all on all tables in schema public to anon, authenticated, service_role;
`);
await db.exec(MIGRATION);
await db.exec(`
  drop trigger if exists order_items_guard on public.order_items;
  create trigger order_items_guard before insert on public.order_items for each row execute function public.guard_order_item_insert();
  grant select on all tables in schema public to authenticated, anon;
`);

let passed = 0, failed = 0;
const ok = (n, c, extra) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}${!c && extra ? `\n         ${extra}` : ""}`); };
async function as(role, uid, sql) {
  const claims = role === "service_role" ? { role: "service_role" } : {};
  await db.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false); select set_config('test.jwt','${JSON.stringify(claims)}',false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: String(e.message), detail: e.detail }; }
  finally { await db.exec("reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);"); }
}
const fails = (r, re) => !r.ok && re.test(r.msg);
const srv = (sql) => as("service_role", null, sql);
const one = async (sql) => (await db.query(sql)).rows[0];
const item = async (iid) => one(`select price, pending_price, approval_status, hidden_by_ops, hidden_reason, stock_qty, available, sold_out_by_stock from public.menu_items where id = '${iid}'`);
const changes = async (iid, field) => (await db.query(`select source, old_value, new_value, actor_id from public.menu_item_changes where menu_item_id = '${iid}' and field = '${field}' order by id`)).rows;
const custSees = async (iid) => ((await as("authenticated", C, `select id from public.menu_items where id = '${iid}'`)).rows ?? []).length === 1;
const anonSees = async (iid) => ((await as("anon", null, `select id from public.menu_items where id = '${iid}'`)).rows ?? []).length === 1;
let orderN = 0;
async function order(iid) {
  orderN += 1;
  const oid = id(5000 + orderN);
  await db.exec(`insert into public.orders (id, customer_id, restaurant_id, total) values ('${oid}','${C}','${R1}', 0)`);
  return as("authenticated", C, `insert into public.order_items (order_id, name, qty, price, menu_item_id) values ('${oid}','x',1,1,'${iid}') returning price`);
}

console.log("\n── restricted listings ──");
ok("a manager adds a restricted category",
  (await srv(`select public.ops_set_restricted_category('${M}','Liquor',true,'Licence needed','rc1')`)).ok);
const L1 = id(701);
let r = await as("authenticated", V, `insert into public.menu_items (id, restaurant_id, name, price, category) values ('${L1}','${R1}','Beer',200,' liquor ')`);
ok("the owner adds a dish in a restricted category", r.ok, r.msg);
ok("...it is pending", (await item(L1)).approval_status === "pending");
ok("...customers cannot read it", !(await custSees(L1)) && !(await anonSees(L1)));
// The guard reads the dish as the customer, so a dish they cannot see is "not on the menu".
const refused = /not available|not on this restaurant/;
ok("...nor order it", fails(await order(L1), refused));
ok("...the owner still reads it", (await as("authenticated", V, `select id from public.menu_items where id = '${L1}'`)).rows.length === 1);
r = await srv(`select public.ops_decide_listing('${M}','${L1}','approve','Licence seen','d1')`);
ok("the zone manager approves it", r.ok, r.msg);
ok("...now customers read it and can order it", (await custSees(L1)) && (await order(L1)).ok);

r = await as("authenticated", V, `update public.menu_items set price = 250 where id = '${L1}'`);
let it = await item(L1);
ok("a price change on an approved restricted dish is parked", r.ok && it.price === 200 && it.pending_price === 250 && it.approval_status === "pending", JSON.stringify(it));
ok("...the dish stays on sale at the old price", await custSees(L1));
r = await order(L1);
ok("...and orders still go through, priced at 200", r.ok && r.rows[0].price === 200, r.msg);
r = await srv(`select public.ops_decide_listing('${M}','${L1}','approve','New price fine','d2')`);
it = await item(L1);
ok("approval applies the parked price", r.ok && it.price === 250 && it.pending_price === null && it.approval_status === "approved");
await as("authenticated", V, `update public.menu_items set price = 400 where id = '${L1}'`);
ok("rejecting a parked price needs a reason",
  fails(await srv(`select public.ops_decide_listing('${M}','${L1}','reject','','d3')`), /reason_required/));
r = await srv(`select public.ops_decide_listing('${M}','${L1}','reject','Too steep','d4')`);
it = await item(L1);
ok("rejecting it drops the parked price and keeps the dish approved", r.ok && it.price === 250 && it.pending_price === null && it.approval_status === "approved");
ok("deciding an item that is not pending → invalid_transition",
  fails(await srv(`select public.ops_decide_listing('${M}','${L1}','approve','Again','d5')`), /invalid_transition/));

const L2 = id(702);
await as("authenticated", V, `insert into public.menu_items (id, restaurant_id, name, price, category) values ('${L2}','${R1}','Rum',300,'Liquor')`);
r = await srv(`select public.ops_decide_listing('${M}','${L2}','reject','No licence','d6')`);
ok("rejecting a never-approved dish marks it rejected and hidden", r.ok && (await item(L2)).approval_status === "rejected" && !(await custSees(L2)));
await as("authenticated", V, `update public.menu_items set name = 'Dark rum' where id = '${L2}'`);
ok("...the owner editing it resubmits it as pending", (await item(L2)).approval_status === "pending");

const D1 = id(703);
await as("authenticated", V, `insert into public.menu_items (id, restaurant_id, name, price, category) values ('${D1}','${R1}','Dal',120,'Mains')`);
ok("an ordinary dish is approved at once", (await item(D1)).approval_status === "approved" && (await custSees(D1)));
await as("authenticated", V, `update public.menu_items set category = 'Liquor' where id = '${D1}'`);
ok("moving a dish into a restricted category makes it pending and hidden", (await item(D1)).approval_status === "pending" && !(await custSees(D1)));
await srv(`select public.ops_decide_listing('${M}','${D1}','approve','ok fine','d7')`);

console.log("\n── the vendor cannot moderate ──");
await srv(`select public.ops_set_listing_hidden('${M}','${D1}',true,'Wrong photo','h1')`);
ok("hiding needs a reason", fails(await srv(`select public.ops_set_listing_hidden('${M}','${D1}',true,'','h0')`), /reason_required/));
ok("a hidden dish is invisible to customers", !(await custSees(D1)));
ok("...and cannot be ordered", fails(await order(D1), refused));
r = await as("authenticated", V, `select hidden_reason from public.menu_items where id = '${D1}'`);
ok("the owner sees it with the reason", r.ok && r.rows[0]?.hidden_reason === "Wrong photo");
await as("authenticated", V, `update public.menu_items set hidden_by_ops = false, approval_status = 'approved', pending_price = 1 where id = '${D1}'`);
it = await item(D1);
ok("the owner cannot unhide, approve or park a price", it.hidden_by_ops === true && it.pending_price === null);
await srv(`select public.ops_set_listing_hidden('${M}','${D1}',false,'Photo fixed','h2')`);
ok("unhidden by a manager, it is back", await custSees(D1));

console.log("\n── history ──");
const D2 = id(704);
await as("authenticated", V, `insert into public.menu_items (id, restaurant_id, name, price, category, stock_qty) values ('${D2}','${R1}','Roti',10,'Breads',5)`);
await as("authenticated", V, `update public.menu_items set price = 12 where id = '${D2}'`);
let ch = await changes(D2, "price");
ok("an owner's price change → one price row, source vendor", ch.length === 1 && ch[0].source === "vendor" && ch[0].old_value === "10" && ch[0].new_value === "12", JSON.stringify(ch));
r = await srv(`select public.ops_adjust_stock('${M}','${D2}',20,'Recount after delivery','s1')`);
ch = await changes(D2, "stock_qty");
ok("an ops stock adjustment → a stock row, source ops, with the actor", r.ok && ch.length === 1 && ch[0].source === "ops" && ch[0].actor_id === M, JSON.stringify(ch) + r.msg);
await order(D2);
ok("stock taken by an order is not history", (await changes(D2, "stock_qty")).length === 1 && (await item(D2)).stock_qty === 19);
await as("authenticated", V, `update public.menu_items set available = false where id = '${D2}'`);
ch = await changes(D2, "available");
ok("an availability toggle → an available row", ch.length === 1 && ch[0].new_value === "false");
r = await srv(`select public.ops_adjust_stock('${M}','${D2}',0,'Sold out','s2')`);
it = await item(D2);
ok("adjusting stock to 0 → stock 0 (0062's rules then decide availability)", r.ok && it.stock_qty === 0);
ok("a stock adjustment needs a reason", fails(await srv(`select public.ops_adjust_stock('${M}','${D2}',3,'','s3')`), /reason_required/));
ok("negative stock → invalid_transition", fails(await srv(`select public.ops_adjust_stock('${M}','${D2}',-1,'oops x','s4')`), /invalid_transition/));
r = await srv(`select public.ops_adjust_stock('${M}','${D2}',null,'Stop tracking','s5')`);
ok("null stops tracking", r.ok && (await item(D2)).stock_qty === null);
ok("each stock change audited", (await one(`select count(*)::int as n from public.ops_audit_log where action = 'product.stock'`)).n === 3);
ok("nobody signed in can write history directly",
  fails(await as("authenticated", V, `insert into public.menu_item_changes (menu_item_id, restaurant_id, field, source) values ('${D2}','${R1}','price','vendor')`), /permission denied/));

console.log("\n── flags ──");
r = await srv(`select public.ops_flag_listing('${M}','${D2}','wrong_image','Shows a samosa','f1') as f`);
const F1 = r.rows?.[0]?.f.flag_id;
ok("a manager flags a listing", r.ok && !!F1, r.msg);
r = await srv(`select public.ops_flag_listing('${M}','${D2}','wrong_image','Again','f2') as f`);
ok("a second open flag with the same reason returns the same flag", r.ok && r.rows[0].f.flag_id === F1);
ok("a bad reason → invalid_transition", fails(await srv(`select public.ops_flag_listing('${M}','${D2}','ugly',null,'f3')`), /invalid_transition/));
ok("resolving needs a resolution", fails(await srv(`select public.ops_resolve_listing_flag('${M}','${F1}','resolved','','f4')`), /reason_required/));
r = await srv(`select public.ops_resolve_listing_flag('${M}','${F1}','resolved','Vendor replaced the photo','f5')`);
ok("a manager resolves it", r.ok && (await one(`select status from public.listing_flags where id = '${F1}'`)).status === "resolved");
r = await as("authenticated", V, `select id from public.listing_flags`);
ok("the owner reads their shop's flags", r.ok && r.rows.length === 1);
r = await as("authenticated", C, `select id from public.listing_flags`);
ok("a customer reads none", r.ok && r.rows.length === 0);

console.log("\n── zones ──");
const B1 = id(705);
await db.exec(`insert into public.menu_items (id, restaurant_id, name, price) values ('${B1}','${R2}','Poha',40)`);
for (const [name, sql] of [
  ["flag", `select public.ops_flag_listing('${M}','${B1}','other','x','z1')`],
  ["hide", `select public.ops_set_listing_hidden('${M}','${B1}',true,'Not mine','z2')`],
  ["stock", `select public.ops_adjust_stock('${M}','${B1}',5,'Not mine','z3')`],
]) ok(`a zone-A manager cannot ${name} a zone-B dish`, fails(await srv(sql), /forbidden/));
ok("the zone-B manager can", (await srv(`select public.ops_set_listing_hidden('${MB}','${B1}',true,'Check menu','z4')`)).ok);
r = await as("authenticated", M, `select id from public.menu_items`);
ok("a zone-A manager reads zone-A dishes, pending and hidden included, none of zone B",
  r.ok && r.rows.some((x) => x.id === L2) && !r.rows.some((x) => x.id === B1), r.msg);
for (const fn of [`ops_flag_listing('${M}','${D2}','other',null,'q1')`, `ops_set_restricted_category('${M}','x',true,'x y z','q2')`]) {
  ok(`a signed-in user cannot call ${fn.split("(")[0]}`, fails(await as("authenticated", M, `select public.${fn}`), /permission denied/));
}
ok("a customer cannot set restricted categories through the RPC",
  fails(await srv(`select public.ops_set_restricted_category('${C}','Tobacco',true,'x y z','q3')`), /forbidden/));
ok("removing a restricted category", (await srv(`select public.ops_set_restricted_category('${A}','liquor',false,'Licensing ended','rc2')`)).ok
  && (await one(`select count(*)::int as n from public.listing_restricted_categories`)).n === 0);

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
