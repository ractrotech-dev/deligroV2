// Runs migration 0165 (support operations) in an in-process Postgres (PGlite)
// on top of support-base.mjs (manager base + 0142 + 0064 §3 + 0143 + 0145).
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0165.mjs
// Proves the ticket transition table, reopen rules, assignment eligibility,
// priority and escalation, the requester-safe event history and the metrics
// RPC; it does not replace staging.
import { readMigration, id, IDS } from "./manager-base.mjs";
import { supportBase } from "./support-base.mjs";

const MIGRATION = readMigration("0165_support_ops.sql");
const { db, ZA, ZB } = await supportBase();
const { A, M, MB, C, R1, R2 } = IDS;
// 0151 owns _ops_replay_matches (deploy order 0145 → 0151 → 0165).
await db.exec(readMigration("0151_manager_riders.sql"));
await db.exec(`insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
               values ('support-attachments','support-attachments',false,5242880,array['image/jpeg','image/png'])
               on conflict (id) do nothing`);
await db.exec(`grant select on all tables in schema public to authenticated;`);
await db.exec(MIGRATION);

let passed = 0, failed = 0;
const ok = (n, c, extra) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}${!c && extra ? `\n         ${extra}` : ""}`); };
async function as(role, uid, sql) {
  const claims = role === "service_role" ? { role: "service_role" } : {};
  await db.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false); select set_config('test.jwt','${JSON.stringify(claims)}',false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec("reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);"); }
}
const fails = (r, re) => !r.ok && re.test(r.msg);
const srv = (sql) => as("service_role", null, sql);
const one = async (sql) => (await db.query(sql)).rows[0];
const audits = async (action) => (await one(`select count(*)::int as n from public.ops_audit_log where action = '${action}'`)).n;
const events = async (t, kind) => (await one(`select count(*)::int as n from public.support_ticket_events where ticket_id = '${t}' and kind = '${kind}'`)).n;
const st = async (t) => (await one(`select status, reopened_count, escalation_level, priority, assigned_to, team from public.support_tickets where id = '${t}'`));

const T1 = id(901), T2 = id(902), T3 = id(903);
const OA = [id(951), id(952), id(953), id(954)], OB = id(955);
// A ticket's zone comes from its order (0143); its shop from the order too (0145).
await db.exec(`
  insert into public.orders (id, customer_id, restaurant_id) values
    ('${OA[0]}','${C}','${R1}'),('${OA[1]}','${C}','${R1}'),('${OA[2]}','${C}','${R1}'),('${OA[3]}','${C}','${R1}'),('${OB}','${C}','${R2}');
  insert into public.support_tickets (id, requester_id, requester_role, category, subject, order_id)
  values ('${T1}','${C}','customer','order_issue','Cold food','${OA[0]}'),
         ('${T2}','${C}','customer','order_issue','Late again','${OA[1]}'),
         ('${T3}','${C}','customer','other','Saja question','${OB}');
