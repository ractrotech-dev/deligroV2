// Runs migration 0142 in an in-process Postgres (PGlite) with stubbed Supabase auth helpers,
// on top of the real 0081 and 0141 (an abridged base schema stands in for 0001–0061; see manager-base.mjs).
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0142.mjs
// Proves the intervention RPCs, replay, zone and eligibility checks; it does not replace staging.
import { managerBase, readMigration, id, IDS } from "./manager-base.mjs";

const MIGRATION = readMigration("0142_manager_orders_live.sql");
const { db, ZA, ZB } = await managerBase();
const { A, M, MB, C, V, D1, D2, D3, D4, D5, R1, R2 } = IDS;

await db.exec(MIGRATION);

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };
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
let n = 0;
const newOrder = async (rid = R1, status = "placed") => {
  const oid = id(1000 + ++n);
  await db.exec(`insert into public.orders (id, customer_id, restaurant_id, total) values ('${oid}','${C}','${rid}', 420);
    insert into public.order_items (order_id, name, qty, price) values ('${oid}','Paneer', 2, 180);`);
  if (status !== "placed") await db.exec(`update public.orders set status = '${status}' where id = '${oid}'`);
  return oid;
};
const audits = async (action, oid) => (await one(`select count(*)::int as n from public.ops_audit_log where action = '${action}' and entity_id = '${oid}'`)).n;

console.log("\n── the short code ──");
const O1 = await newOrder();
let r = await one(`select short_code from public.orders where id = '${O1}'`);
ok("short_code is the first 8 characters, upper-cased", r.short_code === O1.slice(0, 8).toUpperCase());
r = await as("authenticated", C, `select short_code from public.orders where id = '${O1}'`);
ok("authenticated can read it through the column grant", r.ok && r.rows.length === 1);

console.log("\n── advance ──");
r = await srv(`select public.ops_advance_order('${M}','${O1}','placed', null, 'c1') as s`);
ok("a manager advances placed → kitchen", r.ok && r.rows[0].s.status === "kitchen");
r = await one(`select actor_id from public.order_status_events where order_id = '${O1}' and to_status = 'kitchen'`);
ok("...the status event names the manager", r?.actor_id === M);
ok("...one audit row", (await audits("order.advance", O1)) === 1);
r = await srv(`select public.ops_advance_order('${M}','${O1}','placed', null, 'c1') as s`);
ok("replaying the same client action returns the current state", r.ok && r.rows[0].s.status === "kitchen");
ok("...still one event and one audit row",
  (await one(`select count(*)::int as n from public.order_status_events where order_id = '${O1}' and to_status = 'kitchen'`)).n === 1
  && (await audits("order.advance", O1)) === 1);
ok("advancing from a status that has moved is stale",
  fails(await srv(`select public.ops_advance_order('${M}','${O1}','placed', null, 'c2')`), /stale/));
ok("someone else's client action id is a conflict, not a replay",
  fails(await srv(`select public.ops_advance_order('${A}','${O1}','kitchen', null, 'c1')`), /client_action_id_conflict/));
const OB = await newOrder(R2);
ok("a manager cannot touch another zone's order",
  fails(await srv(`select public.ops_advance_order('${M}','${OB}','placed', null, 'c3')`), /forbidden/));
ok("an admin can", (await srv(`select public.ops_advance_order('${A}','${OB}','placed', null, 'c4') as s`)).ok);
ok("a signed-in user cannot call the RPC directly",
  fails(await as("authenticated", M, `select public.ops_advance_order('${M}','${O1}','kitchen', null, 'c5')`), /permission denied/));
ok("the zone is checked in the database even for the service role with a forged actor",
  fails(await srv(`select public.ops_advance_order('${C}','${O1}','kitchen', null, 'c6')`), /forbidden/));

console.log("\n── cancel ──");
const O2 = await newOrder();
await db.exec(`insert into public.deliveries (order_id) values ('${O2}')`);
ok("cancel without a reason is refused",
  fails(await srv(`select public.ops_cancel_order('${M}','${O2}','', 'k1')`), /reason_required/));
r = await srv(`select public.ops_cancel_order('${M}','${O2}','Customer called to cancel', 'k2') as s`);
ok("cancel with a reason", r.ok && r.rows[0].s.status === "cancelled" && r.rows[0].s.delivery_status === "cancelled");
r = await one(`select cancelled_by, cancellation_reason from public.orders where id = '${O2}'`);
ok("...cancelled_by is the actor's role, the reason kept", r.cancelled_by === "manager" && r.cancellation_reason === "Customer called to cancel");
r = await one(`select reason, actor_id from public.delivery_events where order_id = '${O2}' and kind = 'cancelled'`);
ok("...the delivery's cancelled event carries the reason and the manager", r?.reason === "Customer called to cancel" && r?.actor_id === M);
ok("a cancelled order cannot be cancelled again",
  fails(await srv(`select public.ops_cancel_order('${M}','${O2}','Again', 'k3')`), /terminal/));

