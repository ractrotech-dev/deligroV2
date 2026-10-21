// Runs migration 0142 in an in-process Postgres (PGlite) with stubbed Supabase auth helpers,
// on top of the real 0081 and 0141 (an abridged base schema stands in for 0001–0061; see manager-base.mjs).
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0142.mjs
// Proves the intervention RPCs, replay, zone and eligibility checks, the refund
// rules and the queue facts; it does not replace staging.
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
const newOrder = async (rid = R1, status = "placed", pay = "cod") => {
  const oid = id(1000 + ++n);
  const [method, payment] = pay === "paid" ? ["online", "paid"] : pay === "unpaid_online" ? ["online", "pending"] : ["cod", "pending"];
  await db.exec(`insert into public.orders (id, customer_id, restaurant_id, total, payment_method, payment_status)
      values ('${oid}','${C}','${rid}', 420, '${method}', '${payment}');
    insert into public.order_items (order_id, name, qty, price) values ('${oid}','Paneer', 2, 180), ('${oid}','Roti', 2, 30);`);
  if (status !== "placed") await db.exec(`update public.orders set status = '${status}' where id = '${oid}'`);
  return oid;
};
const item = async (oid, name) => (await one(`select id from public.order_items where order_id = '${oid}' and name = '${name}'`)).id;
const audits = async (action, oid) => (await one(`select count(*)::int as n from public.ops_audit_log where action = '${action}' and entity_id = '${oid}'`)).n;
const refundsOf = async (oid) => (await db.query(`select amount, status from public.refunds where order_id = '${oid}' order by created_at, amount`)).rows;

console.log("\n── the short code and indexes ──");
const O1 = await newOrder();
let r = await one(`select short_code from public.orders where id = '${O1}'`);
ok("short_code is the first 8 characters, upper-cased", r.short_code === O1.slice(0, 8).toUpperCase());
r = await as("authenticated", C, `select short_code from public.orders where id = '${O1}'`);
ok("authenticated can read it through the column grant", r.ok && r.rows.length === 1);
r = (await db.query(`select indexname from pg_indexes where indexname in ('orders_zone_created_id_idx','delivery_events_order_created_idx')`)).rows;
ok("the keyset paging index and the delivery-events-by-order index both exist", r.length === 2);

console.log("\n── advance ──");
ok("advance without a reason is refused",
  fails(await srv(`select public.ops_advance_order('${M}','${O1}','placed', null, 'c0')`), /reason_required/));
r = await srv(`select public.ops_advance_order('${M}','${O1}','placed', 'Vendor confirmed by phone', 'c1') as s`);
ok("a manager advances placed → kitchen with a reason", r.ok && r.rows[0].s.status === "kitchen" && r.rows[0].s.replayed === false);
r = await one(`select actor_id, reason from public.order_status_events where order_id = '${O1}' and to_status = 'kitchen'`);
ok("...the status event names the manager and the reason", r?.actor_id === M && r?.reason === "Vendor confirmed by phone");
ok("...one audit row", (await audits("order.advance", O1)) === 1);
r = await srv(`select public.ops_advance_order('${M}','${O1}','placed', 'Vendor confirmed by phone', 'c1') as s`);
ok("replaying the same client action returns the current state, marked replayed", r.ok && r.rows[0].s.status === "kitchen" && r.rows[0].s.replayed === true);
ok("...still one event and one audit row",
  (await one(`select count(*)::int as n from public.order_status_events where order_id = '${O1}' and to_status = 'kitchen'`)).n === 1
  && (await audits("order.advance", O1)) === 1);
ok("advancing from a status that has moved is stale",
  fails(await srv(`select public.ops_advance_order('${M}','${O1}','placed', 'Again', 'c2')`), /stale/));
ok("someone else's client action id is a conflict, not a replay",
  fails(await srv(`select public.ops_advance_order('${A}','${O1}','kitchen', 'Admin', 'c1')`), /client_action_id_conflict/));
const OB = await newOrder(R2);
ok("a manager cannot touch another zone's order",
  fails(await srv(`select public.ops_advance_order('${M}','${OB}','placed', 'Nope', 'c3')`), /forbidden/));
