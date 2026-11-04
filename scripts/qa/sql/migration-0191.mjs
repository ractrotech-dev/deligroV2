// Runs migration 0191 (the owner's cancelling and refund rules) in PGlite on top of
// finance-base.mjs: the customer's 20-second window at seconds 19 and 21 and on an
// accepted order, a shop that can no longer cancel, staff reasons, no new refunds.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0191.mjs
import { financeBase, harness, readMigration, id, IDS } from "./finance-base.mjs";
import { freshChain } from "./chain-lib.mjs";

const { db, ZA } = await financeBase();
const { A, M, C, V, R1 } = IDS;
const OTHER = id(50);

await db.exec(`
  insert into public.profiles (id, role, full_name) values ('${OTHER}','customer','Someone else');
  update public.restaurants set zone_id = '${ZA}' where id = '${R1}';
`);

const { ok, as, srv, one, fails, done } = harness(db);
let serial = 800;

/** A new order, `seconds` old. status/payment as asked. */
async function order({ seconds = 0, status = "placed", customer = C, payment = "pending", total = 300 } = {}) {
  const o = id(serial++);
  await db.exec(`
    insert into public.orders (id, customer_id, restaurant_id, zone_id, status, total, payment_method, payment_status, created_at)
    values ('${o}','${customer}','${R1}','${ZA}','${status}',${total},'cod','${payment}', now() - interval '${seconds} seconds');
  `);
  return o;
}
const statusOf = async (o) => (await one(`select status::text as s from public.orders where id = '${o}'`)).s;
const cancel = (o, uid = C) => as("authenticated", uid, `select public.customer_cancel_order('${o}') as r`);
const left = async (o, uid = C) => (await as("authenticated", uid, `select public.customer_cancel_seconds_left('${o}') as s`)).rows?.[0].s;
const refundRows = async () => (await one(`select count(*)::int as n from public.refunds`)).n;

// Before the migration the old rules apply: a proof that this test can see the change.
const preKitchen = await order({ status: "kitchen" });
let r = await as("authenticated", V, `update public.orders set status = 'cancelled' where id = '${preKitchen}'`);
ok("before 0191: a shop can cancel an accepted order (the old rule)", r.ok, r.msg);

await db.exec(readMigration("0191_cancel_and_refund_rules.sql"));
await db.exec(readMigration("0191_cancel_and_refund_rules.sql"));
ok("the migration runs twice without complaint", true);

// ── A. The 20-second window ──────────────────────────────────────────────────
const at19 = await order({ seconds: 19 });
ok("second 19: the screen is still told it can cancel", (await left(await order({ seconds: 5 }))) >= 14);
r = await cancel(at19);
ok("second 19: the customer can cancel", r.ok && r.rows[0].r.ok === true && r.rows[0].r.replayed === false, r.msg);
ok("...the order is cancelled", (await statusOf(at19)) === "cancelled");
ok("...and it says the customer did it", (await one(`select cancelled_by as b from public.orders where id = '${at19}'`)).b === "customer");
r = await cancel(at19);
ok("...a second tap is not an error, and changes nothing", r.ok && r.rows[0].r.replayed === true, r.msg);

const at21 = await order({ seconds: 21 });
ok("second 21: the screen is told nothing is left", (await left(at21)) === 0);
ok("second 21: the database refuses", fails(await cancel(at21), /too_late/));
ok("...and the order is untouched", (await statusOf(at21)) === "placed");

for (const status of ["kitchen", "ready", "on_the_way", "delivered"]) {
  const accepted = await order({ seconds: 5, status });
  ok(`an order already ${status} is refused even at second 5`, fails(await cancel(accepted), /too_late/));
  ok(`...and shows no time left`, (await left(accepted)) === 0);
  ok(`...and stays ${status}`, (await statusOf(accepted)) === status);
}

const someoneElses = await order({ seconds: 5, customer: OTHER });
ok("another customer's order answers not_found", fails(await cancel(someoneElses), /not_found/));
ok("...and shows no time left", (await left(someoneElses)) === 0);
ok("...and is untouched", (await statusOf(someoneElses)) === "placed");
ok("an order that does not exist answers the same", fails(await cancel(id(799)), /not_found/));
ok("the shop cannot use the customer's cancel", fails(await cancel(await order({ seconds: 5 }), V), /not_found/));
ok("no session is refused", fails(await as("anon", null, `select public.customer_cancel_order('${at21}')`), /permission denied|forbidden/));

const future = await order({ seconds: -600 });
ok("a created_at in the future does not buy more time", fails(await cancel(future), /too_late/) && (await left(future)) === 0);

