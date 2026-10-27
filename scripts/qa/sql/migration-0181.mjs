// Proves migration 0181 (second security-audit pass) on the real migration chain
// (chain-lib.mjs), with a customer and a vendor acting through their own sessions.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0181.mjs
//
//   1. a customer's direct order cannot be finished during a platform pause,
//      sent outside the delivery area, or taken by the kitchen as a cash order
//      above the shop's ceiling — and ordinary orders still go through;
//   2. a customer's insert cannot set invoice_no / invoice_at / preparing_at /
//      external_id; the service role still can;
//   3. browser-reported ('client') issues queue no developer alert, other new
//      errors still do, and no more than 30 are queued in an hour.
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

const CUST = "00000000-0000-4000-8000-0000000000c2";
const VEND = "00000000-0000-4000-8000-0000000000e2";
const SHOP = "00000000-0000-4000-8000-0000000000d2";
const DISH = "00000000-0000-4000-8000-0000000000f2";
const IN_TOWN = `'{"label":"Home","line":"1 Main Rd","lat":21.72,"lng":81.54}'::jsonb`;
const FAR = `'{"label":"Raipur","line":"x","lat":21.25,"lng":81.63}'::jsonb`;
const UNPINNED = `'{"label":"Home","line":"1 Main Rd"}'::jsonb`;

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
  insert into auth.users (id, email) values ('${CUST}','c2@x.test'), ('${VEND}','v2@x.test');
  insert into public.profiles (id, role) values ('${CUST}','customer'), ('${VEND}','restaurant')
    on conflict (id) do update set role = excluded.role;
  insert into public.platform_settings (id, delivery_fee, tax_rate, free_delivery_threshold, min_order, accepting_orders, delivery_radius_km)
    values (true, 30, 0.05, 0, 0, true, 8)
    on conflict (id) do update set delivery_fee = 30, tax_rate = 0.05, free_delivery_threshold = 0, min_order = 0,
      accepting_orders = true, delivery_radius_km = 8;
  insert into public.restaurants (id, slug, name, owner_id, approved, is_open, lat, lng, accept_cod, cod_max_order)
    values ('${SHOP}', 'test-shop-2', 'Test Shop 2', '${VEND}', true, true, 21.71, 81.53, true, 500);
  insert into public.menu_items (id, restaurant_id, name, price, available)
    values ('${DISH}', '${SHOP}', 'Thali', 200, true);
  select set_config('test.jwt','',false);
`);
await db.exec(`
  create or replace function public.restaurant_status_now(p uuid, p_at timestamptz default now()) returns text
    language sql stable as $$ select 'open' $$;
  update public.menu_items set approval_status = 'approved' where id = '${DISH}';
