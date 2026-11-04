// Proves migration 0202 on the real migration chain (chain-lib.mjs): removing a manager
// or rider retires the account, keeps its history, and can't be undone or done from a session.
//
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0202.mjs
import { freshChain, one as rows } from "./chain-lib.mjs";

const one = async (db, sql) => (await rows(db, sql))[0];

let fails = 0;
const ok = (c, m, extra = "") => {
  if (c) console.log(`ok   ${m}`);
  else {
    fails++;
    console.log(`FAIL ${m}${extra ? " — " + extra : ""}`);
  }
};

const { db, err } = await freshChain();
if (err) {
  console.log(`FAIL the migration chain does not apply: ${err}`);
  process.exit(1);
}

const uuid = (n) => `00000000-0000-4000-8000-0000000202${String(n).padStart(2, "0")}`;
const [ADMIN, MGR, MGR2, RIDER, BUSY, CUST, VEND, SHOP, ORDER] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(uuid);

/** As a signed-in user, through their role and their RLS. */
async function as(uid, sql) {
  const claims = { role: "authenticated", sub: uid };
  await db.exec(`reset role; select set_config('test.uid','${uid}',false); select set_config('test.jwt','${JSON.stringify(claims)}',false); set role authenticated;`);
  try {
    return { ok: true, rows: (await db.query(sql)).rows };
  } catch (e) {
    return { ok: false, msg: String(e.message) };
  } finally {
    await db.exec(`reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);`);
  }
}
const owner = (sql) => db.exec(`select set_config('test.jwt','{"role":"service_role"}',false); ${sql}; select set_config('test.jwt','',false);`);

await owner(`
  insert into auth.users (id, email) select id, id || '@x.test' from unnest(array['${ADMIN}','${MGR}','${MGR2}','${RIDER}','${BUSY}','${CUST}','${VEND}']::uuid[]) id;
  insert into public.profiles (id, role, full_name) values
    ('${ADMIN}','admin','Owner'), ('${MGR}','manager','Mina'), ('${MGR2}','manager','Mohan'), ('${RIDER}','driver','Ravi'),
    ('${BUSY}','driver','Raju'), ('${CUST}','customer','Asha'), ('${VEND}','restaurant','Shop')
    on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;
  insert into public.staff_zones (user_id, zone_id) values ('${MGR}', public.default_zone_id()) on conflict do nothing;
  insert into public.restaurants (id, slug, name, owner_id, approved, is_open, lat, lng)
    values ('${SHOP}', 'staff-shop', 'Staff Shop', '${VEND}', true, true, 21.71, 81.53);
  alter table public.orders disable trigger user;
  insert into public.orders (id, customer_id, restaurant_id, address, payment_method)
    values ('${ORDER}', '${CUST}', '${SHOP}', '{"line":"x","lat":21.72,"lng":81.54}'::jsonb, 'cod');
  alter table public.orders enable trigger user;
  alter table public.deliveries disable trigger user;
  insert into public.deliveries (order_id, driver_id, status) values ('${ORDER}', '${BUSY}', 'assigned');
  alter table public.deliveries enable trigger user;
`);

/** What the server does: the functions only answer to the service role. */
const asService = () => db.exec(`select set_config('test.jwt','{"role":"service_role"}',false);`);
const remove = async (actor, user, reason = "left the company", key = crypto.randomUUID()) => {
  await asService();
  try {
    await db.query(`select public.ops_admin_remove_staff('${actor}','${user}','${reason}','${key}')`);
    return "ok";
  } catch (e) {
    return String(e.message);
  }
};
const profile = (id) => one(db, `select account_status, removed_at, status_reason from public.profiles where id = '${id}'`);

ok((await remove(MGR, MGR2)) !== "ok", "a manager can't remove anyone");
ok((await remove(ADMIN, ADMIN)) === "forbidden", "you can't remove yourself");
ok((await remove(ADMIN, CUST)) === "forbidden", "a customer can't be removed from here");
const shortReason = await remove(ADMIN, MGR, "x");
ok(shortReason === "reason_required", "a reason is needed", shortReason);
ok((await profile(MGR)).removed_at === null, "...and a refused removal changes nothing");

