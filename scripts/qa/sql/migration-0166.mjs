// Runs migration 0166 (ops alerts) in an in-process Postgres (PGlite) on top of
// support-base.mjs + 0151 (deploy order … → 0151 → 0165 → 0166).
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0166.mjs
// Proves dedupe, severity rises, auto-clear, the 15-minute anti-flap, audited
// acknowledge / resolve / incident / thresholds, zone visibility and the
// evaluation lease; it does not replace staging.
import { readMigration, IDS } from "./manager-base.mjs";
import { supportBase } from "./support-base.mjs";

const MIGRATION = readMigration("0166_ops_alerts.sql");
const { db, ZA, ZB } = await supportBase();
const { A, M, MB, C } = IDS;
await db.exec(readMigration("0151_manager_riders.sql"));
await db.exec(readMigration("0165_support_ops.sql"));
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
const raise = (kind, sev, zone, key, entity = "order") =>
  srv(`select public.ops_raise_alert('${kind}','${sev}','Title','Body',${zone ? `'${zone}'` : "null"},'${entity}','x','${key}') as a`);
const alertBy = async (key) => one(`select * from public.ops_alerts where dedupe_key = '${key}'`);

console.log("\n── default rules ──");
let row = await one(`select count(*)::int as n, count(*) filter (where not enabled)::int as off from public.ops_alert_rules where zone_id is null`);
ok("one platform default per kind (16), fraud and SLA off", row.n === 16 && row.off === 2, JSON.stringify(row));
row = await one(`select threshold::float as t, window_minutes as w from public.ops_alert_rules where kind = 'high_cancellation_rate' and zone_id is null`);
ok("cancellation default 20 % over 60 min", row.t === 20 && row.w === 60);

console.log("\n── raise, dedupe, severity ──");
let r = await raise("order_unassigned", "warning", ZA, "order_unassigned:o1");
ok("a new alert pushes", r.ok && r.rows[0].a.push === true, r.msg);
// The engine marks every push it sends (the cooldown counts from it).
await srv(`select public.ops_mark_alert_pushed('${r.rows?.[0]?.a?.id}')`);
r = await raise("order_unassigned", "warning", ZA, "order_unassigned:o1");
ok("the same key again: one row, no push", r.ok && r.rows[0].a.push === false &&
  (await one(`select count(*)::int as n from public.ops_alerts where dedupe_key = 'order_unassigned:o1'`)).n === 1);
r = await raise("order_unassigned", "critical", ZA, "order_unassigned:o1");
ok("rising to critical pushes once", r.ok && r.rows[0].a.push === true && (await alertBy("order_unassigned:o1")).severity === "critical");
r = await raise("order_unassigned", "warning", ZA, "order_unassigned:o1");
ok("a lower severity never lowers it, and does not push", r.ok && r.rows[0].a.push === false && (await alertBy("order_unassigned:o1")).severity === "critical");
ok("...an escalated_severity event", (await one(`select count(*)::int as n from public.ops_alert_events where event = 'escalated_severity'`)).n === 1);
r = await raise("bogus_kind", "warning", ZA, "x:1");
ok("an unknown kind is refused", fails(r, /bad_kind/));

console.log("\n── auto-clear and anti-flap ──");
await raise("order_unassigned", "warning", ZA, "order_unassigned:o2");
r = await srv(`select public.ops_clear_alerts('order_unassigned', array['order_unassigned:o2']) as n`);
ok("clearing resolves every key not kept", r.ok && r.rows[0].n === 1 && (await alertBy("order_unassigned:o1")).status === "resolved", r.msg);
ok("...as 'cleared' by nobody", (await alertBy("order_unassigned:o1")).resolution === "cleared" && (await alertBy("order_unassigned:o1")).resolved_by === null);
ok("...and keeps the one still true", (await alertBy("order_unassigned:o2")).status === "open");
r = await raise("order_unassigned", "warning", ZA, "order_unassigned:o1");
let a = await alertBy("order_unassigned:o1");
ok("raised again within 15 minutes: reopened, no push", r.ok && r.rows[0].a.push === false && a.status === "open" && a.reopen_count === 1);
await db.exec(`update public.ops_alerts set status = 'resolved', resolved_at = now() - interval '16 minutes' where dedupe_key = 'order_unassigned:o1'`);
r = await raise("order_unassigned", "warning", ZA, "order_unassigned:o1");
ok("after the cooldown a reopen pushes again", r.ok && r.rows[0].a.push === true);