console.log("\n── assign ──");
const O3 = await newOrder(R1, "ready");
const assignErr = async (rider, cid) => {
  const x = await srv(`select public.ops_assign_rider('${M}','${O3}','${rider}', null, '${cid}')`);
  return x.ok ? "ok" : `${x.msg}:${x.detail ?? ""}`;
};
ok("an offline rider is ineligible (offline)", (await assignErr(D3, "a1")) === "rider_ineligible:offline");
ok("a stale fix is ineligible (stale_fix)", (await assignErr(D4, "a2")) === "rider_ineligible:stale_fix");
ok("a rider of another zone is ineligible (out_of_zone)", (await assignErr(D5, "a3")) === "rider_ineligible:out_of_zone");
await db.exec(`update public.rider_status set break_until = now() + interval '10 minutes' where driver_id = '${D2}'`);
ok("a rider on a break is ineligible (on_break)", (await assignErr(D2, "a4")) === "rider_ineligible:on_break");
await db.exec(`update public.rider_status set break_until = null where driver_id = '${D2}'`);
r = await srv(`select public.ops_assign_rider('${M}','${O3}','${D1}', null, 'a5') as s`);
ok("an eligible rider is assigned", r.ok && r.rows[0].s.delivery_status === "assigned");
r = await one(`select driver_id, driver_location_source from public.deliveries where order_id = '${O3}'`);
ok("...on a new delivery row, location source none", r.driver_id === D1 && r.driver_location_source === "none");
r = await one(`select actor_id from public.delivery_events where order_id = '${O3}' and kind = 'accepted'`);
ok("...the accepted event names the manager", r?.actor_id === M);
ok("assigning again is already_assigned", (await assignErr(D2, "a6")).startsWith("already_assigned"));

console.log("\n── reassign ──");
ok("reassign needs a reason",
  fails(await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D2}','', false, 'r1')`), /reason_required/));
r = await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D1}','Same rider', false, 'r2')`);
ok("reassigning to the current rider is refused (current_rider)", !r.ok && r.msg === "rider_ineligible" && r.detail === "current_rider");
r = await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D2}','Ravi has a flat tyre', false, 'r3') as s`);
ok("reassign moves the delivery to the new rider", r.ok && (await one(`select driver_id from public.deliveries where order_id = '${O3}'`)).driver_id === D2);
r = (await db.query(`select driver_id, reason, actor_id from public.delivery_events where order_id = '${O3}' and kind = 'reassigned'`)).rows;
ok("...exactly one reassigned event, naming the old rider, with the reason and the manager",
  r.length === 1 && r[0].driver_id === D1 && r[0].reason === "Ravi has a flat tyre" && r[0].actor_id === M);