const zone = await one(db, `select count(*)::int n from public.staff_zones where user_id = '${MGR}'`);
ok(zone.n === 1, "the manager starts with a zone");
const key = crypto.randomUUID();
ok((await remove(ADMIN, MGR, "left the company", key)) === "ok", "an admin removes a manager");
const m = await profile(MGR);
ok(m.account_status === "suspended" && m.removed_at !== null, "they are suspended and marked removed");
ok((await one(db, `select count(*)::int n from public.staff_zones where user_id = '${MGR}'`)).n === 0, "their zones are dropped");
ok((await one(db, `select count(*)::int n from public.profiles where id = '${MGR}'`)).n === 1, "the row stays, for history");
const log = await one(db, `select * from public.ops_audit_log where entity_id = '${MGR}' and action = 'staff.remove'`);
ok(log?.action === "staff.remove" && JSON.stringify(log).includes('"zones":["'), "the audit row keeps the zones they had", JSON.stringify(log));
ok((await remove(ADMIN, MGR, "left the company", key)) === "ok", "a retry of the same request is harmless");
ok((await one(db, `select count(*)::int n from public.ops_audit_log where entity_id = '${MGR}' and action = 'staff.remove'`)).n === 1, "...and logs once");
ok((await remove(ADMIN, MGR)) === "already", "removing twice is refused");

ok((await remove(ADMIN, BUSY)) === "active_delivery", "a rider carrying an order can't be removed");
ok((await profile(BUSY)).removed_at === null, "...and stays on the team");
ok((await remove(ADMIN, RIDER)) === "ok", "an idle rider can be removed");

const reactivate = async (sql) => {
  await asService();
  try {
    await db.query(sql);
    return "ok";
  } catch (e) {
    return String(e.message);
  }
};
ok(
  (await reactivate(`select public.ops_set_rider_account('${ADMIN}','${RIDER}','reactivate','suspended','came back','${crypto.randomUUID()}')`)) === "staff_removed",
  "the rider action can't bring a removed rider back"
);
ok(
  (await reactivate(`select public.ops_admin_set_staff_account('${ADMIN}','${MGR}','start','suspended','came back','${crypto.randomUUID()}')`)) === "staff_removed",
  "the manager action can't bring a removed manager back"
);
ok((await profile(RIDER)).account_status === "suspended", "a removed rider stays suspended");

const offer = await reactivate(`select public.is_manager()`);
ok(offer === "ok", "is_manager still runs");
await db.exec(`select set_config('test.uid','${MGR}',false); select set_config('test.jwt','{"role":"authenticated","sub":"${MGR}"}',false);`);
ok((await one(db, `select public.is_manager() as v`)).v === false, "a removed manager is not a manager to RLS");
await db.exec(`select set_config('test.uid','',false); select set_config('test.jwt','',false);`);

const read = await as(MGR2, `select removed_at from public.profiles where id = '${MGR2}'`);
ok(!read.ok && /permission denied/.test(read.msg), "a session can't read removed_at", read.msg);
const selfSet = await as(MGR2, `update public.profiles set removed_at = null, account_status = account_status where id = '${MGR}'`);
ok(selfSet.ok ? selfSet.rows.length === 0 : true, "a session can't clear someone's removal");
const hide = await as(MGR2, `update public.profiles set removed_at = now() where id = '${MGR2}'`);
ok(!hide.ok, "a session can't mark itself removed");
const call = await as(ADMIN, `select public.ops_admin_remove_staff('${ADMIN}','${MGR2}','left the company','${crypto.randomUUID()}')`);
ok(!call.ok && /permission denied/.test(call.msg), "a session can't call the function, even an admin's", call.msg);
ok((await profile(MGR)).removed_at !== null, "the removed manager is still removed");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