`);

console.log("\n── created event and transition table ──");
ok("a new ticket records a created event", (await events(T1, "created")) === 1);
let r = await srv(`select public.ops_set_ticket_status('${M}','${T1}','in_progress',null,null,'s1') as s`);
ok("open → in_progress", r.ok && (await st(T1)).status === "in_progress", r.msg);
ok("...is a status event", (await events(T1, "status")) === 1);
r = await srv(`select public.ops_set_ticket_status('${M}','${T1}','waiting_on_requester',null,null,'s2')`);
ok("in_progress → waiting_on_requester", r.ok, r.msg);
r = await srv(`select public.ops_set_ticket_status('${M}','${T1}','resolved',null,null,'s3')`);
ok("resolving without a resolution → reason_required", fails(r, /reason_required/));
r = await srv(`select public.ops_set_ticket_status('${M}','${T1}','resolved','Refund issued',null,'s4')`);
ok("waiting_on_requester → resolved with a resolution", r.ok && (await st(T1)).status === "resolved", r.msg);
r = await srv(`select public.ops_set_ticket_status('${M}','${T1}','in_progress',null,null,'s5')`);
ok("reopening without a reason → reason_required", fails(r, /reason_required/));
r = await srv(`select public.ops_set_ticket_status('${M}','${T1}','in_progress',null,'Customer wrote back','s6')`);
let s = await st(T1);
ok("resolved → in_progress with a reason reopens", r.ok && s.status === "in_progress" && s.reopened_count === 1, r.msg);
ok("...and records a reopened event", (await events(T1, "reopened")) === 1);
r = await srv(`select public.ops_set_ticket_status('${M}','${T1}','escalated',null,null,'s7')`);
ok("escalated is not a plain status move → invalid_transition", fails(r, /invalid_transition/));
r = await srv(`select public.ops_set_ticket_status('${M}','${T1}','resolved','Done',null,'s8')`);
r = await srv(`select public.ops_set_ticket_status('${M}','${T1}','closed',null,null,'s9')`);
ok("resolved → closed reuses the resolution", r.ok && (await st(T1)).status === "closed", r.msg);
r = await srv(`select public.ops_set_ticket_status('${M}','${T1}','in_progress',null,'Again','s10')`);
ok("closed is final → invalid_transition", fails(r, /invalid_transition/));
r = await srv(`select public.ops_set_ticket_status('${M}','${T2}','closed','Spam',null,'s11')`);
ok("open → closed is not allowed → invalid_transition", fails(r, /invalid_transition/));
r = await srv(`select public.ops_set_ticket_status('${M}','${T2}','in_progress',null,'s12')`);
ok("the 0145 five-argument form still works", r.ok && (await st(T2)).status === "in_progress", r.msg);
r = await srv(`select public.ops_set_ticket_status('${MB}','${T2}','resolved','x y z',null,'s13')`);
ok("a manager of another zone cannot move it → forbidden", fails(r, /forbidden/));

console.log("\n── requester reply reopens ──");
await srv(`select public.ops_set_ticket_status('${M}','${T2}','resolved','Sorted out',null,'s14')`);
await db.exec(`insert into public.support_messages (ticket_id, author_id, author_role, body) values ('${T2}','${C}','customer','Still cold')`);
s = await st(T2);
ok("a requester reply on a resolved ticket → in_progress", s.status === "in_progress" && s.reopened_count === 1, JSON.stringify(s));
ok("...with a reopened event", (await events(T2, "reopened")) === 1);

console.log("\n── one path for a requester's reply; closed is final (review #1) ──");
const T4 = id(904);
await db.exec(`insert into public.support_tickets (id, requester_id, requester_role, category, subject, order_id)
               values ('${T4}','${C}','customer','order_issue','Missing item','${OA[2]}')`);
await srv(`select public.ops_set_ticket_status('${M}','${T4}','waiting_on_requester',null,null,'q1')`);
await db.exec(`insert into public.support_messages (ticket_id, author_id, author_role, body) values ('${T4}','${C}','customer','Here is the photo')`);
s = await st(T4);
ok("a reply on a ticket waiting for the requester → in_progress (never 'open')", s.status === "in_progress" && s.reopened_count === 0, JSON.stringify(s));
await srv(`select public.ops_set_ticket_status('${M}','${T4}','resolved','Replaced the item',null,'q2')`);
const resolvedAt = (await one(`select resolved_at from public.support_tickets where id = '${T4}'`)).resolved_at;
r = await as("service_role", null, `update public.support_tickets set resolved_at = null where id = '${T4}'`);
ok("resolved_at can never be cleared, by any writer",
  (await one(`select resolved_at from public.support_tickets where id = '${T4}'`)).resolved_at?.toISOString() === resolvedAt?.toISOString(), r.msg);
r = await as("service_role", null, `update public.support_tickets set status = 'open' where id = '${T4}'`);
ok("resolved → open is refused for every writer, service role included", fails(r, /invalid_transition/), r.msg);
await srv(`select public.ops_set_ticket_status('${M}','${T4}','closed',null,null,'q3')`);
r = await as("service_role", null, `update public.support_tickets set status = 'open', resolved_at = null where id = '${T4}'`);
ok("closed is final: closed → open is refused", fails(r, /invalid_transition/), r.msg);
r = await as("service_role", null, `update public.support_tickets set status = 'in_progress' where id = '${T4}'`);
ok("...and closed → in_progress too", fails(r, /invalid_transition/), r.msg);
try {
  await db.exec(`insert into public.support_messages (ticket_id, author_id, author_role, body) values ('${T4}','${C}','customer','One more thing')`);
  ok("a requester reply on a closed ticket is refused (ticket_closed)", false, "the insert succeeded");
} catch (e) { ok("a requester reply on a closed ticket is refused (ticket_closed)", /ticket_closed/.test(String(e.message)), e.message); }
ok("...the closed ticket stays closed with its resolution time", (await st(T4)).status === "closed" &&
  (await one(`select resolved_at from public.support_tickets where id = '${T4}'`)).resolved_at !== null);
await db.exec(`insert into public.support_messages (ticket_id, author_id, author_role, body, internal) values ('${T4}','${M}','manager','Note to self',true)`);
ok("staff internal notes on a closed ticket are still fine", (await one(`select count(*)::int as n from public.support_messages where ticket_id = '${T4}' and internal`)).n === 1);

console.log("\n── assignment ──");
r = await srv(`select public.ops_assign_ticket('${M}','${T2}','${M}','operations','a1')`);
s = await st(T2);
ok("assign to a zone-A manager with support access", r.ok && s.assigned_to === M && s.team === "operations", r.msg);
ok("...writes assigned and team events and one audit row",
  (await events(T2, "assigned")) === 1 && (await events(T2, "team")) === 1 && (await audits("ticket.assign")) === 1);
r = await srv(`select public.ops_assign_ticket('${M}','${T2}','${M}','operations','a1')`);
ok("a replayed assignment changes nothing", r.ok && (await audits("ticket.assign")) === 1 && (await events(T2, "assigned")) === 1, r.msg + " audits=" + (await audits("ticket.assign")) + " ev=" + (await events(T2, "assigned")));
r = await srv(`select public.ops_assign_ticket('${M}','${T2}','${MB}',null,'a2')`);
ok("assign to a manager of another zone → assignee_ineligible", fails(r, /assignee_ineligible/));
r = await srv(`select public.ops_assign_ticket('${M}','${T2}','${C}',null,'a3')`);
ok("assign to a customer → assignee_ineligible", fails(r, /assignee_ineligible/));
r = await srv(`select public.ops_assign_ticket('${M}','${T2}','${A}','finance','a4')`);
ok("assign to an admin", r.ok && (await st(T2)).assigned_to === A, r.msg);
r = await srv(`select public.ops_assign_ticket('${M}','${T2}',null,'nonsense','a5')`);
ok("an unknown team → bad_team", fails(r, /bad_team/));
await db.exec(`insert into public.role_feature_flags (role, feature, enabled, subject_kind, subject_id)
               values ('manager','manager.support.manage',false,'profile','${M}')`);
r = await srv(`select public.ops_assign_ticket('${A}','${T2}','${M}',null,'a6')`);
ok("a manager whose support switch is off → assignee_ineligible", fails(r, /assignee_ineligible/));
await db.exec(`delete from public.role_feature_flags`);
r = await srv(`select public.ops_assign_ticket('${M}','${T2}',null,null,'a7')`);
ok("unassign", r.ok && (await st(T2)).assigned_to === null, r.msg);

console.log("\n── priority and escalation ──");
r = await srv(`select public.ops_set_ticket_priority('${M}','${T2}','high',null,'p1')`);
ok("priority change without a reason → reason_required", fails(r, /reason_required/));
r = await srv(`select public.ops_set_ticket_priority('${M}','${T2}','high','Repeat complaint','p2')`);
ok("priority change with a reason", r.ok && (await st(T2)).priority === "high" && (await events(T2, "priority")) === 1, r.msg);
r = await srv(`select public.ops_set_ticket_priority('${M}','${T2}','urgent','x y z','p3')`);
ok("an unknown priority → bad_request", fails(r, /bad_request/));
r = await srv(`select public.ops_escalate_ticket('${M}','${T2}',null,'e0')`);
ok("escalating without a reason → reason_required", fails(r, /reason_required/));
for (const [i, n] of [[1, "e1"], [2, "e2"], [3, "e3"]]) {
  r = await srv(`select public.ops_escalate_ticket('${M}','${T2}','Not moving','${n}') as level`);
  ok(`escalation ${i} → level ${i}`, r.ok && r.rows[0].level === i, r.msg);
}
s = await st(T2);
ok("...status escalated, three escalated events", s.status === "escalated" && (await events(T2, "escalated")) === 3);
r = await srv(`select public.ops_escalate_ticket('${M}','${T2}','Not moving','e4')`);
ok("a fourth escalation → max_level", fails(r, /max_level/));
r = await srv(`select public.ops_set_ticket_status('${M}','${T2}','in_progress',null,null,'s15')`);
ok("escalated → in_progress", r.ok && (await st(T2)).status === "in_progress", r.msg);

console.log("\n── internal attachments and who sees events ──");
r = await srv(`select public.ops_add_ticket_message('${M}','${T2}','Photo of the bag',true,array['${T2}/a.jpg'],'m1')`);
ok("an internal message with an attachment", r.ok, r.msg);
let ev = await one(`select internal from public.support_ticket_events where ticket_id = '${T2}' and kind = 'attachment'`);
ok("...records an internal attachment event", ev?.internal === true);
r = await srv(`select public.ops_add_ticket_message('${M}','${T2}','Sorry about that',false,'m2')`);
ok("the 0145 five-argument message form still works", r.ok, r.msg);
r = await as("authenticated", C, `select count(*)::int as n from public.support_ticket_events where ticket_id = '${T2}' and internal`);
ok("the requester sees no internal event", r.ok && r.rows[0].n === 0, r.msg);
r = await as("authenticated", C, `select count(*)::int as n from public.support_ticket_events where ticket_id = '${T2}'`);
ok("...but does see the status history of their ticket", r.ok && r.rows[0].n >= 2, r.msg);
r = await as("authenticated", C, `select count(*)::int as n from public.support_ticket_events
                                   where ticket_id = '${T2}' and kind not in ('status','created','first_response','attachment')`);
ok("the requester sees only status, created, first_response and attachment events (review #10)", r.ok && r.rows[0].n === 0, r.msg);
r = await as("authenticated", C, `select reason from public.support_ticket_events where ticket_id = '${T2}'`);
ok("...and cannot read the staff-written reason column at all", fails(r, /permission denied/i), r.msg);
r = await as("authenticated", C, `select actor_id from public.support_ticket_events where ticket_id = '${T2}'`);
ok("...nor who acted", fails(r, /permission denied/i), r.msg);
r = await as("authenticated", M, `select count(*)::int as n from public.support_ticket_events where ticket_id = '${T2}' and internal`);
ok("a zone-A manager sees the internal event", r.ok && r.rows[0].n === 1, r.msg);
r = await as("authenticated", MB, `select count(*)::int as n from public.support_ticket_events where ticket_id = '${T2}'`);
ok("a zone-B manager sees none of zone A's history", r.ok && r.rows[0].n === 0, r.msg);
r = await as("authenticated", M, `update public.support_ticket_events set reason = 'x'`);
ok("events cannot be updated by a signed-in user", !r.ok || (await one(`select count(*)::int as n from public.support_ticket_events where reason = 'x'`)).n === 0);
r = await as("authenticated", A, `delete from public.support_ticket_events`);
ok("...nor deleted, even by an admin", !r.ok || (await one(`select count(*)::int as n from public.support_ticket_events`)).n > 0);

console.log("\n── metrics ──");
await db.exec(`
  delete from public.support_ticket_events; delete from public.support_messages; delete from public.support_tickets;
  insert into public.support_tickets (id, requester_id, requester_role, category, subject, order_id, created_at, first_response_at, resolved_at, status, resolution)
  values ('${id(911)}','${C}','customer','order_issue','a','${OA[0]}', now() - interval '3 hours', now() - interval '3 hours' + interval '10 minutes', now() - interval '2 hours', 'resolved','x y'),
         ('${id(912)}','${C}','customer','order_issue','b','${OA[1]}', now() - interval '3 hours', now() - interval '3 hours' + interval '20 minutes', now() - interval '1 hour', 'resolved','x y'),
         ('${id(913)}','${C}','customer','delivery','c','${OA[2]}', now() - interval '3 hours', now() - interval '3 hours' + interval '30 minutes', null, 'in_progress', null),
         ('${id(914)}','${C}','customer','other','d','${OB}', now() - interval '2 hours', null, null, 'open', null);