`).catch(() => {});

const insertOrder = (address, extra = {}) =>
  as("authenticated", CUST, `insert into public.orders (customer_id, restaurant_id, address, payment_method${Object.keys(extra).map((k) => ", " + k).join("")})
    values ('${CUST}', '${SHOP}', ${address}, 'cod'${Object.values(extra).map((v) => ", " + v).join("")}) returning id`);
const addItems = (id, qty) =>
  as("authenticated", CUST, `insert into public.order_items (order_id, menu_item_id, name, qty, price) values ('${id}', '${DISH}', 'x', ${qty}, 1)`);

// ---------- 1a. the pause ----------
{
  const shell = await insertOrder(IN_TOWN);
  ok(shell.ok, "an empty order can be started while ordering is open", shell.msg);
  await db.exec(`update public.platform_settings set accepting_orders = false`);
  const items = shell.ok ? await addItems(shell.rows[0].id, 1) : { ok: true };
  ok(!items.ok && /orders_paused/.test(items.msg), "it cannot be filled with items after ops pause ordering", items.msg ?? "items accepted");
  await db.exec(`update public.platform_settings set accepting_orders = true`);
  const later = shell.ok ? await addItems(shell.rows[0].id, 1) : { ok: false };
  ok(later.ok, "once ordering reopens the same order can be completed", later.msg);
}

// ---------- 1b. the delivery area ----------
{
  const far = await insertOrder(FAR);
  ok(!far.ok && /outside the delivery area/.test(far.msg), "an address ~50 km away is refused at a radius of 8 km", far.msg ?? "accepted");
  const unpinned = await insertOrder(UNPINNED);
  ok(!unpinned.ok && /outside the delivery area/.test(unpinned.msg), "an address with no map pin is refused", unpinned.msg ?? "accepted");
  const near = await insertOrder(IN_TOWN);
  ok(near.ok, "an in-town address is accepted", near.msg);

  await db.exec(`update public.platform_settings set delivery_radius_km = 0`);
  const unlimited = await insertOrder(FAR);
  ok(unlimited.ok, "radius 0 (limit switched off) accepts the far address", unlimited.msg);
  const stillPinless = await insertOrder(UNPINNED);
  ok(!stillPinless.ok, "radius 0 still refuses an unpinned address (as checkServiceArea does)", stillPinless.msg ?? "accepted");
  await db.exec(`update public.platform_settings set delivery_radius_km = 8`);

  await db.exec(`update public.restaurants set lat = 21.25, lng = 81.63 where id = '${SHOP}'`);
  const shopOut = await insertOrder(IN_TOWN);
  ok(!shopOut.ok, "a shop pinned outside the circle cannot take a town order", shopOut.msg ?? "accepted");
  await db.exec(`update public.restaurants set lat = 21.71, lng = 81.53 where id = '${SHOP}'`);
}

// ---------- 1c. the COD ceiling, when the kitchen takes the order ----------
{
  const big = await insertOrder(IN_TOWN);
  if (big.ok) await addItems(big.rows[0].id, 3); // 600 + fee + tax > 500
  const small = await insertOrder(IN_TOWN);
  if (small.ok) await addItems(small.rows[0].id, 1); // 200 + 30 + 10 = 240
  const [b] = big.ok ? await one(db, `select total from public.orders where id = '${big.rows[0].id}'`) : [{}];
  ok(big.ok && b.total > 500, "a customer can still insert a cash order above the ceiling", JSON.stringify(b));

  const refuse = big.ok
    ? await as("authenticated", VEND, `update public.orders set status = 'kitchen' where id = '${big.rows[0].id}'`)
    : { ok: true };
  ok(!refuse.ok && /over the cash limit/.test(refuse.msg), "the vendor cannot take it into the kitchen", refuse.msg ?? "accepted");

  const accept = small.ok
    ? await as("authenticated", VEND, `update public.orders set status = 'kitchen' where id = '${small.rows[0].id}'`)
    : { ok: false, msg: "no order" };
  ok(accept.ok, "an order under the ceiling still moves to the kitchen", accept.msg);

  const cancel = big.ok
    ? await as("authenticated", VEND, `update public.orders set status = 'cancelled', cancellation_reason = 'over limit' where id = '${big.rows[0].id}'`)
    : { ok: false, msg: "no order" };
  ok(cancel.ok, "the over-ceiling order can still be cancelled", cancel.msg);
}

// ---------- 2. staff-only columns on insert ----------
{
  const forged = await insertOrder(IN_TOWN, {
    invoice_no: "'INV/2026-27/00001'",
    invoice_at: "now()",
    preparing_at: "now()",
    external_id: "'legacy-1'",
    created_at: "'2019-01-01T00:00:00Z'",
  });
  ok(forged.ok, "a customer insert carrying staff-only columns still succeeds", forged.msg);
  if (forged.ok) {
    const [o] = await one(db, `select invoice_no, invoice_at, preparing_at, external_id,
      abs(extract(epoch from (created_at - now()))) < 60 as fresh from public.orders where id = '${forged.rows[0].id}'`);
    ok(o.invoice_no === null && o.invoice_at === null && o.preparing_at === null && o.external_id === null,
      "invoice_no, invoice_at, preparing_at and external_id are stored as null", JSON.stringify(o));
    ok(o.fresh === true, "a backdated created_at is replaced with now()", JSON.stringify(o));
  }
  const offWorld = await insertOrder(`'{"label":"x","line":"y","lat":381.7157,"lng":81.5335}'::jsonb`);
  ok(!offWorld.ok && /outside the delivery area/.test(offWorld.msg), "a latitude off the globe (21.7 + 360) is refused", offWorld.msg ?? "accepted");
  const svc = await as("service_role", null, `insert into public.orders (customer_id, restaurant_id, address, payment_method, external_id)
    values ('${CUST}', '${SHOP}', ${IN_TOWN}, 'cod', 'legacy-2') returning external_id`);
  ok(svc.ok && svc.rows[0]?.external_id === "legacy-2", "the service role (legacy import) still sets external_id", svc.msg);
}

// ---------- 3. developer alerts ----------
{
  const issue = (fp, kind) => `insert into public.obs_issues (fingerprint, short_id, title, kind, level, env)
    values ('${fp}', 'DEL-${fp}', 'boom ${fp}', '${kind}', 'error', 'production')`;
  const count = async () => Number((await one(db, `select count(*)::int n from public.obs_issue_alerts`))[0].n);
  const before = await count();
  await db.exec(issue("c1", "client"));
  ok((await count()) === before, "a browser-reported (client) issue queues no alert");
  await db.exec(issue("e1", "error"));
  ok((await count()) === before + 1, "a server error issue still queues an alert");
  for (let i = 2; i <= 40; i++) await db.exec(issue(`e${i}`, "error"));
  ok((await count()) === 30, "no more than 30 alerts are queued in an hour", String(await count()));
  await db.exec(issue("f1", "error").replace("'error', 'production'", "'fatal', 'production'"));
  ok((await count()) === 31, "a fatal still alerts past the cap", String(await count()));
}

// ---------- 4. a vendor password reset ends the owner's sessions ----------
{
  const ADM = "00000000-0000-4000-8000-0000000000a2";
  await db.exec(`
    select set_config('test.jwt','{"role":"service_role"}',false);
    insert into auth.users (id, email) values ('${ADM}','a2@x.test');
    insert into public.profiles (id, role) values ('${ADM}','admin') on conflict (id) do update set role = 'admin';
    insert into auth.sessions (user_id) values ('${VEND}'), ('${VEND}'), ('${CUST}');
    select set_config('test.jwt','',false);
  `);
  const sessions = async (u) => Number((await one(db, `select count(*)::int n from auth.sessions where user_id = '${u}'`))[0].n);
  const asVendor = await as("service_role", null, `select public.ops_revoke_vendor_sessions('${VEND}', '${SHOP}') n`);
  ok(!asVendor.ok && /forbidden/.test(asVendor.msg), "a non-admin actor cannot end a vendor's sessions", asVendor.msg ?? "allowed");
  const direct = await as("authenticated", ADM, `select public.ops_revoke_vendor_sessions('${ADM}', '${SHOP}') n`);
  ok(!direct.ok, "a signed-in session cannot call it directly (service role only)", direct.msg ?? "allowed");
  const r = await as("service_role", null, `select public.ops_revoke_vendor_sessions('${ADM}', '${SHOP}') n`);
  ok(r.ok && r.rows[0].n === 2 && (await sessions(VEND)) === 0, "an admin ends every session of the shop's owner", JSON.stringify(r));
  ok((await sessions(CUST)) === 1, "nobody else's sessions are touched");
}

// ---------- 5. payout, statutory and owner details ----------
{
  for (const [col, val] of [["upi_id", "'x@upi'"], ["bank_account_number", "'000000000000'"], ["bank_ifsc", "'DUMY0000001'"], ["gst_number", "'22AAAAA0000A1Z5'"], ["owner_mobile", "'+919999999999'"]]) {
    const r = await as("authenticated", VEND, `update public.restaurants set ${col} = ${val} where id = '${SHOP}'`);
    ok(!r.ok && /admin-only/.test(r.msg), `a shop owner cannot change ${col}`, r.msg ?? "updated");
  }
  const open = await as("authenticated", VEND, `update public.restaurants set is_open = false where id = '${SHOP}' returning is_open`);
  ok(open.ok && open.rows[0]?.is_open === false, "a shop owner can still open and close the shop", open.msg);
  const svc = await as("service_role", null, `update public.restaurants set upi_id = 'shop@upi' where id = '${SHOP}' returning upi_id`);
  ok(svc.ok && svc.rows[0]?.upi_id === "shop@upi", "the service role (admin desk) can still set payout details", svc.msg);
}

console.log(fails ? `\n${fails} FAILED` : "\nmigration 0181 holds");
process.exit(fails ? 1 : 0);
