// Runs migration 0176 (manager menu sheet and photo replace) in PGlite on top of
// manager-base.mjs + 0142 + 0146, with the 0001/0062 menu pieces they extend.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0176.mjs
// Proves zone scoping, the restricted-category hold, per-row errors, replay,
// the change log and audit, the self-approval block and the photo replace.
import { managerBase, readMigration, id, IDS } from "./manager-base.mjs";

const MIGRATION = readMigration("0146_manager_products.sql");
const M0176 = readMigration("0176_manager_menu_sheet_and_photo.sql");
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
    sold_out_by_stock boolean not null default false, available_days smallint[], available_from time, available_to time,
    popular boolean not null default false, bestseller boolean not null default false, external_id text, image_library_id uuid);
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
// ops_product_sales / ops_product_daily read 0144's ops_counts_as_order, which this
// base does not load; their sums are proven by scripts/qa/ops-sql-parity.ts.
await db.exec("set check_function_bodies = off");
await db.exec(MIGRATION);
await db.exec(M0176);
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
const dish = async (iid) => one(`select name, price, pending_price, discount_price, approval_status, submitted_by, image_url, image_library_id, stock_qty, available from public.menu_items where id = '${iid}'`);
const audits = async (action) => (await db.query(`select actor_id, entity_id, before, after from public.ops_audit_log where action = '${action}' order by id`)).rows;
const apply = (actor, rest, updates, inserts, cid, file = "menu.xlsx") =>
  srv(`select public.ops_bulk_menu_apply('${actor}','${rest}','${JSON.stringify(updates)}'::jsonb,'${JSON.stringify(inserts)}'::jsonb,'${file}','${cid}') as x`);
const countDishes = async (rest) => (await one(`select count(*)::int as n from public.menu_items where restaurant_id = '${rest}'`)).n;

await srv(`select public.ops_set_restricted_category('${A}','Liquor',true,'Licence needed','rc1')`);
const P1 = id(801), L1 = id(802), X2 = id(803);
await db.exec(`
  insert into public.menu_items (id, restaurant_id, name, price, category) values
    ('${P1}','${R1}','Paneer tikka',220,'Starters'),
    ('${L1}','${R1}','Beer',200,'Liquor'),
    ('${X2}','${R2}','Dal makhani',180,'Mains');
`);

console.log("\n── bulk menu ──");
let before = await countDishes(R1);
let r = await apply(MB, R1, [], [{ name: "Naan", price: 40, category: "Breads" }], "b0");
ok("bulk: MB on R1 is refused (forbidden) and writes nothing",
  fails(r, /forbidden/) && (await countDishes(R1)) === before && (await audits("product.bulk_menu")).length === 0, r.msg);

r = await apply(M, R1, [
  { id: L1, patch: { price: 260 } },
  { id: P1, patch: { price: 240, available: false } },
  { id: X2, patch: { price: 1 } },
  { id: P1, patch: { stock_qty: 5 } },
], [
  { name: "Naan", price: 40, category: "Breads", veg: true },
  { name: "Whisky", price: 500, category: "Liquor" },
], "b1");
const x = r.rows?.[0]?.x ?? {};
ok("bulk: the call returns its counts", r.ok && x.created === 2 && x.updated === 2 && x.held === 2, r.msg ?? JSON.stringify(x));
const naan = (await one(`select id, approval_status, submitted_by from public.menu_items where name = 'Naan'`)) ?? {};
ok("bulk: insert of a plain dish is approved and live", naan.approval_status === "approved" && naan.submitted_by === null, JSON.stringify(naan));
const whisky = (await one(`select id, approval_status, submitted_by from public.menu_items where name = 'Whisky'`)) ?? {};
ok("bulk: insert into a restricted category is pending with submitted_by = M", whisky.approval_status === "pending" && whisky.submitted_by === M, JSON.stringify(whisky));
let d = await dish(L1);
ok("bulk: price change on a live restricted dish parks it", d.price === 200 && d.pending_price === 260 && d.approval_status === "pending" && d.submitted_by === M, JSON.stringify(d));
d = await dish(P1);
ok("bulk: price change on a plain dish applies at once", d.price === 240 && d.available === false && d.approval_status === "approved", JSON.stringify(d));
ok("bulk: an update whose id belongs to R2 is an error row and R2's dish is unchanged",
  (x.errors ?? []).some((e) => e.kind === "update" && e.index === 2) && (await dish(X2)).price === 180, JSON.stringify(x.errors));
