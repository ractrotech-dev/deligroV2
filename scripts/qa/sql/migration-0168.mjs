// Runs migration 0168 in an in-process Postgres (PGlite) on top of
// support-base.mjs + 0151 + 0165 + 0166, and spot-checks the audit trail of
// five representative RPCs: one call writes exactly one audit row carrying
// the actor, zone, time and reason; a call the RPC refuses writes none (the
// change and its row share one transaction).
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0168.mjs
import { readMigration, id, IDS } from "./manager-base.mjs";
import { supportBase } from "./support-base.mjs";

const { db, ZA } = await supportBase();
const { M, C, R1 } = IDS;
await db.exec(readMigration("0151_manager_riders.sql"));
await db.exec(readMigration("0165_support_ops.sql"));
await db.exec(readMigration("0166_ops_alerts.sql"));
const MIGRATION = readMigration("0168_audit_coverage.sql");
await db.exec(MIGRATION);

let passed = 0, failed = 0;
const ok = (n, c, extra) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}${!c && extra ? `\n         ${extra}` : ""}`); };
async function srv(sql) {
  await db.exec(`set role service_role; select set_config('test.jwt','{"role":"service_role"}',false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec("reset role; select set_config('test.jwt','',false);"); }
}
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (action) => (await db.query(`select * from public.ops_audit_log where action = '${action}' order by id`)).rows;

const O = id(961), T = id(962);
await db.exec(`
  update public.restaurants set lat = 21.7, lng = 81.5 where id = '${R1}';
  insert into public.orders (id, customer_id, restaurant_id) values ('${O}','${C}','${R1}');
  insert into public.support_tickets (id, requester_id, requester_role, category, subject, order_id)
  values ('${T}','${C}','customer','order_issue','Cold food','${O}');
`);
const status = (await one(`select status::text as s from public.restaurants where id = '${R1}'`)).s;

const spot = async (name, action, refused, done, wantReason) => {
  console.log(`\n── ${name} ──`);
  const before = (await rows(action)).length;
  let r = await srv(refused);
  ok(`a refused call fails`, !r.ok, r.msg);
  ok(`...and writes no audit row`, (await rows(action)).length === before);
  r = await srv(done);
  const after = await rows(action);
  ok(`one call writes exactly one row`, r.ok && after.length === before + 1, r.msg);
  const row = after[after.length - 1];
  ok(`...with actor, zone and time`, row?.actor_id === M && row?.zone_id === ZA && !!row?.created_at, JSON.stringify(row));
  if (wantReason) ok(`...and the reason`, row?.reason === wantReason, row?.reason);
};

await spot("vendor status (0145)", "vendor.suspend",
  `select public.ops_set_vendor_status('${M}','${R1}','suspend','pending','Hygiene',false,'v0')`,
  `select public.ops_set_vendor_status('${M}','${R1}','suspend','${status}','Hygiene complaint',false,'v1')`,
  "Hygiene complaint");
await spot("ticket assignment (0165)", "ticket.assign",
  `select public.ops_assign_ticket('${M}','${T}','${C}',null,'t0')`,
  `select public.ops_assign_ticket('${M}','${T}','${M}','operations','t1')`);
await spot("ticket escalation (0165)", "ticket.escalate",
  `select public.ops_escalate_ticket('${M}','${T}',null,'e0')`,
  `select public.ops_escalate_ticket('${M}','${T}','Customer called twice','e1')`,
  "Customer called twice");
await spot("alert threshold (0166)", "alert_rule.set",
  `select public.ops_set_alert_rule('${M}','order_unassigned','${ZA}',true,0,null,'r0')`,
  `select public.ops_set_alert_rule('${M}','order_unassigned','${ZA}',true,8,null,'r1')`);
await srv(`select public.ops_raise_alert('order_unassigned','warning','t','b','${ZA}','order','${O}','order_unassigned:${O}')`);
const alertId = (await one(`select id from public.ops_alerts where dedupe_key = 'order_unassigned:${O}'`)).id;
await spot("alert resolution (0166)", "alert.resolve",
  `select public.ops_resolve_alert('${M}','${alertId}',null,'a0')`,
  `select public.ops_resolve_alert('${M}','${alertId}','Rider found','a1')`,
  "Rider found");

console.log("\n── index ──");
ok("the action index exists", !!(await one(`select 1 as x from pg_indexes where indexname = 'ops_audit_log_action_idx'`)));
const r = await db.exec(MIGRATION).then(() => ({ ok: true }), (e) => ({ ok: false, msg: e.message }));
ok("migration can be applied twice", r.ok, r.msg);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