ok("an admin can", (await srv(`select public.ops_advance_order('${A}','${OB}','placed', 'Admin push', 'c4') as s`)).ok);
ok("a signed-in user cannot call the RPC directly",
  fails(await as("authenticated", M, `select public.ops_advance_order('${M}','${O1}','kitchen', 'x', 'c5')`), /permission denied/));
ok("the zone is checked in the database even for the service role with a forged actor",
  fails(await srv(`select public.ops_advance_order('${C}','${O1}','kitchen', 'x', 'c6')`), /forbidden/));

console.log("\n── no direct manager writes ──");
r = await as("authenticated", M, `update public.orders set status = 'ready' where id = '${O1}' returning id`);
ok("a manager's own JWT cannot PATCH an order's status", !r.ok || r.rows.length === 0);
ok("...the order did not move", (await one(`select status from public.orders where id = '${O1}'`)).status === "kitchen");
await db.exec(`insert into public.deliveries (order_id) values ('${O1}')`);
r = await as("authenticated", M, `update public.deliveries set driver_id = '${D1}', status = 'assigned' where order_id = '${O1}' returning id`);
ok("...nor assign a rider on the delivery row", !r.ok || r.rows.length === 0);
r = await as("authenticated", M, `insert into public.deliveries (order_id, driver_id, status) values ('${OB}','${D1}','assigned') returning id`);
ok("...nor insert a delivery", !r.ok || r.rows.length === 0);
r = await as("authenticated", M, `select id from public.orders where id = '${O1}'`);
ok("...while still reading its zone's orders", r.ok && r.rows.length === 1);

console.log("\n── cancel ──");
const O2 = await newOrder();
await db.exec(`insert into public.deliveries (order_id) values ('${O2}')`);
ok("cancel without a reason is refused",
  fails(await srv(`select public.ops_cancel_order('${M}','${O2}','', 'k1')`), /reason_required/));
r = await srv(`select public.ops_cancel_order('${M}','${O2}','Customer called to cancel', 'k2') as s`);
ok("cancel with a reason", r.ok && r.rows[0].s.status === "cancelled" && r.rows[0].s.delivery_status === "cancelled");
ok("...an unpaid COD order queues no refund", r.rows[0].s.refund_amount === 0 && (await refundsOf(O2)).length === 0);
r = await one(`select cancelled_by, cancellation_reason from public.orders where id = '${O2}'`);
ok("...cancelled_by is the actor's role, the reason kept", r.cancelled_by === "manager" && r.cancellation_reason === "Customer called to cancel");
r = await one(`select reason, actor_id from public.delivery_events where order_id = '${O2}' and kind = 'cancelled'`);
ok("...the delivery's cancelled event carries the reason and the manager", r?.reason === "Customer called to cancel" && r?.actor_id === M);
ok("a cancelled order cannot be cancelled again",
  fails(await srv(`select public.ops_cancel_order('${M}','${O2}','Again', 'k3')`), /terminal/));
const OP = await newOrder(R1, "kitchen", "paid");
r = await srv(`select public.ops_cancel_order('${M}','${OP}','Kitchen closed early', 'k4') as s`);
ok("cancelling a paid order queues the full refund in the same transaction", r.ok && r.rows[0].s.refund_amount === 420
  && JSON.stringify(await refundsOf(OP)) === JSON.stringify([{ amount: 420, status: "pending" }]));

console.log("\n── assign ──");
const O3 = await newOrder(R1, "ready");
const assignErr = async (rider, cid, extra = "null, '" + cid + "'") => {
  const x = await srv(`select public.ops_assign_rider('${M}','${O3}','${rider}', ${extra})`);
  return x.ok ? "ok" : `${x.msg}:${x.detail ?? ""}`;
};
ok("an offline rider is ineligible (offline)", (await assignErr(D3, "a1")) === "rider_ineligible:offline");
ok("a stale fix is ineligible (stale_fix)", (await assignErr(D4, "a2")) === "rider_ineligible:stale_fix");
await db.exec(`update public.rider_status set last_fix_at = now() + interval '10 minutes' where driver_id = '${D2}'`);
ok("a fix from a clock running ahead is not fresh either (stale_fix)", (await assignErr(D2, "a2b")) === "rider_ineligible:stale_fix");
await db.exec(`update public.rider_status set last_fix_at = now() where driver_id = '${D2}'`);
ok("a rider of another zone is ineligible (out_of_zone)", (await assignErr(D5, "a3")) === "rider_ineligible:out_of_zone");
ok("...and no override puts them on",
  (await assignErr(D5, "a3b", `'On the phone with him', 'a3b', true`)) === "rider_ineligible:out_of_zone");
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