// An alert that was open for hours (its last push long ago), cleared, and flaps
// back a moment later is the SAME incident: no new push (review #17).
await raise("order_unassigned", "warning", ZA, "order_unassigned:flap");
await db.exec(`update public.ops_alerts set last_pushed_at = now() - interval '5 hours' where dedupe_key = 'order_unassigned:flap'`);
await srv(`select public.ops_clear_alerts('order_unassigned', array['order_unassigned:o1','order_unassigned:o2'])`);
r = await raise("order_unassigned", "warning", ZA, "order_unassigned:flap");
ok("a long-open alert that clears and flaps back within 15 minutes does not push again (cooldown from the clear)",
  r.ok && r.rows[0].a.push === false, JSON.stringify(r.rows?.[0]));
r = await srv(`select public.ops_mark_alert_pushed('${(await alertBy("order_unassigned:o1")).id}')`);
ok("marking pushed", r.ok && (await alertBy("order_unassigned:o1")).last_pushed_at !== null, r.msg);

console.log("\n── acknowledge and resolve ──");
const id1 = (await alertBy("order_unassigned:o1")).id;
r = await srv(`select public.ops_ack_alert('${M}','${id1}','k1')`);
ok("a zone manager acknowledges", r.ok && (await alertBy("order_unassigned:o1")).status === "acknowledged" && (await audits("alert.acknowledge")) === 1, r.msg);
r = await srv(`select public.ops_ack_alert('${M}','${id1}','k1')`);
ok("a replayed acknowledgement adds nothing", r.ok && (await audits("alert.acknowledge")) === 1, r.msg);
r = await srv(`select public.ops_ack_alert('${MB}','${id1}','k2')`);
ok("a manager of another zone cannot → forbidden", fails(r, /forbidden/));
r = await srv(`select public.ops_resolve_alert('${M}','${id1}',null,'k3')`);
ok("resolving without a note → reason_required", fails(r, /reason_required/));
r = await srv(`select public.ops_resolve_alert('${M}','${id1}','Rider found','k4')`);
a = await alertBy("order_unassigned:o1");
ok("resolving with a note", r.ok && a.status === "resolved" && a.resolution === "Rider found" && a.resolved_by === M, r.msg);
ok("...audited", (await audits("alert.resolve")) === 1);
r = await srv(`select public.ops_resolve_alert('${M}','${id1}','Again','k5')`);
ok("resolving twice → already_resolved", fails(r, /already_resolved/));

console.log("\n── who sees what: nobody reads alerts directly (review #11) ──");
await raise("rider_shortage", "warning", ZB, "rider_shortage:zb");
await raise("rider_shortage", "warning", null, "rider_shortage:all");
r = await srv(`select public.ops_raise_incident('${M}','${ZA}','Payments down','Razorpay returns errors','critical','i1') as id`);
ok("a manager raises an incident in their zone", r.ok && !!r.rows[0].id && (await audits("alert.incident")) === 1, r.msg);
await raise("incident", "critical", null, "incident:obs:1", "incident");
for (const [who, uid] of [["a zone manager", M], ["an admin", A], ["a customer", C]]) {
  r = await as("authenticated", uid, `select count(*)::int as n from public.ops_alerts`);
  ok(`${who} cannot read ops_alerts through PostgREST (the routes scope by zone and permission)`, fails(r, /permission denied/i), r.msg);
  r = await as("authenticated", uid, `select count(*)::int as n from public.ops_alert_events`);
  ok(`${who} cannot read ops_alert_events either`, fails(r, /permission denied/i), r.msg);
}
r = await srv(`select public.ops_alert_counts(array['${ZA}']::uuid[], false, null) as c`);
ok("counts for a zone: its alerts plus platform-wide incidents only",
  r.ok && r.rows[0].c.open >= 2 && r.rows[0].c.critical >= 2, JSON.stringify(r.rows?.[0]));
