// Proves migration 0194 on the real migration chain (chain-lib.mjs): the platform cash
// limit and cash switch, judged by the guard every cash order passes when it leaves
// 'placed', with a customer and a vendor acting through their own sessions.
//
//   1. the stricter of the shop limit and the platform limit applies; a shop value of
//      0 means the platform limit; a platform value of 0 means no platform limit;
//   2. an order of exactly the limit is still allowed;
//   3. cancelling an over-limit order is not refused;
//   4. cash off refuses cash; both methods off is refused by the database;
//   5. a customer can read both settings and cannot change them.
//
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0194.mjs
import { freshChain, one } from "./chain-lib.mjs";

let fails = 0;
const ok = (c, m, extra = "") => {
  if (c) console.log(`ok   ${m}`);
  else {
    fails++;
    console.log(`FAIL ${m}${extra ? " — " + extra : ""}`);
  }
};

const { db, err } = await freshChain();
if (err) {
  console.log(`FAIL the migration chain does not apply: ${err}`);
  process.exit(1);
}

const CUST = "00000000-0000-4000-8000-0000000019c2";
const VEND = "00000000-0000-4000-8000-0000000019e2";
const SHOP = "00000000-0000-4000-8000-0000000019d2";
const DISH = "00000000-0000-4000-8000-0000000019f2";
const IN_TOWN = `'{"label":"Home","line":"1 Main Rd","lat":21.72,"lng":81.54}'::jsonb`;

async function as(role, uid, sql) {
  const claims = role === "authenticated" ? { role: "authenticated", sub: uid } : {};
  await db.exec(`reset role; select set_config('test.uid','${uid ?? ""}',false); select set_config('test.jwt','${JSON.stringify(claims)}',false); set role ${role};`);
  try {
    return { ok: true, rows: (await db.query(sql)).rows };
  } catch (e) {
    return { ok: false, msg: String(e.message) };
  } finally {
    await db.exec(`reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);`);
  }
}

await db.exec(`
  select set_config('test.jwt','{"role":"service_role"}',false);
  insert into auth.users (id, email) values ('${CUST}','c94@x.test'), ('${VEND}','v94@x.test');
  insert into public.profiles (id, role) values ('${CUST}','customer'), ('${VEND}','restaurant')
    on conflict (id) do update set role = excluded.role;
  insert into public.platform_settings (id, delivery_fee, tax_rate, free_delivery_threshold, min_order, accepting_orders, delivery_radius_km)
    values (true, 0, 0, 0, 0, true, 8)
    on conflict (id) do update set delivery_fee = 0, tax_rate = 0, free_delivery_threshold = 0, min_order = 0,
      accepting_orders = true, delivery_radius_km = 8;
  insert into public.restaurants (id, slug, name, owner_id, approved, is_open, lat, lng, accept_cod, cod_max_order)
    values ('${SHOP}', 'test-shop-94', 'Test Shop 94', '${VEND}', true, true, 21.71, 81.53, true, 0);
  insert into public.menu_items (id, restaurant_id, name, price, available)
    values ('${DISH}', '${SHOP}', 'Thali', 100, true);
  select set_config('test.jwt','',false);
`);
await db.exec(`
  create or replace function public.restaurant_status_now(p uuid, p_at timestamptz default now()) returns text
    language sql stable as $$ select 'open' $$;
  update public.menu_items set approval_status = 'approved' where id = '${DISH}';
`).catch(() => {});

/** A cash order of `qty` x ₹100, placed by the customer. Fee and tax are 0. */
async function order(qty) {
  const o = await as("authenticated", CUST, `insert into public.orders (customer_id, restaurant_id, address, payment_method)
    values ('${CUST}', '${SHOP}', ${IN_TOWN}, 'cod') returning id`);
  if (!o.ok) throw new Error(`insert: ${o.msg}`);
  const id = o.rows[0].id;
  const it = await as("authenticated", CUST, `insert into public.order_items (order_id, menu_item_id, name, qty, price) values ('${id}', '${DISH}', 'x', ${qty}, 1)`);
  if (!it.ok) throw new Error(`items: ${it.msg}`);
  return id;
}
const accept = (id) => as("authenticated", VEND, `update public.orders set status = 'kitchen' where id = '${id}'`);
const limits = (shop, platform) =>
  db.exec(`select set_config('test.jwt','{"role":"service_role"}',false);
    update public.restaurants set cod_max_order = ${shop} where id = '${SHOP}';
    update public.platform_settings set cash_limit_per_order = ${platform};
    select set_config('test.jwt','',false);`);