const O3b = await newOrder(R1, "ready");
const ov = await srv(`select public.ops_assign_rider('${M}','${O3b}','${D4}', null, 'a7', true)`);
ok("an override without a reason is refused", fails(ov, /reason_required/));
r = await srv(`select public.ops_assign_rider('${M}','${O3b}','${D4}', 'Rider on the phone, GPS off', 'a8', true) as s`);
ok("a stale-fix rider can be put on with an override and a reason", r.ok && r.rows[0].s.delivery_status === "assigned");
r = await one(`select after ->> 'override' as o from public.ops_audit_log where action = 'delivery.assign.override' and entity_id = '${O3b}'`);
ok("...recorded as an override, naming what was overridden", r?.o === "stale_fix");

console.log("\n── reassign ──");
ok("reassign needs a reason",
  fails(await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D2}','', false, 'r1')`), /reason_required/));
r = await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D1}','Same rider', false, 'r2')`);
ok("reassigning to the current rider is refused (current_rider)", !r.ok && r.msg === "rider_ineligible" && r.detail === "current_rider");
await db.exec(`update public.deliveries set arrived_pickup_at = now(), driver_lat = 21.7, driver_lng = 81.5,
  driver_location_at = now(), offered_driver_id = '${D2}' where order_id = '${O3}'`);
r = await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D2}','Ravi has a flat tyre', false, 'r3') as s`);
ok("reassign moves the delivery to the new rider", r.ok && (await one(`select driver_id from public.deliveries where order_id = '${O3}'`)).driver_id === D2);
r = await one(`select arrived_pickup_at, driver_lat, driver_location_at, offered_driver_id from public.deliveries where order_id = '${O3}'`);
ok("...the old rider's arrival, position and the stale offer do not carry over",
  r.arrived_pickup_at === null && r.driver_lat === null && r.driver_location_at === null && r.offered_driver_id === null);
r = (await db.query(`select driver_id, reason, actor_id from public.delivery_events where order_id = '${O3}' and kind = 'reassigned'`)).rows;
ok("...exactly one reassigned event, naming the old rider, with the reason and the manager",
  r.length === 1 && r[0].driver_id === D1 && r[0].reason === "Ravi has a flat tyre" && r[0].actor_id === M);
r = await one(`select before ->> 'riderId' as b, after ->> 'riderId' as a, before ->> 'offeredRiderId' as off from public.ops_audit_log where action = 'delivery.reassign' and entity_id = '${O3}'`);
ok("...the audit row carries both riders and who had been offered", r?.b === D1 && r?.a === D2 && r?.off === D2);
r = (await db.query(`select actor_id from public.delivery_events where order_id = '${O3}' and kind = 'accepted' and driver_id = '${D2}'`)).rows;
ok("...0082's accepted event for the new rider survives 0142's re-declaration, with the manager as actor",
  r.length === 1 && r[0].actor_id === M);
await db.exec(`update public.deliveries set status = 'picked_up' where order_id = '${O3}'`);
r = await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D1}','Bike broke down', false, 'r4')`);
ok("a picked-up delivery needs afterPickup", !r.ok && r.msg === "picked_up");
r = await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D1}','Bike broke down', true, 'r5') as s`);
ok("...and moves with it", r.ok && (await one(`select driver_id from public.deliveries where order_id = '${O3}'`)).driver_id === D1);
await db.exec(`update public.deliveries set status = 'delivered' where order_id = '${O3}'`);
ok("a delivered delivery cannot be reassigned",
  fails(await srv(`select public.ops_reassign_delivery('${M}','${O3}','${D2}','Too late', true, 'r6')`), /terminal/));

console.log("\n── a failed delivery gets a new leg ──");
const OF = await newOrder(R1, "on_the_way");
await db.exec(`insert into public.deliveries (order_id, driver_id, status, assigned_at, picked_up_at)
  values ('${OF}','${D1}','picked_up', now(), now());
  -- 0082: a delivery only fails through an approved exception.
  insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason, status)
    select id, order_id, driver_id, 'customer_unreachable', 'No answer at the door', 'approved' from public.deliveries where order_id = '${OF}';
  update public.deliveries set status = 'failed', failure_reason = 'Customer unreachable' where order_id = '${OF}'`);