ok("bulk: a patch key outside the allowed list (stock_qty) is an error row",
  (x.errors ?? []).some((e) => e.kind === "update" && e.index === 3) && (await dish(P1)).stock_qty === null, JSON.stringify(x.errors));
let ch = await changes(P1, "price");
ok("bulk: changes are logged in menu_item_changes with source 'ops' and actor M",
  ch.length === 1 && ch[0].source === "ops" && ch[0].actor_id === M && ch[0].new_value === "240", JSON.stringify(ch));
let au = await audits("product.bulk_menu");
ok("bulk: one product.bulk_menu audit row with created/updated/filename in after",
  au.length === 1 && au[0].actor_id === M && au[0].entity_id === R1 && au[0].after.created === 2 && au[0].after.updated === 2 && au[0].after.filename === "menu.xlsx", JSON.stringify(au));
before = await countDishes(R1);
r = await apply(M, R1, [], [{ name: "Naan", price: 40, category: "Breads" }, { name: "Whisky", price: 500, category: "Liquor" }], "b1");
ok("bulk: replay with the same client action id creates nothing new",
  r.ok && (await countDishes(R1)) === before && r.rows[0].x.created === 2 && (await audits("product.bulk_menu")).length === 1, r.msg);
r = await apply(M, R1, [], [{ name: "Roti", price: 20, approval_status: "approved" }, { name: "", price: 20 }], "b2");
ok("bulk: an insert with a key outside the list or no name is an error row, the call still succeeds",
  r.ok && r.rows[0].x.created === 0 && r.rows[0].x.errors.length === 2, r.msg ?? JSON.stringify(r.rows?.[0]?.x));
r = await apply(M, R1, [{ id: P1, patch: { category: "Liquor" } }], [], "b3");
d = await dish(P1);
ok("bulk: moving a plain dish into a restricted category holds it", r.ok && d.approval_status === "pending" && r.rows[0].x.held === 1, JSON.stringify(d));
r = await as("authenticated", V, `update public.menu_items set submitted_by = null, name = 'Paneer tikka!' where id = '${P1}'`);
d = await dish(P1);
ok("bulk: the vendor cannot set or clear submitted_by", r.ok && d.submitted_by === M && d.name === "Paneer tikka!", r.msg ?? JSON.stringify(d));
const VP = id(804);
await as("authenticated", V, `insert into public.menu_items (id, restaurant_id, name, price, category) values ('${VP}','${R1}','Gin',400,'Liquor')`);
r = await apply(M, R1, [{ id: VP, patch: { price: 350, description: "Dry gin" } }], [], "b4");
d = await dish(VP);
ok("bulk: editing a vendor's pending restricted dish makes the manager its submitter",
  r.ok && d.approval_status === "pending" && d.price === 350 && d.submitted_by === M, r.msg ?? JSON.stringify(d));
ok("bulk: ...so that manager cannot then approve it",
  fails(await srv(`select public.ops_decide_listing('${M}','${VP}','approve','Fine','s0')`), /self_approval/));

console.log("\n── self approval ──");
ok("decide: M approving a dish M submitted is refused (self_approval)",
  fails(await srv(`select public.ops_decide_listing('${M}','${whisky.id}','approve','Fine','s1')`), /self_approval/));
r = await srv(`select public.ops_decide_listing('${A}','${whisky.id}','approve','Licence seen','s2')`);
d = await dish(whisky.id);
ok("decide: A (admin) approving it succeeds and clears submitted_by", r.ok && d.approval_status === "approved" && d.submitted_by === null, r.msg ?? JSON.stringify(d));
r = await srv(`select public.ops_decide_listing('${M}','${L1}','reject','Too steep','s3')`);
ok("decide: M may still reject their own held change (it clears submitted_by)", r.ok && (await dish(L1)).submitted_by === null, r.msg);