`);
const ist = (await one(`select (now() at time zone 'Asia/Kolkata')::date::text as d`)).d;
r = await srv(`select public.ops_ticket_metrics(null, true, '${ist}'::date - 1, '${ist}'::date + 0, 30) as m`);
const m = r.ok ? r.rows[0].m : null;
ok("metrics run for an admin scope", !!m, r.msg);
if (m) {
  ok("created 4, resolved 2", m.created === 4 && m.resolved === 2, JSON.stringify({ c: m.created, r: m.resolved }));
  ok("first response: average 20, median 20 over 3", m.firstResponse.avgMinutes === 20 && m.firstResponse.medianMinutes === 20 && m.firstResponse.count === 3, JSON.stringify(m.firstResponse));
  ok("resolution: average 90 over 2", m.resolution.avgMinutes === 90 && m.resolution.count === 2, JSON.stringify(m.resolution));
  ok("one open ticket past the 30-minute first-response rule", m.openOverSla === 1, String(m.openOverSla));
  ok("recurring vendors sorted by count", m.recurring.vendors[0]?.id === R1 && m.recurring.vendors[0]?.count === 3, JSON.stringify(m.recurring.vendors));
  ok("recurring categories carry a share", m.recurring.categories[0]?.key === "order_issue" && Math.abs(m.recurring.categories[0].share - 0.5) < 1e-9, JSON.stringify(m.recurring.categories));
  ok("by priority and requester role", m.byPriority.normal === 4 && m.byRequesterRole.customer === 4);
  ok("daily rows in IST dates", Array.isArray(m.daily) && m.daily.some((d) => d.date === ist && d.created >= 1), JSON.stringify(m.daily));
}
r = await srv(`select public.ops_ticket_metrics(array['${ZA}']::uuid[], false, '${ist}'::date - 1, '${ist}'::date, 30) as m`);
ok("a zone-A scope counts only zone A's tickets", r.ok && r.rows[0].m.created === 3, r.msg);
r = await as("authenticated", M, `select public.ops_ticket_metrics(null, true, current_date - 1, current_date, 30)`);
ok("metrics are service-role only", fails(r, /permission denied/));

console.log("\n── attachments bucket ──");
const bucket = await one(`select allowed_mime_types from storage.buckets where id = 'support-attachments'`);
ok("staff attachments may be JPEG, PNG, WebP or PDF",
  ["image/jpeg", "image/png", "image/webp", "application/pdf"].every((m) => bucket?.allowed_mime_types?.includes(m)), JSON.stringify(bucket));

console.log("\n── unread counts and the rider filter, in the database (review #24) ──");
// T3 (zone B): staff replied, then the requester wrote twice; an internal note and a staff reply in the other order on T2.
const U1 = id(931);
await db.exec(`insert into public.support_tickets (id, requester_id, requester_role, category, subject, order_id)
               values ('${U1}','${C}','customer','order_issue','Unread test','${OA[3]}')`);
await db.exec(`
  insert into public.support_messages (ticket_id, author_id, author_role, body, created_at) values
    ('${U1}','${C}','customer','one',   now() - interval '50 minutes'),
    ('${U1}','${M}','manager','reply',  now() - interval '40 minutes'),
    ('${U1}','${C}','customer','two',   now() - interval '30 minutes'),
    ('${U1}','${C}','customer','three', now() - interval '20 minutes');
  insert into public.support_messages (ticket_id, author_id, author_role, body, internal, created_at) values
    ('${U1}','${M}','manager','note to self', true, now() - interval '10 minutes');