r = await srv(`select public.ops_alert_counts(array[]::uuid[], false, null) as c`);
ok("...a manager with no zones counts only platform-wide incidents", r.ok && r.rows[0].c.open === 1, JSON.stringify(r.rows?.[0]));
r = await srv(`select public.ops_alert_counts(null, true, array['incident']) as c`);
ok("...an admin filtered to one kind", r.ok && r.rows[0].c.open === 2, JSON.stringify(r.rows?.[0]));
const incNull = (await alertBy("incident:obs:1")).id;
r = await srv(`select public.ops_ack_alert('${M}','${incNull}','k6')`);
ok("a manager may acknowledge a platform-wide incident", r.ok, r.msg);
r = await srv(`select public.ops_ack_alert('${M}','${(await alertBy("rider_shortage:all")).id}','k7')`);
ok("...but not another platform-wide alert → forbidden", fails(r, /forbidden/));
r = await as("authenticated", M, `select public.ops_raise_alert('incident','info','t','b',null,'incident','x','k:x')`);
ok("raising is service-role only", fails(r, /permission denied/));

console.log("\n── incidents are rate-limited (review #13) ──");
for (const n of [2, 3]) {
  r = await srv(`select public.ops_raise_incident('${M}','${ZA}','Another ${n}','Something else is down','warning','i${n}') as id`);
  ok(`a manager's incident ${n} within the hour is allowed`, r.ok, r.msg);
}
r = await srv(`select public.ops_raise_incident('${M}','${ZA}','One too many','Something else is down','warning','i4') as id`);
ok("the manager's fourth in an hour → rate_limited", fails(r, /rate_limited/), r.msg);
r = await srv(`select public.ops_raise_incident('${M}','${ZA}','Another 2','Something else is down','warning','i2') as id`);
ok("...but a replay of an earlier one is still answered", r.ok, r.msg);
r = await srv(`select public.ops_raise_incident('${A}','${ZA}','Admin incident','Admins get a larger budget','warning','ia1') as id`);
ok("an admin has their own, larger budget", r.ok, r.msg);

console.log("\n── thresholds ──");
r = await srv(`select public.ops_set_alert_rule('${M}','order_unassigned','${ZA}',true,7,null,'r1')`);
row = await one(`select threshold::float as t from public.ops_alert_rules where kind = 'order_unassigned' and zone_id = '${ZA}'`);
ok("a manager sets their zone's threshold", r.ok && row?.t === 7, r.msg);
row = await one(`select before, after from public.ops_audit_log where action = 'alert_rule.set'`);
ok("...audited with before and after", row && row.before?.threshold === 5 && row.after?.threshold === 7, JSON.stringify(row));
r = await srv(`select public.ops_set_alert_rule('${M}','order_unassigned',null,true,7,null,'r2')`);
ok("a manager cannot change the platform default → forbidden", fails(r, /forbidden/));
r = await srv(`select public.ops_set_alert_rule('${A}','order_unassigned',null,true,6,null,'r3')`);
ok("an admin can", r.ok && (await one(`select threshold::float as t from public.ops_alert_rules where kind = 'order_unassigned' and zone_id is null`)).t === 6, r.msg);
r = await srv(`select public.ops_set_alert_rule('${M}','order_unassigned','${ZA}',true,0,null,'r4')`);
ok("a threshold out of bounds → bad_threshold", fails(r, /bad_threshold/));
r = await srv(`select public.ops_set_alert_rule('${M}','high_cancellation_rate','${ZA}',true,150,60,'r5')`);
ok("a percentage over 100 → bad_threshold", fails(r, /bad_threshold/));
r = await srv(`select public.ops_set_alert_rule('${M}','high_cancellation_rate','${ZA}',true,20,1440,'r5b')`);
ok("a window of a day (1440 min) is allowed", r.ok, r.msg);
r = await srv(`select public.ops_set_alert_rule('${M}','high_cancellation_rate','${ZA}',true,20,1441,'r5c')`);
ok("...1441 min → bad_threshold (a zone cannot force a platform-wide scan)", fails(r, /bad_threshold/));
r = await srv(`select public.ops_set_alert_rule('${M}','high_cancellation_rate','${ZA}',true,20,10080,'r5d')`);
ok("...nor a week", fails(r, /bad_threshold/));
r = await db.exec(`insert into public.ops_alert_rules (kind, zone_id, window_minutes) values ('high_cancellation_rate','${ZB}',10080)`)
  .then(() => ({ ok: true }), (e) => ({ ok: false, msg: String(e.message) }));