// ---------- 1. the stricter applies ----------
{
  await limits(0, 0);
  let r = await accept(await order(50));
  ok(r.ok, "no limit anywhere: a ₹5,000 cash order goes to the kitchen", r.msg);

  await limits(0, 300);
  r = await accept(await order(4));
  ok(!r.ok && /over the cash limit/.test(r.msg), "shop 0, platform ₹300: ₹400 in cash is refused (shop 0 uses the platform limit)", r.msg ?? "accepted");
  r = await accept(await order(3));
  ok(r.ok, "shop 0, platform ₹300: exactly ₹300 is still allowed", r.msg);

  await limits(500, 0);
  r = await accept(await order(6));
  ok(!r.ok, "shop ₹500, platform 0: ₹600 is refused (the shop's own limit stays)", r.msg ?? "accepted");
  r = await accept(await order(5));
  ok(r.ok, "shop ₹500, platform 0: ₹500 is allowed", r.msg);

  await limits(500, 300);
  r = await accept(await order(4));
  ok(!r.ok, "shop ₹500, platform ₹300: ₹400 is refused (platform is stricter)", r.msg ?? "accepted");

  await limits(200, 300);
  r = await accept(await order(3));
  ok(!r.ok, "shop ₹200, platform ₹300: ₹300 is refused (shop is stricter)", r.msg ?? "accepted");
  r = await accept(await order(2));
  ok(r.ok, "shop ₹200, platform ₹300: ₹200 is allowed", r.msg);
}

// ---------- 2. what the guard leaves alone ----------
{
  await limits(0, 300);
  const big = await order(9);
  const c = await as("authenticated", VEND, `update public.orders set status = 'cancelled', cancellation_reason = 'over limit' where id = '${big}'`);
  ok(c.ok, "an over-limit cash order can still be cancelled", c.msg);
}

// ---------- 3. the cash switch ----------
{
  const bothOff = await db.exec(`update public.platform_settings set feature_cash_payment = false, feature_online_payment = false`)
    .then(() => ({ ok: true }), (e) => ({ ok: false, msg: String(e.message) }));
  ok(!bothOff.ok && /platform_settings_a_payment_method/.test(bothOff.msg), "both methods off is refused by the database", bothOff.msg ?? "accepted");

  await limits(0, 0);
  const placedBefore = await order(1);
  await db.exec(`update public.platform_settings set feature_online_payment = true, feature_cash_payment = false`);
  const r = await accept(placedBefore);
  ok(!r.ok && /switched off/.test(r.msg), "cash off: a cash order cannot go to the kitchen", r.msg ?? "accepted");
  await db.exec(`update public.platform_settings set feature_cash_payment = true, feature_online_payment = false`);
  const again = await accept(placedBefore);
  ok(again.ok, "cash back on: the same order goes through", again.msg);
}

// ---------- 4. who can read and change them ----------
{
  await limits(0, 300);
  const read = await as("anon", null, `select cash_limit_per_order, feature_cash_payment from public.platform_settings`);
  ok(read.ok && read.rows[0].cash_limit_per_order === 300, "a signed-out customer can read the limit for checkout", read.msg);
  await as("authenticated", CUST, `update public.platform_settings set cash_limit_per_order = 0`);
  const [s] = await one(db, `select cash_limit_per_order from public.platform_settings`);
  ok(s.cash_limit_per_order === 300, "a customer cannot change the limit", JSON.stringify(s));
  const neg = await db.exec(`update public.platform_settings set cash_limit_per_order = -1`).then(() => ({ ok: true }), () => ({ ok: false }));
  ok(!neg.ok, "a negative limit is refused");
}

await db.close();
console.log(fails ? `\n${fails} check(s) failed` : "\nAll 0194 checks passed.");
process.exit(fails ? 1 : 0);