ok("assigning on a failed delivery needs a reason",
  fails(await srv(`select public.ops_assign_rider('${M}','${OF}','${D2}', null, 'f1')`), /reason_required/));
r = await srv(`select public.ops_assign_rider('${M}','${OF}','${D2}', 'Customer reachable now, try again', 'f2') as s`);
ok("...with one, it becomes a new assigned leg for the new rider", r.ok && r.rows[0].s.delivery_status === "assigned");
r = await one(`select driver_id, picked_up_at, failed_at, failure_reason from public.deliveries where order_id = '${OF}'`);
ok("...the old attempt's stamps are cleared", r.driver_id === D2 && r.picked_up_at === null && r.failed_at === null && r.failure_reason === null);
ok("...the failure stays in the event history",
  (await one(`select count(*)::int as n from public.delivery_events where order_id = '${OF}' and kind = 'failed'`)).n === 1);
const OF2 = await newOrder(R1, "on_the_way");
await db.exec(`insert into public.deliveries (order_id, driver_id, status, assigned_at) values ('${OF2}','${D1}','assigned', now());
  insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason, status)
    select id, order_id, driver_id, 'failed_delivery', 'Bike crashed', 'approved' from public.deliveries where order_id = '${OF2}';
  update public.deliveries set status = 'failed', failure_reason = 'Bike crashed' where order_id = '${OF2}'`);
r = await srv(`select public.ops_reassign_delivery('${M}','${OF2}','${D2}','Sending Sunil instead', false, 'f3') as s`);
ok("reassigning a failed delivery is also a new leg", r.ok && r.rows[0].s.delivery_status === "assigned");

console.log("\n── corrections ──");
const O4 = await newOrder(R1, "ready", "paid");
r = await srv(`select public.ops_correct_order('${M}','${O4}','status','kitchen', null, 'Marked ready by mistake', 'x1') as s`);
ok("a status correction ready → kitchen", r.ok && r.rows[0].s.status === "kitchen");
r = await one(`select actor_id, reason from public.order_status_events where order_id = '${O4}' and to_status = 'kitchen' order by id desc limit 1`);
ok("...logged with the manager and the reason", r?.actor_id === M && r?.reason === "Marked ready by mistake");
ok("...audited", (await audits("order.correct.status", O4)) === 1);
ok("a correction needs a reason",
  fails(await srv(`select public.ops_correct_order('${M}','${O4}','status','ready', null, ' ', 'x2')`), /reason_required/));
ok("a correction into cancelled is refused (use cancel)",
  fails(await srv(`select public.ops_correct_order('${M}','${O4}','status','cancelled', null, 'Oops', 'x3')`), /invalid_transition/));
ok("a correction into delivered is refused (use advance)",
  fails(await srv(`select public.ops_correct_order('${M}','${O4}','status','delivered', null, 'It was delivered', 'x3b')`), /use_advance/));
const O5 = await newOrder(R1, "delivered");
await db.exec(`insert into public.deliveries (order_id, driver_id, status, picked_up_at, cod_collected_at, cod_collected_amount)
  values ('${O5}','${D1}','delivered', now(), now(), 420)`);
ok("a delivered order with cash collected is financially closed",
  fails(await srv(`select public.ops_correct_order('${M}','${O5}','status','on_the_way', null, 'Not delivered', 'x4')`), /financially_closed/));
const O6 = await newOrder(R1, "delivered");
await db.exec(`insert into public.vendor_settlement_orders (order_id) values ('${O6}')`);
ok("...and so is one in a settlement",
  fails(await srv(`select public.ops_correct_order('${M}','${O6}','status','on_the_way', null, 'Not delivered', 'x5')`), /financially_closed/));