ok("the table itself refuses a window over a day", fails(r, /check constraint|violates/i), r.msg);
r = await srv(`select public.ops_set_alert_rule('${M}','delivery_failed','${ZA}',false,null,null,'r6')`);
ok("a kind without a threshold can be switched off for a zone", r.ok, r.msg);
r = await srv(`select public.ops_set_alert_rule('${MB}','order_unassigned','${ZA}',true,9,null,'r7')`);
ok("another zone's manager → forbidden", fails(r, /forbidden/));
r = await srv(`select public.ops_reset_alert_rule('${M}','order_unassigned','${ZA}','r8')`);
ok("reset reverts to the default", r.ok && !(await one(`select 1 as x from public.ops_alert_rules where kind = 'order_unassigned' and zone_id = '${ZA}'`)) && (await audits("alert_rule.reset")) === 1, r.msg);
r = await as("authenticated", M, `select count(*)::int as n from public.ops_alert_rules`);
ok("managers read every rule", r.ok && r.rows[0].n >= 16, r.msg);
r = await as("authenticated", M, `update public.ops_alert_rules set threshold = 99`);
ok("...but cannot write them", !r.ok || (await one(`select count(*)::int as n from public.ops_alert_rules where threshold = 99`)).n === 0);

console.log("\n── a manual resolve sticks until the condition has cleared (review #4) ──");
await raise("order_unassigned", "warning", ZA, "order_unassigned:stick");
const stick = (await alertBy("order_unassigned:stick")).id;
r = await srv(`select public.ops_resolve_alert('${M}','${stick}','Rider is on the way','st1')`);
r = await raise("order_unassigned", "warning", ZA, "order_unassigned:stick");
let st = await alertBy("order_unassigned:stick");
ok("still true a minute later: it stays resolved, no push, no reopen count",
  r.ok && r.rows[0].a.push === false && st.status === "resolved" && st.reopen_count === 0 && st.resolution === "Rider is on the way", JSON.stringify(st));
r = await raise("order_unassigned", "critical", ZA, "order_unassigned:stick");
st = await alertBy("order_unassigned:stick");
ok("it reopens when the severity rises above what was resolved", r.ok && st.status === "open" && st.severity === "critical" && st.reopen_count === 1, JSON.stringify(st));
await srv(`select public.ops_resolve_alert('${M}','${stick}','Fixed it','st2')`);
await db.exec(`update public.ops_alerts set last_seen_at = now() - interval '10 minutes' where dedupe_key = 'order_unassigned:stick'`);
await srv(`select public.ops_clear_alerts('order_unassigned', array[]::text[], now())`);
r = await raise("order_unassigned", "critical", ZA, "order_unassigned:stick");
st = await alertBy("order_unassigned:stick");
ok("once the condition has cleared and then returns, it reopens", r.ok && st.status === "open", JSON.stringify(st));

console.log("\n── clearing only touches what this run did not see (review #5) ──");
await raise("delivery_failed", "critical", ZA, "delivery_failed:old");
await db.exec(`update public.ops_alerts set last_seen_at = now() - interval '10 minutes' where dedupe_key = 'delivery_failed:old'`);
const runStart = (await one(`select (now() - interval '1 minute')::text as t`)).t;
await raise("delivery_failed", "critical", ZA, "delivery_failed:mid");
r = await srv(`select public.ops_clear_alerts('delivery_failed', array[]::text[], '${runStart}') as n`);
ok("an alert raised after the run began is not cleared; an older one is",
  r.ok && r.rows[0].n === 1 && (await alertBy("delivery_failed:mid")).status === "open" && (await alertBy("delivery_failed:old")).status === "resolved", JSON.stringify(r.rows?.[0]) + r.msg);

console.log("\n── unacknowledged critical alerts do not vanish (review #21) ──");
await raise("cash_discrepancy", "critical", ZA, "cash_discrepancy:keep1");
await raise("cash_discrepancy", "critical", ZA, "cash_discrepancy:keep2");
await db.exec(`update public.ops_alerts set last_seen_at = now() - interval '10 minutes' where kind = 'cash_discrepancy'`);
await srv(`select public.ops_ack_alert('${M}','${(await alertBy("cash_discrepancy:keep2")).id}','k9')`);
r = await srv(`select public.ops_clear_alerts('cash_discrepancy', array[]::text[], now(), true) as n`);
ok("with keep-unacknowledged, only the acknowledged one is cleared",
  r.ok && r.rows[0].n === 1 && (await alertBy("cash_discrepancy:keep1")).status === "open" && (await alertBy("cash_discrepancy:keep2")).status === "resolved", JSON.stringify(r.rows?.[0]) + r.msg);