r = await one(`select before ->> 'riderId' as b, after ->> 'riderId' as a from public.ops_audit_log where action = 'delivery.reassign' and entity_id = '${O3}'`);
ok("...the audit row carries both riders", r?.b === D1 && r?.a === D2);
await db.exec(`update public.deliveries set status = 'picked_up' where order_id = '${O3}'`);
r = await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D1}','Bike broke down', false, 'r4')`);
ok("a picked-up delivery needs afterPickup", !r.ok && r.msg === "picked_up");
r = await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D1}','Bike broke down', true, 'r5') as s`);
ok("...and moves with it", r.ok && (await one(`select driver_id from public.deliveries where order_id = '${O3}'`)).driver_id === D1);
await db.exec(`update public.deliveries set status = 'delivered' where order_id = '${O3}'`);
ok("a delivered delivery cannot be reassigned",
  fails(await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D2}','Too late', true, 'r6')`), /terminal/));

console.log("\n── corrections ──");
const O4 = await newOrder(R1, "ready");
r = await srv(`select public.ops_correct_order('${M}','${O4}','status','kitchen', null, 'Marked ready by mistake', 'x1') as s`);
ok("a status correction ready → kitchen", r.ok && r.rows[0].s.status === "kitchen");
r = await one(`select actor_id, reason from public.order_status_events where order_id = '${O4}' and to_status = 'kitchen' order by id desc limit 1`);
ok("...logged with the manager and the reason", r?.actor_id === M && r?.reason === "Marked ready by mistake");
ok("...audited", (await audits("order.correct.status", O4)) === 1);
ok("a correction needs a reason",
  fails(await srv(`select public.ops_correct_order('${M}','${O4}','status','ready', null, ' ', 'x2')`), /reason_required/));
ok("a correction into cancelled is refused (use cancel)",
  fails(await srv(`select public.ops_correct_order('${M}','${O4}','status','cancelled', null, 'Oops', 'x3')`), /invalid_transition/));
const O5 = await newOrder(R1, "delivered");
await db.exec(`insert into public.deliveries (order_id, driver_id, status, picked_up_at, cod_collected_at, cod_collected_amount)
  values ('${O5}','${D1}','delivered', now(), now(), 420)`);
ok("a delivered order with cash collected is financially closed",
  fails(await srv(`select public.ops_correct_order('${M}','${O5}','status','on_the_way', null, 'Not delivered', 'x4')`), /financially_closed/));
const O6 = await newOrder(R1, "delivered");
await db.exec(`insert into public.vendor_settlement_orders (order_id) values ('${O6}')`);
ok("...and so is one in a settlement",
  fails(await srv(`select public.ops_correct_order('${M}','${O6}','status','on_the_way', null, 'Not delivered', 'x5')`), /financially_closed/));
r = await srv(`select public.ops_correct_order('${M}','${O4}','item_unavailable', null,
  (select id from public.order_items where order_id = '${O4}'), 'Paneer ran out', 'x6') as s`);
ok("item unavailable queues a pending refund", r.ok);
r = await one(`select amount, status, origin, requested_by from public.refunds where order_id = '${O4}'`);
ok("...for the line value, origin manager", r?.amount === 360 && r?.status === "pending" && r?.origin === "manager" && r?.requested_by === M);
ok("...and the order total is untouched", (await one(`select total from public.orders where id = '${O4}'`)).total === 420);
ok("a second pending refund on the order is refused",
  fails(await srv(`select public.ops_correct_order('${M}','${O4}','item_unavailable', null,
    (select id from public.order_items where order_id = '${O4}'), 'Again', 'x7')`), /invalid_transition/));
const O7 = await newOrder(R1, "on_the_way");
await db.exec(`insert into public.deliveries (order_id, driver_id, status, assigned_at) values ('${O7}','${D1}','assigned', now())`);
r = await srv(`select public.ops_correct_order('${M}','${O7}','delivery_status','picked_up', null, 'Rider forgot to tap', 'x8') as s`);
ok("a delivery status correction", r.ok && r.rows[0].s.delivery_status === "picked_up");
r = await one(`select reason from public.delivery_events where order_id = '${O7}' and kind = 'corrected'`);
ok("...logged as a corrected event with the reason", r?.reason === "Rider forgot to tap");
ok("the manager's own JWT still cannot change a locked column",
  fails(await as("authenticated", M, `update public.orders set zone_id = '${ZB}' where id = '${O4}'`), /only order status may be changed/));

console.log("\n── notes ──");
r = await srv(`select public.ops_add_order_note('${M}','${O4}','Customer asked for extra napkins', 'n1') as s`);
ok("a manager adds a note", r.ok);
r = await as("authenticated", M, `select body from public.order_ops_notes where order_id = '${O4}'`);
ok("...readable by a manager of the zone", r.ok && r.rows.length === 1);
r = await as("authenticated", MB, `select body from public.order_ops_notes where order_id = '${O4}'`);
ok("...not by a manager of another zone", r.ok && r.rows.length === 0);
r = await as("authenticated", C, `select body from public.order_ops_notes`);
ok("...nor by the customer", r.ok && r.rows.length === 0);
ok("notes cannot be written directly",
  fails(await as("authenticated", M, `insert into public.order_ops_notes (order_id, author_id, body) values ('${O4}','${M}','sneaky')`), /permission denied/));
ok("nobody can edit the audit log",
  fails(await srv(`update public.ops_audit_log set reason = 'nicer'`), /append-only|permission denied/));

console.log("\n── the vendor's own changes still log the vendor ──");
const O8 = await newOrder();
r = await as("authenticated", V, `update public.orders set status = 'kitchen' where id = '${O8}' returning id`);
ok("the vendor accepts their order", r.ok && r.rows.length === 1);
r = await one(`select actor_id from public.order_status_events where order_id = '${O8}' and to_status = 'kitchen'`);
ok("...and the event names the vendor, not a leftover ops actor", r?.actor_id === V);

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