const O7 = await newOrder(R1, "on_the_way");
await db.exec(`insert into public.deliveries (order_id, driver_id, status, assigned_at) values ('${O7}','${D1}','assigned', now())`);
r = await srv(`select public.ops_correct_order('${M}','${O7}','delivery_status','picked_up', null, 'Rider forgot to tap', 'x8') as s`);
ok("a delivery status correction", r.ok && r.rows[0].s.delivery_status === "picked_up");
r = await one(`select reason from public.delivery_events where order_id = '${O7}' and kind = 'corrected'`);
ok("...logged as a corrected event with the reason", r?.reason === "Rider forgot to tap");
ok("a delivery correction into delivered is refused (use advance: cash and close)",
  fails(await srv(`select public.ops_correct_order('${M}','${O7}','delivery_status','delivered', null, 'Done', 'x8b')`), /use_advance/));
ok("the manager's own JWT still cannot change a locked column",
  fails(await as("authenticated", M, `update public.orders set zone_id = '${ZB}' where id = '${O4}' returning id`), /only order status may be changed/)
  || (await one(`select zone_id from public.orders where id = '${O4}'`)).zone_id === ZA);

console.log("\n── item refunds follow the refund rules ──");
r = await srv(`select public.ops_correct_order('${M}','${O4}','item_unavailable', null, '${await item(O4, "Paneer")}', 'Paneer ran out', 'i1') as s`);
ok("an unavailable item on a paid order queues a pending refund", r.ok);
ok("...for the line value", JSON.stringify(await refundsOf(O4)) === JSON.stringify([{ amount: 360, status: "pending" }]));
ok("...and the order total is untouched", (await one(`select total from public.orders where id = '${O4}'`)).total === 420);
ok("the same item cannot be refunded twice",
  fails(await srv(`select public.ops_correct_order('${M}','${O4}','item_unavailable', null, '${await item(O4, "Paneer")}', 'Again', 'i2')`), /invalid_transition/));
r = await srv(`select public.ops_correct_order('${M}','${O4}','item_unavailable', null, '${await item(O4, "Roti")}', 'Roti ran out too', 'i3')`);
ok("a second item tops up the open refund (one open refund per order)",
  r.ok && JSON.stringify(await refundsOf(O4)) === JSON.stringify([{ amount: 420, status: "pending" }]));

const OCOD = await newOrder(R1, "kitchen");
r = await srv(`select public.ops_correct_order('${M}','${OCOD}','item_unavailable', null, '${await item(OCOD, "Paneer")}', 'Paneer ran out', 'i4') as s`);
ok("an unpaid COD order: the item is recorded, no refund queued", r.ok && (await refundsOf(OCOD)).length === 0
  && (await one(`select after ->> 'paid' as p from public.ops_audit_log where client_action_id = 'i4'`)).p === "false");

const OPC = await newOrder(R1, "kitchen", "paid");
await srv(`select public.ops_correct_order('${M}','${OPC}','item_unavailable', null, '${await item(OPC, "Roti")}', 'Roti ran out', 'i5')`);
r = await srv(`select public.ops_cancel_order('${M}','${OPC}','Customer gave up', 'i6') as s`);
ok("partial refund pending, then cancel: the refund grows to the full total, once",
  r.ok && r.rows[0].s.refund_amount === 360 && JSON.stringify(await refundsOf(OPC)) === JSON.stringify([{ amount: 420, status: "pending" }]));

const OAP = await newOrder(R1, "kitchen", "paid");
await srv(`select public.ops_correct_order('${M}','${OAP}','item_unavailable', null, '${await item(OAP, "Roti")}', 'Roti ran out', 'i7')`);
await db.exec(`update public.refunds set status = 'approved' where order_id = '${OAP}'`);
r = await srv(`select public.ops_correct_order('${M}','${OAP}','item_unavailable', null, '${await item(OAP, "Paneer")}', 'Paneer ran out', 'i8')`);
ok("a second item after the first refund was approved queues its own refund", r.ok
  && JSON.stringify(await refundsOf(OAP)) === JSON.stringify([{ amount: 60, status: "approved" }, { amount: 360, status: "pending" }]));
ok("...and it can be approved too (0056's one-approved index is gone)",
  (await srv(`update public.refunds set status = 'approved' where order_id = '${OAP}' and status = 'pending' returning id`)).ok);