// The setting is what counts, and a bad reading is 20.
await db.exec(`update public.platform_settings set customer_cancel_seconds = 60`);
const at40 = await order({ seconds: 40 });
ok("with the setting at 60, second 40 can cancel", (await cancel(at40)).ok);
await db.exec(`update public.platform_settings set customer_cancel_seconds = 0`);
ok("with the setting at 0, nobody can cancel", fails(await cancel(await order()), /too_late/));
await db.exec(`update public.platform_settings set customer_cancel_seconds = 20`);
ok("the setting rejects a nonsense value",
  !(await srv(`update public.platform_settings set customer_cancel_seconds = -1`)).ok);
await db.exec(`alter table public.platform_settings rename column customer_cancel_seconds to customer_cancel_seconds_gone`);
ok("the setting cannot be read: second 19 can still cancel (20)", (await cancel(await order({ seconds: 19 }))).ok);
ok("the setting cannot be read: second 21 is still refused (20)", fails(await cancel(await order({ seconds: 21 })), /too_late/));
await db.exec(`alter table public.platform_settings rename column customer_cancel_seconds_gone to customer_cancel_seconds`);
await db.exec(`delete from public.platform_settings`);
ok("no settings row at all: second 21 is still refused (20)", fails(await cancel(await order({ seconds: 21 })), /too_late/));
await db.exec(`insert into public.platform_settings default values`);
ok("everyone may read the setting",
  (await as("anon", null, `select customer_cancel_seconds as s from public.platform_settings`)).rows?.[0].s === 20);

// ── B. A shop cannot cancel ──────────────────────────────────────────────────
for (const status of ["kitchen", "ready"]) {
  const o = await order({ status, seconds: 120 });
  r = await as("authenticated", V, `update public.orders set status = 'cancelled' where id = '${o}'`);
  ok(`a shop token cannot cancel an order in ${status}`, fails(r, /illegal order status change/), r.msg);
  ok("...and it stays", (await statusOf(o)) === status);
}
const fresh = await order({ seconds: 120 });
r = await as("authenticated", V, `update public.orders set status = 'cancelled' where id = '${fresh}'`);
ok("a shop can still reject a new order", r.ok && (await statusOf(fresh)) === "cancelled", r.msg);
const toAccept = await order({ seconds: 120 });
r = await as("authenticated", V, `update public.orders set status = 'kitchen' where id = '${toAccept}'`);
ok("a shop can still accept a new order", r.ok, r.msg);
r = await as("authenticated", V, `update public.orders set status = 'ready' where id = '${toAccept}'`);
ok("...and move it to ready", r.ok, r.msg);

// ── C. Staff cancelling ──────────────────────────────────────────────────────
const staffOrder = await order({ status: "ready", seconds: 3600 });
for (const [label, reason] of [["no", ""], ["a blank", "   "], ["a two-letter", "ab"]]) {
  ok(`staff: ${label} reason is refused`,
    fails(await srv(`select public.ops_cancel_order('${M}','${staffOrder}','${reason}','short-${serial++}')`), /reason_required/));
}
ok("...and the order is untouched", (await statusOf(staffOrder)) === "ready");
r = await srv(`select public.ops_cancel_order('${M}','${staffOrder}','Shop closed early','staff-1') as s`);
ok("a manager cancels a ready order, any time, with a reason", r.ok && r.rows[0].s.refund_amount === 0, r.msg);
const row = await one(`select cancelled_by as b, cancellation_reason as w from public.orders where id = '${staffOrder}'`);
ok("...who and why are on the order", row.b === "manager" && row.w === "Shop closed early");
const log = await one(`select actor_id, reason from public.ops_audit_log where action = 'order.cancel' and entity_id = '${staffOrder}'`);
ok("...and in the audit log", log.actor_id === M && log.reason === "Shop closed early");
const adminOrder = await order({ status: "kitchen", seconds: 3600 });
r = await srv(`select public.ops_cancel_order('${A}','${adminOrder}','Customer called us','staff-2') as s`);
ok("an admin too, recorded as admin", r.ok && (await one(`select cancelled_by as b from public.orders where id = '${adminOrder}'`)).b === "admin", r.msg);

// ── D. No new refunds ────────────────────────────────────────────────────────
const before = await refundRows();
const paid = await order({ status: "kitchen", seconds: 3600, payment: "paid", total: 500 });
r = await srv(`select public.ops_cancel_order('${M}','${paid}','Shop closed early','staff-3') as s`);
ok("a staff cancel of a paid order works", r.ok, r.msg);
ok("...raises no refund", (await refundRows()) === before);
ok("...and leaves the payment as paid", (await one(`select payment_status as p from public.orders where id = '${paid}'`)).p === "paid");

const paid2 = await order({ seconds: 5, payment: "paid", total: 500 });
ok("a customer cancel of a paid order works", (await cancel(paid2)).ok);
ok("...raises no refund", (await refundRows()) === before);

