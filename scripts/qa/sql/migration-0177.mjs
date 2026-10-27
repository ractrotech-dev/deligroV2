// Runs migration 0177 (developer platform lock) in PGlite on top of manager-base.mjs.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0177.mjs
// Proves only the developer can set or lift the lock, that it turns ordering
// off with the developer's message, that nobody else can switch ordering back
// on while it is set, that no order lands while it is set, and that lifting it
// restores what the admin had.
import { managerBase, readMigration, id, IDS } from "./manager-base.mjs";

const { db } = await managerBase();
const { A, M, C, R1 } = IDS;
const DEV = id(50);
await db.exec(`
  alter table public.platform_settings add column if not exists accepting_orders boolean not null default true,
    add column if not exists maintenance_message text not null default '';
  update public.platform_settings set maintenance_message = 'Admin note';
  insert into public.profiles (id, role, full_name) values ('${DEV}', 'developer', 'Dev');
`);
await db.exec(readMigration("0177_developer_platform_lock.sql"));

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
const row = async () => (await db.query("select accepting_orders, maintenance_message, dev_lock_level, dev_lock_message from public.platform_settings")).rows[0];
const order = () => srv(`insert into public.orders (customer_id, restaurant_id, total) values ('${C}','${R1}', 100) returning id`);

console.log("\n── who may set it ──");
ok("an admin cannot set the lock", fails(await srv(`select public.set_platform_lock('${A}','full','x')`), /forbidden/));
ok("a manager cannot set the lock", fails(await srv(`select public.set_platform_lock('${M}','orders','x')`), /forbidden/));
ok("a signed-in developer cannot call it directly (service role only)",
  fails(await as("authenticated", DEV, `select public.set_platform_lock('${DEV}','orders','x')`), /permission denied|forbidden/));
ok("an unknown level is refused", fails(await srv(`select public.set_platform_lock('${DEV}','everything','x')`), /invalid_level/));
ok("orders go through while it is off", (await order()).ok);

console.log("\n── locked ──");
let r = await srv(`select public.set_platform_lock('${DEV}','orders','Paused until the invoice is settled')`);
let s = await row();
ok("the developer sets 'orders'", r.ok && s.dev_lock_level === "orders", r.msg);
ok("...ordering is off with the developer's message", s.accepting_orders === false && s.maintenance_message === "Paused until the invoice is settled", JSON.stringify(s));
ok("...no order lands", fails(await order(), /platform_paused/));
ok("...an update switching ordering back on is refused",
  fails(await srv("update public.platform_settings set accepting_orders = true where id"), /platform_locked/));
ok("...changing the customer message is refused",
  fails(await srv("update public.platform_settings set maintenance_message = 'All good' where id"), /platform_locked/));
ok("...clearing the lock columns by hand is refused",
  fails(await srv("update public.platform_settings set dev_lock_level = 'off' where id"), /platform_locked/));
ok("...other settings still save", (await srv("update public.platform_settings set delivery_radius_km = 7 where id")).ok);
r = await srv(`select public.set_platform_lock('${DEV}','full','Full stop')`);
s = await row();
ok("moving to 'full' keeps ordering off", r.ok && s.dev_lock_level === "full" && s.accepting_orders === false && s.maintenance_message === "Full stop");

console.log("\n── an admin cannot get around it ──");
ok("an admin cannot delete the settings row (it would read as 'accepting orders')",
  fails(await as("authenticated", A, "delete from public.platform_settings"), /permission denied|platform_locked/));
ok("...nor can the service role while it is locked", fails(await srv("delete from public.platform_settings"), /platform_locked/));
ok("...the row is still there and still locked", (await row())?.dev_lock_level === "full");
ok("an admin cannot make themselves a developer",
  fails(await as("authenticated", A, `update public.profiles set role = 'developer' where id = '${A}'`), /developer_role/));
ok("an admin cannot demote the developer",
  fails(await as("authenticated", A, `update public.profiles set role = 'customer' where id = '${DEV}'`), /developer_role/));
ok("a new profile cannot be created as a developer from an app login",
  fails(await as("authenticated", A, `insert into public.profiles (id, role) values ('${id(51)}', 'developer')`), /developer_role/));
ok("the service role (the developer's own scripts) still can", (await srv(`insert into public.profiles (id, role) values ('${id(52)}', 'developer')`)).ok);
r = await srv(`select public.set_platform_lock('${DEV}','full','Line one\r\nLine two')`);
ok("a message with line breaks is stored on one line (forms resend it unchanged)", r.ok && (await row()).maintenance_message === "Line one Line two", JSON.stringify(await row()));

console.log("\n── lifted ──");
r = await srv(`select public.set_platform_lock('${DEV}','off','')`);
s = await row();
ok("lifting restores what the admin had (ordering on, their note)",
  r.ok && s.dev_lock_level === "off" && s.accepting_orders === true && s.maintenance_message === "Admin note", JSON.stringify(s));
ok("orders go through again", (await order()).ok);
ok("the admin's own switch works again", (await srv("update public.platform_settings set accepting_orders = false where id")).ok);
await srv("update public.platform_settings set accepting_orders = true where id");
r = await srv(`select public.set_platform_lock('${DEV}','orders','')`);
ok("a lock with no message shows a plain default", r.ok && (await row()).maintenance_message === "Ordering is paused for now. Please check back later.");
await srv(`select public.set_platform_lock('${DEV}','off','')`);
const ev = (await db.query("select level, actor_id from public.platform_lock_events order by id")).rows;
ok("every change is recorded with who made it", ev.length === 6 && ev.every((e) => e.actor_id === DEV) && ev.map((e) => e.level).join() === "orders,full,full,off,orders,off", JSON.stringify(ev));
ok("customers can read whether it is paused", (await as("anon", null, "select dev_lock_level, dev_lock_message from public.platform_settings")).ok);
ok("customers cannot read the history", fails(await as("authenticated", C, "select * from public.platform_lock_events"), /permission denied/));
ok("the developer's account can still be deleted (its name is cleared from the lock)",
  (await srv(`delete from public.profiles where id = '${DEV}'`)).ok, (await srv(`delete from public.profiles where id = '${DEV}'`)).msg);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
