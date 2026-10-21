// Runs migration 0143 (support tickets for ops) in an in-process Postgres (PGlite)
// on top of manager-base.mjs + 0142.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0143.mjs
// Proves escalation, zone visibility and internal-note privacy; it does not replace staging.
import { managerBase, readMigration, id, IDS } from "./manager-base.mjs";

const MIGRATION = readMigration("0143_support_tickets_ops.sql");
const { db, ZA } = await managerBase();
const { A, M, MB, C, R1, R2 } = IDS;
await db.exec(readMigration("0142_manager_orders_live.sql"));
// The shared ticket tables come from 0064 section 3 (the rest of 0064 needs
// tables this abridged base does not have).
{
  const m0064 = readMigration("0064_growth_support.sql").replace(/\r\n/g, "\n");
  const start = m0064.indexOf("-- 3. Support tickets");
  const end = m0064.indexOf("-- 4. Notification inbox");
  if (start < 0 || end < 0) throw new Error("0064 section markers not found");
  await db.exec(m0064.slice(start, end));
}
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

const O1 = id(2001), O2 = id(2002);
await db.exec(`insert into public.orders (id, customer_id, restaurant_id, total) values ('${O1}','${C}','${R1}', 420), ('${O2}','${C}','${R2}', 300)`);

console.log("\n── escalation ──");
ok("escalation needs a reason",
  fails(await srv(`select public.ops_escalate_order('${M}','${O1}','', 'high', 'e0')`), /reason_required/));
let r = await srv(`select public.ops_escalate_order('${M}','${O1}','Kitchen not answering for 30 min', 'high', 'e1') as t`);
ok("a manager escalates an order", r.ok && !!r.rows[0].t.ticket_id && Number(r.rows[0].t.number) > 0);
const T1 = r.rows?.[0]?.t.ticket_id;
let t = await one(`select status, escalation_level, priority, category, zone_id, subject, requester_role from public.support_tickets where id = '${T1}'`);
ok("...an escalated order_issue ticket at level 1 in the order's zone",
  t.status === "escalated" && t.escalation_level === 1 && t.priority === "high" && t.category === "order_issue" && t.zone_id === ZA
  && t.subject === `Order ${O1.slice(0, 8).toUpperCase()}` && t.requester_role === "manager");
ok("...with the reason as its first message",
  (await one(`select count(*)::int as n from public.support_messages where ticket_id = '${T1}' and body like 'Kitchen%'`)).n === 1);
ok("...and an audit row", (await one(`select count(*)::int as n from public.ops_audit_log where action = 'order.escalate' and entity_id = '${O1}'`)).n === 1);
r = await srv(`select public.ops_escalate_order('${M}','${O1}','Kitchen not answering for 30 min', 'high', 'e1') as t`);
ok("replaying the escalation returns the same ticket", r.ok && r.rows[0].t.ticket_id === T1);
ok("...without a second message",
  (await one(`select count(*)::int as n from public.support_messages where ticket_id = '${T1}'`)).n === 1);
r = await srv(`select public.ops_escalate_order('${A}','${O1}','Still nothing after an hour', 'emergency', 'e2') as t`);
ok("a second escalation reuses the open ticket", r.ok && r.rows[0].t.ticket_id === T1);
t = await one(`select escalation_level, priority from public.support_tickets where id = '${T1}'`);
ok("...level 2, priority raised to emergency", t.escalation_level === 2 && t.priority === "emergency");
ok("...one ticket for the order", (await one(`select count(*)::int as n from public.support_tickets where order_id = '${O1}'`)).n === 1);
ok("...and the new message appended", (await one(`select count(*)::int as n from public.support_messages where ticket_id = '${T1}'`)).n === 2);
ok("a manager of another zone cannot escalate",
  fails(await srv(`select public.ops_escalate_order('${MB}','${O1}','Not mine', 'high', 'e3')`), /forbidden/));
ok("a bad priority is refused",
  fails(await srv(`select public.ops_escalate_order('${M}','${O1}','x y z', 'low', 'e4')`), /invalid_transition/));
ok("a signed-in user cannot call it",
  fails(await as("authenticated", M, `select public.ops_escalate_order('${M}','${O1}','Direct', 'high', 'e5')`), /permission denied/));

console.log("\n── who sees what ──");
r = await as("authenticated", M, `select id from public.support_tickets`);
ok("the zone's manager sees the ticket", r.ok && r.rows.length === 1);
r = await as("authenticated", MB, `select id from public.support_tickets`);
ok("another zone's manager does not", r.ok && r.rows.length === 0);
r = await as("authenticated", A, `select id from public.support_tickets`);
ok("an admin does", r.ok && r.rows.length === 1);

// A customer's own ticket with an internal staff note on it.
await db.exec(`
  insert into public.support_tickets (id, requester_id, requester_role, category, subject, order_id)
    values ('${id(3001)}','${C}','customer','order_issue','Late food','${O2}');
  insert into public.support_messages (ticket_id, author_id, author_role, body) values ('${id(3001)}','${C}','customer','Where is it?');
  insert into public.support_messages (ticket_id, author_id, author_role, body, internal) values ('${id(3001)}','${A}','admin','Vendor is slow again', true);
`);
r = await as("authenticated", C, `select id from public.support_tickets`);
ok("a requester reads their own ticket (and not the manager's)", r.ok && r.rows.length === 1);
r = await as("authenticated", C, `select body from public.support_messages`);
ok("...but never an internal note", r.ok && r.rows.length === 1 && r.rows[0].body === "Where is it?");
r = await one(`select zone_id from public.support_tickets where id = '${id(3001)}'`);
ok("a ticket's zone comes from its order", r.zone_id !== ZA && r.zone_id !== null);
r = await as("authenticated", MB, `select body from public.support_messages where ticket_id = '${id(3001)}'`);
ok("the order zone's manager reads the thread, internal notes included", r.ok && r.rows.length === 2);
ok("a requester cannot write messages directly",
  fails(await as("authenticated", C, `insert into public.support_messages (ticket_id, author_id, author_role, body) values ('${id(3001)}','${C}','customer','hi')`), /permission denied/));

console.log("\n── statuses ──");
ok("escalated is a status",
  (await srv(`update public.support_tickets set status = 'escalated' where id = '${id(3001)}' returning id`)).ok);
ok("a made-up status is refused",
  fails(await srv(`update public.support_tickets set status = 'bogus' where id = '${id(3001)}'`), /check constraint/));
ok("escalation level is capped at 3",
  fails(await srv(`update public.support_tickets set escalation_level = 4 where id = '${id(3001)}'`), /check constraint/));
ok("five attachments on a message are refused",
  fails(await srv(`insert into public.support_messages (ticket_id, author_id, author_role, body, attachments)
    values ('${id(3001)}','${A}','admin','x', array['a','b','c','d','e'])`), /check constraint/));

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