console.log("\n── batched raise (review #3) ──");
r = await srv(`select public.ops_raise_alerts('[
  {"kind":"order_unassigned","severity":"warning","title":"A","body":"b","zone":"${ZA}","entityType":"order","entityId":"b1","dedupeKey":"order_unassigned:b1"},
  {"kind":"order_unassigned","severity":"warning","title":"B","body":"b","zone":"${ZA}","entityType":"order","entityId":"b2","dedupeKey":"order_unassigned:b2"},
  {"kind":"bogus","severity":"warning","title":"C","body":"b","zone":null,"entityType":"order","entityId":"b3","dedupeKey":"bogus:b3"}
]'::jsonb) as res`);
const res = r.rows?.[0]?.res ?? [];
ok("one call raises many; each answer carries its dedupe key and push flag",
  r.ok && res.length === 3 && res[0].dedupeKey === "order_unassigned:b1" && res[0].push === true && !!res[0].id, JSON.stringify(res) + r.msg);
ok("...a bad item reports its own error and does not fail the batch", res[2]?.error === "bad_kind" && res[1]?.push === true, JSON.stringify(res));
r = await srv(`select public.ops_raise_alerts('[{"kind":"order_unassigned","severity":"warning","title":"A","body":"b","zone":"${ZA}","entityType":"order","entityId":"b1","dedupeKey":"order_unassigned:b1"}]'::jsonb) as res`);
ok("...and a repeat in the batch does not push again", r.ok && r.rows[0].res[0].push === false, JSON.stringify(r.rows?.[0]));

console.log("\n── paging index and retention (review #2, #22) ──");
ok("alerts page on opened_at: the index exists", !!(await one(`select 1 as x from pg_indexes where indexname = 'ops_alerts_page_idx'`)));
await db.exec(`update public.ops_alerts set status = 'resolved', resolved_at = now() - interval '200 days' where dedupe_key = 'order_unassigned:b2'`);
r = await srv(`select public.ops_prune_alerts(180) as n`);
ok("alerts resolved over 180 days ago are pruned (their events with them)",
  r.ok && r.rows[0].n >= 1 && !(await alertBy("order_unassigned:b2")), JSON.stringify(r.rows?.[0]) + r.msg);
ok("...and nothing recent or open is touched", !!(await alertBy("order_unassigned:b1")));

console.log("\n── evaluation lease ──");
r = await srv(`select public.ops_claim_alert_run('evaluate', 60) as a, public.ops_claim_alert_run('evaluate', 60) as b`);
ok("two claims in a row: exactly one wins", r.ok && r.rows[0].a === true && r.rows[0].b === false, JSON.stringify(r.rows?.[0]));
await db.exec(`update public.ops_alert_runs set leased_until = now() - interval '1 second'`);
r = await srv(`select public.ops_claim_alert_run('evaluate', 60) as a`);
ok("after the lease runs out a claim wins again", r.ok && r.rows[0].a === true);

console.log("\n── audit log stays immutable ──");
for (const role of ["authenticated", "service_role"]) {
  r = await as(role, A, `update public.ops_audit_log set reason = 'x'`);
  ok(`${role} cannot edit the audit log`, !r.ok || (await one(`select count(*)::int as n from public.ops_audit_log where reason = 'x'`)).n === 0);
  r = await as(role, A, `delete from public.ops_audit_log`);
  ok(`${role} cannot delete from it`, !r.ok || (await one(`select count(*)::int as n from public.ops_audit_log`)).n > 0);
}

console.log("\n── idempotent ──");
r = await db.exec(MIGRATION).then(() => ({ ok: true }), (e) => ({ ok: false, msg: e.message }));
ok("migration can be applied twice", r.ok, r.msg);
ok("...without duplicating defaults", (await one(`select count(*)::int as n from public.ops_alert_rules where zone_id is null`)).n === 16);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
