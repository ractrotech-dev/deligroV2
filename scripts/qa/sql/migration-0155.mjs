// Runs migration 0155 (zone-scoped manager reads on settlements, settlement
// lines, corrections, refunds and payments; report indexes) in PGlite on top
// of finance-base.mjs.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0155.mjs
import { financeBase, harness, readMigration, id, IDS } from "./finance-base.mjs";

const { db, ZA, ZB } = await financeBase();
const { A, M, MB, C, V, R1, R2 } = IDS;
const NOZONE = id(30);
const OA = id(201), OB = id(202), SA = id(301), SB = id(302);

await db.exec(`
  insert into public.profiles (id, role, full_name) values ('${NOZONE}','manager','Nobody');
  delete from public.staff_zones where user_id = '${NOZONE}';
  update public.restaurants set zone_id = '${ZA}' where id = '${R1}';
  insert into public.orders (id, customer_id, restaurant_id, status, total, payment_method, payment_status)
    values ('${OA}','${C}','${R1}','delivered',520,'online','paid'), ('${OB}','${C}','${R2}','delivered',300,'online','paid');
  insert into public.vendor_settlements (id, restaurant_id, period_start, period_end, net_payable, status)
    values ('${SA}','${R1}', now() - interval '7 days', now(), 370, 'paid'), ('${SB}','${R2}', now() - interval '7 days', now(), 200, 'paid');
  insert into public.vendor_settlement_orders (settlement_id, order_id, contribution) values ('${SA}','${OA}',370), ('${SB}','${OB}',200);
  insert into public.refunds (order_id, amount, status) values ('${OA}', 120, 'approved'), ('${OB}', 50, 'approved');
  insert into public.settlement_corrections (restaurant_id, order_id, original_settlement_id, amount, created_by)
    values ('${R1}','${OA}','${SA}',120,'${A}'), ('${R2}','${OB}','${SB}',50,'${A}');
  insert into public.payments (order_id, provider_order_id, amount_paise, status) values ('${OA}','po_a',52000,'paid'), ('${OB}','po_b',30000,'paid');
`);

const { ok, as, done } = harness(db);
const count = async (uid, table) => {
  const r = await as("authenticated", uid, `select count(*)::int as n from public.${table}`);
  return r.ok ? r.rows[0].n : `error: ${r.msg}`;
};

console.log("\n── before 0155: a manager reads no money rows ──");
ok("zone-A manager reads 0 settlements before 0155", (await count(M, "vendor_settlements")) === 0);

await db.exec(readMigration("0155_manager_finance_reads.sql"));

console.log("\n── zone-scoped reads ──");
for (const t of ["vendor_settlements", "vendor_settlement_orders", "settlement_corrections", "refunds", "payments"]) {
  ok(`zone-A manager reads exactly zone A's ${t}`, (await count(M, t)) === 1);
  ok(`zone-B manager reads exactly zone B's ${t}`, (await count(MB, t)) === 1);
  ok(`a manager with no zones reads no ${t}`, (await count(NOZONE, t)) === 0);
  ok(`admin reads every ${t}`, (await count(A, t)) === 2);
}
const seen = await as("authenticated", M, `select id from public.vendor_settlements`);
ok("the zone-A row is zone A's settlement", seen.ok && seen.rows[0]?.id === SA);
ok("the customer still sees their own refunds and payments only", (await count(C, "refunds")) === 2 && (await count(C, "payments")) === 2);
ok("the customer sees no settlements", (await count(C, "vendor_settlements")) === 0);
ok("the vendor owner gains nothing from 0155", (await count(V, "settlement_corrections")) === 0);

console.log("\n── no manager writes ──");
const upd = await as("authenticated", M, `update public.vendor_settlements set notes = 'x' where id = '${SA}' returning id`);
ok("manager update of a settlement changes nothing", !upd.ok || upd.rows.length === 0, upd.msg);
const rupd = await as("authenticated", M, `update public.refunds set status = 'denied' where order_id = '${OA}' returning id`);
ok("manager update of a refund changes nothing", !rupd.ok || rupd.rows.length === 0, rupd.msg);
const pins = await as("authenticated", M, `insert into public.payments (order_id, provider_order_id) values ('${OA}','x') returning id`);
ok("manager insert into payments is refused", !pins.ok, pins.msg);

console.log("\n── helper and indexes ──");
const helper = await as("authenticated", M, `select public.manager_can_see_restaurant('${R1}') as a, public.manager_can_see_restaurant('${R2}') as b`);
ok("manager_can_see_restaurant: own zone true, other zone false", helper.ok && helper.rows[0].a === true && helper.rows[0].b === false, helper.msg);
const idx = await db.query(`select indexname from pg_indexes where indexname in
  ('orders_zone_created_at_idx','refunds_order_idx','refunds_status_created_idx','payments_status_created_idx',
   'vendor_settlements_restaurant_status_paid_idx','cod_handovers_zone_date_idx','deliveries_driver_cod_idx','payment_requests_status_requested_idx')`);
ok("all eight report indexes exist", idx.rows.length === 8, JSON.stringify(idx.rows));

done();