`);
r = await srv(`select * from public.ops_ticket_unread_counts(array['${U1}','${T2}']::uuid[])`);
const unread = Object.fromEntries((r.rows ?? []).map((x) => [x.ticket_id, x.unread]));
ok("unread = the requester's messages since staff last answered; an internal note does not answer", r.ok && unread[U1] === 2, JSON.stringify(unread) + (r.msg ?? ""));
await db.exec(`insert into public.support_messages (ticket_id, author_id, author_role, body, created_at) values ('${U1}','${M}','manager','answered',now())`);
r = await srv(`select * from public.ops_ticket_unread_counts(array['${U1}']::uuid[])`);
ok("...a staff answer resets it to 0", r.ok && (r.rows?.[0]?.unread ?? 0) === 0, JSON.stringify(r.rows));
r = await as("authenticated", M, `select * from public.ops_ticket_unread_counts(array['${U1}']::uuid[])`);
ok("service role only", fails(r, /permission denied/), r.msg);

await db.exec(`insert into public.deliveries (order_id, driver_id, status) values ('${OA[3]}','${IDS.D1}','assigned') on conflict do nothing`);
r = await srv(`select public.ops_rider_ticket_ids('${IDS.D1}', null, true) as ids`);
ok("tickets about a rider's deliveries are found by a join, with no cap on how many deliveries they had",
  r.ok && Array.isArray(r.rows[0].ids) && r.rows[0].ids.includes(U1), JSON.stringify(r.rows?.[0]) + (r.msg ?? ""));
r = await srv(`select public.ops_rider_ticket_ids('${IDS.D1}', array['${ZB}']::uuid[], false) as ids`);
ok("...limited to the zones asked for: zone B has none of them", r.ok && !r.rows[0].ids.includes(U1), JSON.stringify(r.rows?.[0]));
r = await srv(`select public.ops_rider_ticket_ids('${IDS.D1}', array['${ZA}']::uuid[], false) as ids`);
ok("...and zone A has it", r.ok && r.rows[0].ids.includes(U1), JSON.stringify(r.rows?.[0]));

console.log("\n── idempotent ──");
r = await db.exec(MIGRATION).then(() => ({ ok: true }), (e) => ({ ok: false, msg: e.message }));
ok("migration can be applied twice", r.ok, r.msg);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