console.log("\n── photo replace ──");
const IMG = id(820);
await as("authenticated", V, `insert into public.menu_items (id, restaurant_id, name, price, category, image_url) values ('${IMG}','${R1}','Lassi',60,'Drinks','https://x/lassi1.jpg')`);
const queue = async () => (await srv(`select * from public.ops_image_review_queue(array['${ZA}']::uuid[], null, null, 50)`)).rows ?? [];
const CH1 = (await queue()).find((q) => q.menu_item_id === IMG).change_id;
await srv(`select public.ops_review_listing_image('${M}',${CH1},'flag','wrong_image','Shows a different dish','pr0')`);
const replace = (actor, url, lib, src, change, cid) =>
  srv(`select public.ops_replace_listing_photo('${actor}','${IMG}',${url === null ? "null" : `'${url}'`},${lib ? `'${lib}'` : "null"},'${src}',${change ?? "null"},'${cid}') as x`);
ok("photo: MB replacing R1's dish photo is refused", fails(await replace(MB, "https://cdn/x.jpg", null, "upload", null, "p0"), /forbidden/));
ok("photo: p_source 'other' is invalid_transition", fails(await replace(M, "https://cdn/x.jpg", null, "other", null, "p1"), /invalid_transition/));
ok("photo: library source without a library id is invalid_transition", fails(await replace(M, "https://cdn/x.jpg", null, "library", null, "p2"), /invalid_transition/));
ok("photo: a non-https url is invalid_transition", fails(await replace(M, "javascript:alert(1)", null, "upload", null, "p3"), /invalid_transition/));

// The vendor changes the photo again after the manager opened the first review card.
await as("authenticated", V, `update public.menu_items set image_url = 'https://x/lassi2.jpg' where id = '${IMG}'`);
const CH2 = (await queue()).find((q) => q.menu_item_id === IMG).change_id;
r = await replace(M, "https://cdn/menu-images/r1/ops-1.jpg", null, "upload", CH2, "p4");
d = await dish(IMG);
ok("photo: M replaces from upload → image_url set", r.ok && d.image_url === "https://cdn/menu-images/r1/ops-1.jpg" && d.image_library_id === null, r.msg ?? JSON.stringify(d));
ch = await changes(IMG, "image_url");
ok("photo: ...change logged source 'ops' by M", ch.at(-1).source === "ops" && ch.at(-1).actor_id === M, JSON.stringify(ch));
ok("photo: ...not in ops_image_review_queue", !(await queue()).some((q) => q.menu_item_id === IMG));
ok("photo: with p_review_change the queued review gets an 'ok' row with note 'replaced'",
  (await one(`select outcome, note from public.listing_image_reviews where change_id = ${CH2}`))?.note === "replaced");
ok("photo: an open wrong_image flag on the dish is resolved", r.rows?.[0]?.x?.resolved_flags === 1
  && (await one(`select count(*)::int as n from public.listing_flags where menu_item_id = '${IMG}' and status = 'open'`)).n === 0, JSON.stringify(r.rows?.[0]?.x));
au = await audits("product.photo_replace");
ok("photo: one product.photo_replace audit row with before/after image_url and source",
  au.length === 1 && au[0].before.imageUrl === "https://x/lassi2.jpg" && au[0].after.imageUrl === "https://cdn/menu-images/r1/ops-1.jpg" && au[0].after.source === "upload", JSON.stringify(au));
r = await replace(M, "https://cdn/menu-images/r1/ops-1.jpg", null, "upload", CH2, "p4");
ok("photo: a replay returns the same answer and logs nothing new", r.ok && r.rows[0].x.resolved_flags === 1 && (await audits("product.photo_replace")).length === 1, r.msg);
r = await replace(M, "https://images.unsplash.com/lassi.jpg", id(990), "library", CH1, "p5");
d = await dish(IMG);
ok("photo: a stale p_review_change still replaces and does not raise", r.ok && d.image_url === "https://images.unsplash.com/lassi.jpg", r.msg);
ok("photo: library source sets image_library_id", d.image_library_id === id(990));
ok("a signed-in user cannot call the new RPCs",
  fails(await as("authenticated", M, `select public.ops_bulk_menu_apply('${M}','${R1}','[]','[]',null,'z1')`), /permission denied/)
  && fails(await as("authenticated", M, `select public.ops_replace_listing_photo('${M}','${IMG}','https://a/b.jpg',null,'upload',null,'z2')`), /permission denied/));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