r = await srv(`select public.queue_order_refund('${paid}', null, 'old caller', 'admin', '${A}') as q`);
ok("queue_order_refund queues nothing", r.ok && r.rows[0].q.amount === 0, r.msg);
ok("...no row", (await refundRows()) === before);

const delivered = await order({ status: "kitchen", seconds: 3600, payment: "paid", total: 500 });
await db.exec(`insert into public.order_items (id, order_id, name, qty, price) values ('${id(790)}','${delivered}','Thali',1,200)`);
r = await srv(`select public.ops_correct_order('${M}','${delivered}','item_unavailable',null,'${id(790)}','Out of stock','corr-1') as s`);
ok("marking an item unavailable still records the correction", r.ok, r.msg);
ok("...and raises no refund", (await refundRows()) === before);

ok("a customer cannot insert a refund straight into the table",
  !(await as("authenticated", C, `insert into public.refunds (order_id, amount) values ('${paid2}', 100)`)).ok);
ok("the service role cannot either", fails(await srv(`insert into public.refunds (order_id, amount) values ('${paid2}', 100)`), /refunds_closed/));
ok("the customer request policy is gone",
  (await one(`select count(*)::int as n from pg_policies where tablename = 'refunds' and policyname = 'refunds — customer request'`)).n === 0);

// Old rows stay, and stay readable.
await db.exec(`insert into public.refunds (order_id, amount, status, reason) values ('${paid}', 120, 'approved', 'Old record')`);
ok("an old refund row survives and is still readable by staff",
  (await as("authenticated", A, `select amount from public.refunds where reason = 'Old record'`)).rows?.[0]?.amount === 120);

// ── The real chain: every migration, with the real lifecycle triggers ─────────
const chain = await freshChain();
ok("the whole migration chain applies with 0191 on top", !chain.err, chain.err);
const real = harness(chain.db);
const CU = id(901), VE = id(902), SHOP = id(903);
await chain.db.exec(`
  insert into auth.users (id, phone) values ('${CU}', '+919000000001'), ('${VE}', '+919000000002');
  -- The shop owner stays a customer profile: owning the shop is what counts (0040).
  insert into public.profiles (id, role, full_name) values ('${CU}','customer','Asha'), ('${VE}','customer','Vik')
    on conflict (id) do nothing;
  insert into public.restaurants (id, owner_id, name, slug) values ('${SHOP}','${VE}','Spice Hub','spice-hub-0191');
`);
async function realOrder(seconds, status = "placed") {
  const o = id(serial++);
  await chain.db.exec(`
    insert into public.orders (id, customer_id, restaurant_id, status, total, payment_method, payment_status, address)
    values ('${o}','${CU}','${SHOP}','placed',300,'cod','pending','{"line":"x"}');
    update public.orders set created_at = now() - interval '${seconds} seconds', status = '${status}' where id = '${o}';
  `);
  return o;
}
const realStamp = async (o) => (await chain.db.query(`select status::text as s, cancelled_by as b, cancelled_at as t from public.orders where id = '${o}'`)).rows[0];
const realCancel = (o) => real.as("authenticated", CU, `select public.customer_cancel_order('${o}') as r`);

const r19 = await realOrder(19);
r = await realCancel(r19);
ok("real chain, second 19: the customer cancels", r.ok, r.msg);
const s19 = await realStamp(r19);
ok("...the triggers stamp who and when", s19.s === "cancelled" && s19.b === "customer" && s19.t !== null, JSON.stringify(s19));
const r21 = await realOrder(21);
ok("real chain, second 21: refused", fails(await realCancel(r21), /too_late/) && (await realStamp(r21)).s === "placed");
const rAcc = await realOrder(5, "kitchen");
ok("real chain, accepted at second 5: refused", fails(await realCancel(rAcc), /too_late/) && (await realStamp(rAcc)).s === "kitchen");
ok("real chain: a customer still can't write the order directly",
  (await real.as("authenticated", CU, `update public.orders set status = 'cancelled' where id = '${r21}' returning id`)).rows?.length !== 1);
r = await real.as("authenticated", VE, `update public.orders set status = 'cancelled' where id = '${rAcc}'`);
ok("real chain: the shop can't cancel an accepted order", fails(r, /illegal order status change/), r.msg);
r = await real.as("authenticated", VE, `update public.orders set status = 'cancelled' where id = '${r21}'`);
ok("real chain: the shop can reject a new order", r.ok && (await realStamp(r21)).b === "vendor", r.msg);
ok("real chain: the customer's refund insert is refused",
  !(await real.as("authenticated", CU, `insert into public.refunds (order_id, amount) values ('${r19}', 100)`)).ok);
ok("real chain: everyone can read the setting, and it is 20",
  (await real.as("anon", null, `select customer_cancel_seconds as s from public.platform_settings`)).rows?.[0].s === 20);

done();
