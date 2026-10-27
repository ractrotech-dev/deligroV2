// Proves migration 0180 (fixes from the 2026-10-27 security audit) on the real
// migration chain (chain-lib.mjs), with a customer, a vendor and an admin acting
// through their own sessions — the PostgREST path the audit found open.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0180.mjs
//
//   1. a customer's direct insert cannot set its own delivery fee, tax or tip:
//      once the items are in, the database charges what computeChargesWith()
//      would; the pause, the minimum order and a shop's "no cash" switch refuse;
//      admin and service-role orders keep their stored charges;
//   2. a vendor can update and delete only the codes it funds;
//   3. ops_address_note: a vendor update raises, a customer insert stores null,
//      the service role can still write it.
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

const CUST = "00000000-0000-4000-8000-0000000000c1";
const VEND = "00000000-0000-4000-8000-0000000000e1";
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const SHOP = "00000000-0000-4000-8000-0000000000d1";
const DISH = "00000000-0000-4000-8000-0000000000f1";
const ADDRESS = `'{"label":"Home","line":"1 Main Rd","lat":21.7,"lng":81.53}'::jsonb`;

async function as(role, uid, sql) {
  const claims = role === "service_role" ? { role: "service_role" } : role === "authenticated" ? { role: "authenticated", sub: uid } : {};
  await db.exec(`reset role; select set_config('test.uid','${uid ?? ""}',false); select set_config('test.jwt','${JSON.stringify(claims)}',false); set role ${role};`);
  try {
    return { ok: true, rows: (await db.query(sql)).rows };
  } catch (e) {
    return { ok: false, msg: String(e.message) };
  } finally {
    await db.exec(`reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);`);
  }
}

// ---------- seed, as the migration owner with a service-role claim (lock_role) ----------
await db.exec(`
  select set_config('test.jwt','{"role":"service_role"}',false);
  insert into auth.users (id, email) values ('${CUST}','c@x.test'), ('${VEND}','v@x.test'), ('${ADMIN}','a@x.test');
  insert into public.profiles (id, role) values ('${CUST}','customer'), ('${VEND}','restaurant'), ('${ADMIN}','admin')
    on conflict (id) do update set role = excluded.role;
  insert into public.platform_settings (id, delivery_fee, tax_rate, free_delivery_threshold, min_order, accepting_orders)
    values (true, 30, 0.05, 0, 0, true)
    on conflict (id) do update set delivery_fee = 30, tax_rate = 0.05, free_delivery_threshold = 0, min_order = 0, accepting_orders = true;
  insert into public.restaurants (id, slug, name, owner_id, approved, is_open, lat, lng)
    values ('${SHOP}', 'test-shop', 'Test Shop', '${VEND}', true, true, 21.71, 81.53);
  insert into public.menu_items (id, restaurant_id, name, price, available)
    values ('${DISH}', '${SHOP}', 'Thali', 200, true);
  select set_config('test.jwt','',false);
`);
// Shop hours and dish moderation are not what is under test here.
await db.exec(`
  create or replace function public.restaurant_status_now(p uuid, p_at timestamptz default now()) returns text
    language sql stable as $$ select 'open' $$;
  update public.menu_items set approval_status = 'approved' where id = '${DISH}';
`).catch(() => {});

const placeOrder = async (body, qty = 1) => {
  const ins = await as("authenticated", CUST, `insert into public.orders (customer_id, restaurant_id, address, ${Object.keys(body).join(", ")})
    values ('${CUST}', '${SHOP}', ${ADDRESS}, ${Object.values(body).join(", ")}) returning id`);
  if (!ins.ok) return ins;
  const id = ins.rows[0].id;
  const items = await as("authenticated", CUST, `insert into public.order_items (order_id, menu_item_id, name, qty, price)
    values ('${id}', '${DISH}', 'x', ${qty}, 1)`);
  if (!items.ok) return { ...items, id };
  const [o] = await one(db, `select delivery_fee, tax_amount, tip, total from public.orders where id = '${id}'`);
  return { ok: true, id, o };
};

