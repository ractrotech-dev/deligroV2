// Runs migration 0190 (admin stops a manager) in PGlite, on the whole real chain.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0190.mjs
import { freshChain, one } from "./chain-lib.mjs";

const { db, err, applied } = await freshChain();
if (err) {
  console.log(`  FAIL the chain did not apply (${applied})\n${err}`);
  process.exit(1);
}

const A = "a0000000-0000-0000-0000-000000000001";
const A2 = "a0000000-0000-0000-0000-000000000002";
const M = "b0000000-0000-0000-0000-000000000001";
const R = "c0000000-0000-0000-0000-000000000001";
const C = "d0000000-0000-0000-0000-000000000001";
await db.exec(`
  select set_config('test.jwt', '{"role":"service_role"}', false);
  insert into auth.users (id, email) values
    ('${A}', 'a@x.test'), ('${A2}', 'a2@x.test'), ('${M}', 'm@x.test'), ('${R}', 'r@x.test'), ('${C}', 'c@x.test')
    on conflict do nothing;
  insert into public.profiles (id, role) values
    ('${A}', 'admin'), ('${A2}', 'admin'), ('${M}', 'manager'), ('${R}', 'driver'), ('${C}', 'customer')
    on conflict (id) do update set role = excluded.role;
  insert into auth.sessions (user_id) values ('${M}'), ('${M}'), ('${R}');
  select set_config('test.jwt', '{}', false);
`);

let passed = 0, failed = 0;
const ok = (n, c, extra) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}${!c && extra ? `\n         ${extra}` : ""}`); };

/** Call as the server (service role), as a signed-in person, or as a guest. */
async function call(role, uid, jwt, sql) {
  await db.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false); select set_config('test.jwt','${JSON.stringify(jwt)}',false);`);
  try { return { ok: true, rows: (await db.query(sql)).rows }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec("reset role; select set_config('test.uid','',false); select set_config('test.jwt','{}',false);"); }
}
const server = (sql) => call("service_role", null, { role: "service_role" }, sql);
const setAccount = (actor, user, decision, expected, reason = "left the company", cid = "null") =>
  server(`select public.ops_admin_set_staff_account('${actor}', '${user}', '${decision}', ${expected === null ? "null" : `'${expected}'`}, '${reason}', ${cid})`);
const status = async (id) => (await one(db, `select account_status from public.profiles where id = '${id}'`))[0].account_status;
const logCount = async (action) => (await one(db, `select count(*)::int n from public.ops_audit_log where action = '${action}'`))[0].n;
const isManager = async (uid) => (await call("authenticated", uid, {}, "select public.is_manager() as x")).rows?.[0]?.x;

ok("an active manager is a manager to RLS", (await isManager(M)) === true);

let r = await call("authenticated", A, { role: "authenticated" }, `select public.ops_admin_set_staff_account('${A}', '${M}', 'stop', 'active', 'left the company', null)`);
ok("a signed-in person cannot call it, even an admin", !r.ok && /permission denied|forbidden/.test(r.msg), r.msg);
r = await call("anon", null, {}, `select public.ops_revoke_staff_sessions('${A}', '${M}')`);
ok("a guest cannot end sessions", !r.ok && /permission denied|forbidden/.test(r.msg), r.msg);

r = await setAccount(M, R, "stop", "active");
ok("a manager cannot use it", !r.ok && /forbidden/.test(r.msg), r.msg);
r = await setAccount(A, A, "stop", "active");
ok("an admin cannot stop themselves", !r.ok && /forbidden/.test(r.msg), r.msg);
r = await setAccount(A, A2, "stop", "active");
ok("an admin cannot stop another admin, so never the last one", !r.ok && /forbidden/.test(r.msg) && (await status(A2)) === "active", r.msg);
r = await setAccount(A, R, "stop", "active");
ok("a rider goes through their own step, not this one", !r.ok && /forbidden/.test(r.msg), r.msg);
r = await setAccount(A, C, "stop", "active");
ok("a customer is refused", !r.ok && /forbidden/.test(r.msg), r.msg);

r = await setAccount(A, M, "stop", "active", "no");
ok("a reason is required", !r.ok && /reason_required/.test(r.msg), r.msg);
r = await setAccount(A, M, "stop", "suspended");
ok("a stale screen is refused", !r.ok && /stale/.test(r.msg), r.msg);
r = await setAccount(A, M, "start", "active");
ok("starting someone active is refused", !r.ok && /invalid_transition/.test(r.msg), r.msg);
ok("none of those changed anything or logged anything", (await status(M)) === "active" && (await logCount("staff.stop")) === 0);

r = await setAccount(A, M, "stop", "active");
ok("an admin stops a manager", r.ok && (await status(M)) === "suspended", r.msg);
ok("...in the audit log, with who and why", (await one(db, `select count(*)::int n from public.ops_audit_log where action = 'staff.stop' and actor_id = '${A}' and entity_id = '${M}' and reason = 'left the company'`))[0].n === 1);
ok("a stopped manager is not a manager to RLS", (await isManager(M)) === false);

r = await server(`select public.ops_revoke_staff_sessions('${A}', '${M}') as n`);
ok("their sessions end", r.ok && r.rows[0].n === 2, r.msg ?? JSON.stringify(r.rows));
r = await server(`select public.ops_revoke_staff_sessions('${A}', '${R}') as n`);
ok("a rider's sessions can end too (password reset)", r.ok && r.rows[0].n === 1, r.msg ?? JSON.stringify(r.rows));
// 0203 lets an admin end another admin's sessions (a password reset), never their own.
r = await server(`select public.ops_revoke_staff_sessions('${A}', '${A2}') as n`);
ok("another admin's sessions can end too (0203)", r.ok, r.msg);
r = await server(`select public.ops_revoke_staff_sessions('${A}', '${A}')`);
ok("your own sessions cannot", !r.ok && /forbidden/.test(r.msg), r.msg);
r = await server(`select public.ops_revoke_staff_sessions('${M}', '${R}')`);
ok("a manager cannot end anyone's sessions", !r.ok && /forbidden/.test(r.msg), r.msg);

r = await setAccount(A, M, "start", "suspended", "came back");
ok("an admin starts them again", r.ok && (await status(M)) === "active" && (await logCount("staff.start")) === 1, r.msg);
ok("...and they are a manager again", (await isManager(M)) === true);

// A plain click twice with one id does the work once.
const CID = "'stop-once-1'";
await setAccount(A, M, "stop", "active", "second time", CID);
r = await setAccount(A, M, "stop", "active", "second time", CID);
ok("a replay answers without doing it twice", r.ok && (await logCount("staff.stop")) === 2, r.msg);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
