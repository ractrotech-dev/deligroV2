// Runs migration 0178 (zone weather) in PGlite on top of manager-base.mjs + 0142.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0178.mjs
// Proves the automatic reading, the manual override and its expiry, stale
// readings ageing out, zone scoping and audit, notify-once, and what the public
// read shows.
import { managerBase, readMigration, IDS } from "./manager-base.mjs";

const { db, ZA, ZB } = await managerBase();
const { A, M, MB, C } = IDS;
await db.exec(readMigration("0142_manager_orders_live.sql"));
// 0001's approved flag (the base schema is abridged).
await db.exec("alter table public.restaurants add column if not exists approved boolean not null default true");
await db.exec(readMigration("0178_zone_weather.sql"));

let passed = 0, failed = 0;
const ok = (n, c, extra) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}${!c && extra ? `\n         ${extra}` : ""}`); };
async function as(role, uid, sql) {
  const claims = role === "service_role" ? { role: "service_role" } : {};
  await db.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false); select set_config('test.jwt','${JSON.stringify(claims)}',false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec("reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);"); }
}
const srv = (sql) => as("service_role", null, sql);
const fails = (r, re) => !r.ok && re.test(r.msg);
const now = async (role = "anon") => (await as(role, role === "anon" ? null : C, "select * from public.zone_weather_now()")).rows ?? [];

console.log("\n── automatic ──");
ok("clear everywhere to start", (await now()).length === 0);
ok("a signed-in user cannot write a reading", fails(await as("authenticated", C, `select public.set_zone_weather_auto('${ZA}','storm','x')`), /permission denied|forbidden/));
let r = await srv(`select public.set_zone_weather_auto('${ZA}','rain','2.1 mm/h')`);
let w = await now();
ok("the server's rain reading shows for zone A with +10 min", r.ok && w.length === 1 && w[0].zone_id === ZA && w[0].level === "rain" && w[0].extra_minutes === 10 && w[0].source === "auto", JSON.stringify(w));
ok("customers (guest and signed in) can read it", (await now("anon")).length === 1 && (await now("authenticated")).length === 1);
ok("customers cannot read the table itself", fails(await as("anon", null, "select * from public.zone_weather"), /permission denied/));
await db.exec(`update public.zone_weather set auto_checked_at = now() - interval '4 hours' where zone_id = '${ZA}'`);
ok("a reading over 3 hours old counts as clear", (await now()).length === 0);
await srv(`select public.set_zone_weather_auto('${ZA}','storm','thunderstorm')`);
ok("storm is +30", (await now())[0]?.extra_minutes === 30);

console.log("\n── manual ──");
ok("a zone-B manager cannot set zone A", fails(await srv(`select public.ops_set_zone_weather('${MB}','${ZA}','clear',2,null,'w0')`), /forbidden/));
ok("hours outside 1–12 are refused", fails(await srv(`select public.ops_set_zone_weather('${M}','${ZA}','rain',24,null,'w1')`), /invalid_transition/));
ok("an unknown level is refused", fails(await srv(`select public.ops_set_zone_weather('${M}','${ZA}','snow',2,null,'w2')`), /invalid_transition/));
r = await srv(`select public.ops_set_zone_weather('${M}','${ZA}','clear',2,'Storm passed','w3')`);
ok("the zone manager overrides the storm with clear", r.ok && (await now()).length === 0, r.msg);
const audit = (await db.query("select actor_id, before, after, reason from public.ops_audit_log where action = 'zone.weather' order by id")).rows;
ok("...audited with before and after", audit.length === 1 && audit[0].before.level === "storm" && audit[0].after.level === "clear" && audit[0].reason === "Storm passed", JSON.stringify(audit));
ok("...a replay changes nothing more", (await srv(`select public.ops_set_zone_weather('${M}','${ZA}','clear',2,'Storm passed','w3')`)).ok
  && (await db.query("select count(*)::int n from public.ops_audit_log where action = 'zone.weather'")).rows[0].n === 1);
r = await srv(`select public.ops_set_zone_weather('${A}','${ZB}','heavy_rain',3,null,'w4')`);
w = await now();
ok("an admin sets heavy rain on zone B (no reading yet), +20 min, until set", r.ok && w.some((x) => x.zone_id === ZB && x.level === "heavy_rain" && x.extra_minutes === 20 && x.source === "manual" && x.until), JSON.stringify(w));
await db.exec(`update public.zone_weather set manual_until = now() - interval '1 minute' where zone_id = '${ZA}'`);
ok("an expired override falls back to the automatic reading", (await now()).some((x) => x.zone_id === ZA && x.level === "storm" && x.source === "auto"));
r = await srv(`select public.ops_set_zone_weather('${A}','${ZB}','auto',null,null,'w5')`);
ok("'auto' clears the override", r.ok && !(await now()).some((x) => x.zone_id === ZB));

console.log("\n── riders told once ──");
r = await srv(`select public.zone_weather_mark_notified('${ZA}','storm') as moved`);
ok("the first mark moves it", r.ok && r.rows[0].moved === true);
r = await srv(`select public.zone_weather_mark_notified('${ZA}','storm') as moved`);
ok("a second server marking the same level does not", r.ok && r.rows[0].moved === false);
ok("a signed-in user cannot mark", fails(await as("authenticated", C, `select public.zone_weather_mark_notified('${ZA}','clear')`), /permission denied|forbidden/));
ok("shop minutes list the shops of zones with weather", ((await as("anon", null, "select * from public.shop_weather_minutes()")).rows ?? []).some((x) => x.restaurant_id === IDS.R1 && x.extra_minutes === 30));
ok("guests can read a shop's zone", (await as("anon", null, "select zone_id from public.restaurants limit 1")).ok);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