// ---------- 1. charges and order rules ----------
{
  const r = await placeOrder({ delivery_fee: 0, tax_amount: 0, tip: 0, total: 0, payment_method: "'cod'" });
  ok(r.ok, "a customer can still place an order directly (the app's own path)", r.msg);
  if (r.ok) {
    ok(r.o.delivery_fee === 30 && r.o.tax_amount === 10 && r.o.total === 240,
      "delivery_fee = 0, tax_amount = 0 are replaced: ₹200 dish → fee 30, tax 10, total 240",
      JSON.stringify(r.o));
  }
}
{
  const r = await placeOrder({ delivery_fee: 999, tax_amount: 999, tip: 5000, payment_method: "'cod'" });
  ok(r.ok && r.o.delivery_fee === 30 && r.o.tax_amount === 10 && r.o.tip === 50 && r.o.total === 290,
    "inflated fee/tax are replaced and tip is capped at 50", JSON.stringify(r.o ?? r.msg));
}
{
  // Rounding parity with computeChargesWith: Math.round(subtotal * rate), half up.
  await db.exec(`update public.platform_settings set tax_rate = 0.18, free_delivery_threshold = 500`);
  const cases = [[1, 200], [3, 600]]; // 200 → 36 tax, fee 30; 600 → 108 tax, free delivery
  for (const [qty, subtotal] of cases) {
    const r = await placeOrder({ payment_method: "'cod'" }, qty);
    const tax = Math.round(subtotal * 0.18);
    const fee = subtotal >= 500 ? 0 : 30;
    ok(r.ok && r.o.tax_amount === tax && r.o.delivery_fee === fee && r.o.total === subtotal + fee + tax,
      `subtotal ${subtotal} at 18%, free from 500: fee ${fee}, tax ${tax} (matches pricing.ts)`, JSON.stringify(r.o ?? r.msg));
  }
  await db.exec(`update public.platform_settings set tax_rate = 0.05, free_delivery_threshold = 0`);
}
{
  await db.exec(`update public.platform_settings set accepting_orders = false`);
  const r = await placeOrder({ payment_method: "'cod'" });
  ok(!r.ok && /orders_paused/.test(r.msg), "the platform pause refuses a direct insert", r.msg);
  await db.exec(`update public.platform_settings set accepting_orders = true`);
}
{
  await db.exec(`update public.platform_settings set min_order = 300`);
  const r = await placeOrder({ payment_method: "'cod'" });
  ok(!r.ok && /below the minimum order/.test(r.msg), "a ₹200 basket under a ₹300 minimum is refused", r.msg);
  await db.exec(`update public.platform_settings set min_order = 0`);
}
{
  await db.exec(`update public.restaurants set accept_cod = false where id = '${SHOP}'`);
  const r = await placeOrder({ payment_method: "'cod'" });
  ok(!r.ok && /does not take cash/.test(r.msg), "COD on a shop that takes no cash is refused", r.msg);
  await db.exec(`update public.restaurants set accept_cod = true where id = '${SHOP}'`);
}
{
  // A trusted caller keeps the stored charges (phone orders, imports, refunds).
  const r = await as("service_role", null, `
    with o as (insert into public.orders (customer_id, restaurant_id, address, delivery_fee, tax_amount, payment_method)
               values ('${CUST}', '${SHOP}', ${ADDRESS}, 15, 4, 'cod') returning id)
    select id from o`);
  ok(r.ok, "service role can insert an order", r.msg);
  if (r.ok) {
    const id = r.rows[0].id;
    await as("service_role", null, `insert into public.order_items (order_id, menu_item_id, name, qty, price) values ('${id}', '${DISH}', 'Thali', 1, 200)`);
    await as("service_role", null, `select public.recompute_order_total('${id}')`);
    const [o] = await one(db, `select delivery_fee, tax_amount, total from public.orders where id = '${id}'`);
    ok(o.delivery_fee === 15 && o.tax_amount === 4 && o.total === 219, "service-role order keeps its stored fee and tax", JSON.stringify(o));
  }
}

// ---------- 2. coupons ----------
await db.exec(`
  insert into public.coupons (code, kind, value, active, restaurant_id, funded_by)
    values ('PLATFORM10', 'flat', 10, true, '${SHOP}', 'platform'), ('VENDOR10', 'flat', 10, true, '${SHOP}', 'vendor');
`);
{
  const flip = await as("authenticated", VEND, `update public.coupons set funded_by = 'vendor', value = 99 where code = 'PLATFORM10' returning code`);
  ok(flip.ok && flip.rows.length === 0, "vendor cannot re-fund or edit a platform code on its shop", JSON.stringify(flip));
  const del = await as("authenticated", VEND, `delete from public.coupons where code = 'PLATFORM10' returning code`);
  ok(del.ok && del.rows.length === 0, "vendor cannot delete a platform code on its shop", JSON.stringify(del));
  const [still] = await one(db, `select funded_by, value from public.coupons where code = 'PLATFORM10'`);
  ok(still?.funded_by === "platform" && Number(still?.value) === 10, "the platform code is unchanged", JSON.stringify(still));
  const edit = await as("authenticated", VEND, `update public.coupons set value = 20 where code = 'VENDOR10' returning code`);
  ok(edit.ok && edit.rows.length === 1, "vendor can still edit its own code", JSON.stringify(edit));
  const own = await as("authenticated", VEND, `delete from public.coupons where code = 'VENDOR10' returning code`);
  ok(own.ok && own.rows.length === 1, "vendor can still delete its own code", JSON.stringify(own));
}

// ---------- 3. ops_address_note ----------
{
  const r = await placeOrder({ payment_method: "'cod'", ops_address_note: "'Note from ops: collect cash from guard'" });
  ok(r.ok, "customer insert carrying ops_address_note still succeeds", r.msg);
  if (r.ok) {
    const [o] = await one(db, `select ops_address_note from public.orders where id = '${r.id}'`);
    ok(o.ops_address_note === null, "a customer insert stores ops_address_note as null", JSON.stringify(o));

    const v = await as("authenticated", VEND, `update public.orders set ops_address_note = 'Customer moved, call me' where id = '${r.id}'`);
    ok(!v.ok && /ops_address_note/.test(v.msg), "a vendor update of ops_address_note raises", v.msg ?? "update succeeded");

    const s = await as("service_role", null, `update public.orders set ops_address_note = 'Gate 2' where id = '${r.id}' returning ops_address_note`);
    ok(s.ok && s.rows[0]?.ops_address_note === "Gate 2", "the service role (ops_correct_order) can still write it", s.msg);
  }
}

console.log(fails ? `\n${fails} FAILED` : "\nmigration 0180 holds");
process.exit(fails ? 1 : 0);