const OAC = await newOrder(R1, "kitchen", "paid");
await srv(`select public.ops_correct_order('${M}','${OAC}','item_unavailable', null, '${await item(OAC, "Roti")}', 'Roti ran out', 'i9')`);
await db.exec(`update public.refunds set status = 'approved' where order_id = '${OAC}'`);
r = await srv(`select public.ops_cancel_order('${M}','${OAC}','Shop shut', 'i10') as s`);
ok("partial refund approved, then cancel: the rest is queued, nothing stranded", r.ok && r.rows[0].s.refund_amount === 360
  && JSON.stringify(await refundsOf(OAC)) === JSON.stringify([{ amount: 60, status: "approved" }, { amount: 360, status: "pending" }]));
r = await srv(`insert into public.refunds (order_id, amount, status) values ('${OAP}', 1, 'approved')`);
ok("approved refunds can never exceed what the customer paid", fails(r, /refund_exceeds_total/));
r = await srv(`select public.queue_order_refund('${OAC}', null, 'again', 'admin', '${A}') as q`);
ok("queue_order_refund on a fully covered order adds nothing", r.ok && r.rows[0].q.amount === 0);
ok("queue_order_refund is not callable by a signed-in user",
  fails(await as("authenticated", M, `select public.queue_order_refund('${OAC}', null, 'x', 'manager', '${M}')`), /permission denied|forbidden/));

console.log("\n── a delivery note for the rider ──");
r = await srv(`select public.ops_correct_order('${M}','${O7}','address_note', null, null, 'Customer called', 'nt1', 'Blue gate behind the temple')`);
ok("a manager adds a delivery note", r.ok && (await one(`select ops_address_note as n from public.orders where id = '${O7}'`)).n === "Blue gate behind the temple");
ok("...audited", (await audits("order.correct.address_note", O7)) === 1);
ok("...a note must have words",
  fails(await srv(`select public.ops_correct_order('${M}','${O7}','address_note', null, null, 'Customer called', 'nt2', 'x')`), /invalid_transition/));

console.log("\n── queue facts ──");
const OU = await newOrder(R1, "placed", "unpaid_online");
r = await srv(`select array_agg(id::text order by created_at) as ids from public.ops_order_queue_facts(array['${ZA}']::uuid[], false)`);
const ids = r.ok ? r.rows[0].ids : [];
ok("queue facts list the zone's in-flight orders, oldest first", r.ok && ids.includes(O1) && ids.indexOf(O1) < ids.indexOf(O7));
ok("...never an unpaid online checkout", !ids.includes(OU));
ok("...never another zone's", !ids.includes(OB));
ok("...never a finished order", !ids.includes(O5) && !ids.includes(O2));
r = await srv(`select count(*)::int as n from public.ops_order_queue_facts(null, true) where id = '${OB}'`);
ok("all zones (admin) includes the other zone", r.ok && r.rows[0].n === 1);
ok("a signed-in user cannot read queue facts",
  fails(await as("authenticated", M, `select * from public.ops_order_queue_facts(array['${ZA}']::uuid[], false)`), /permission denied|forbidden/));

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
console.log("\n── 0082's delivery exceptions are zone-scoped for managers (0141) ──");
{
  const OXA = await newOrder(R1, "ready");
  const OXB = await newOrder(R2, "ready");
  await db.exec(`insert into public.deliveries (order_id, driver_id, status, assigned_at) values
      ('${OXA}','${D1}','assigned', now()), ('${OXB}','${D5}','assigned', now());
    insert into public.delivery_exceptions (delivery_id, order_id, driver_id, kind, reason)
      select id, order_id, driver_id, 'vendor_delay', 'Kitchen slow' from public.deliveries where order_id in ('${OXA}','${OXB}');`);
  const seen = async (uid) => {
    const q = await as("authenticated", uid, `select order_id from public.delivery_exceptions where order_id in ('${OXA}','${OXB}')`);
    return q.ok ? q.rows.map((x) => x.order_id).sort() : q.msg;
  };
  const mona = await seen(M);
  ok("a zone-A manager sees the zone-A exception only", Array.isArray(mona) && mona.length === 1 && mona[0] === OXA);
  const bina = await seen(MB);
  ok("a zone-B manager sees the zone-B exception only", Array.isArray(bina) && bina.length === 1 && bina[0] === OXB);
  const ravi = await seen(D1);
  ok("the rider sees their own exception", Array.isArray(ravi) && ravi.length === 1 && ravi[0] === OXA);
  const admin = await seen(A);
  ok("an admin sees both", Array.isArray(admin) && admin.length === 2);
}

let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
