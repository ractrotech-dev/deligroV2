// Proves migration 0197 on the real migration chain (chain-lib.mjs): vendors have no
// review or approval step, and only an admin or a manager can add a shop.
//
//   1. waiting shops with a pin go live; waiting shops without one, and rejected
//      shops, become inactive; suspended and inactive shops are not touched;
//   2. the review states cannot come back;
//   3. a shop an admin or manager adds is live (inactive with no pin);
//   4. approve and reject are gone, suspend and reactivate still work, and the
//      document review function is gone;
//   5. a customer or a vendor cannot create a shop, or make themselves a vendor.
//
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0197.mjs
import { applyFile, freshChain, one } from "./chain-lib.mjs";

let fails = 0;
const ok = (c, m, extra = "") => {
  if (c) console.log(`ok   ${m}`);
  else {
    fails++;
    console.log(`FAIL ${m}${extra ? " — " + extra : ""}`);
  }
};

const { db, err } = await freshChain(196);
if (err) {
  console.log(`FAIL the migration chain does not apply: ${err}`);
  process.exit(1);
}

const uuid = (n) => `00000000-0000-4000-8000-0000001970${String(n).padStart(2, "0")}`;
const [ADMIN, MANAGER, OTHER_MANAGER, CUSTOMER, VENDOR, ZONE, OTHER_ZONE] = [1, 2, 3, 4, 5, 6, 7].map(uuid);
const [PENDING_PINNED, PENDING_BARE, REJECTED, SUSPENDED, INACTIVE, ACTIVE_BARE] = [11, 12, 13, 14, 15, 16].map(uuid);

await db.exec(`
  select set_config('test.jwt','{"role":"service_role"}',false);
  insert into auth.users (id, email) values
    ('${ADMIN}','a97@x.test'), ('${MANAGER}','m97@x.test'), ('${OTHER_MANAGER}','o97@x.test'),
    ('${CUSTOMER}','c97@x.test'), ('${VENDOR}','v97@x.test');
  insert into public.profiles (id, role, full_name) values
    ('${ADMIN}','admin','Owner'), ('${MANAGER}','manager','Mona'), ('${OTHER_MANAGER}','manager','Omar'),
    ('${CUSTOMER}','customer','Chetan'), ('${VENDOR}','restaurant','Vimal')
    on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;
  insert into public.delivery_zones (id, city_id, name, slug, center_lat, center_lng)
    select v.id::uuid, (select city_id from public.delivery_zones where is_default limit 1), v.name, v.slug, 21.7, 81.5
      from (values ('${ZONE}','Z97','z97'), ('${OTHER_ZONE}','O97','o97')) as v(id, name, slug);
  insert into public.staff_zones (user_id, zone_id) values ('${MANAGER}','${ZONE}'), ('${OTHER_MANAGER}','${OTHER_ZONE}');
  insert into public.restaurants (id, owner_id, name, slug, zone_id, status, lat, lng) values
    ('${PENDING_PINNED}','${VENDOR}','Pinned','pinned','${ZONE}','pending',21.7,81.5),
    ('${PENDING_BARE}','${VENDOR}','Bare','bare','${ZONE}','pending',null,null),
    ('${REJECTED}','${VENDOR}','Declined','declined','${ZONE}','rejected',21.7,81.5),
    ('${SUSPENDED}','${VENDOR}','Stopped','stopped','${ZONE}','suspended',21.7,81.5),
    ('${INACTIVE}','${VENDOR}','Off','off','${ZONE}','inactive',21.7,81.5);
  select set_config('test.jwt','',false);
`);
// A shop already live with no pin (43 of these on the live database): written with the
// guard out of the way, as they were before 0050.
await db.exec(`
  alter table public.restaurants disable trigger require_vendor_pin;
  insert into public.restaurants (id, owner_id, name, slug, zone_id, status) values
    ('${ACTIVE_BARE}','${VENDOR}','Old live','old-live','${ZONE}','active');
  alter table public.restaurants enable trigger require_vendor_pin;
`);

const applied = await applyFile(db, "0197_vendors_no_approval.sql");
if (applied) {
  console.log(`FAIL 0197 does not apply over shops in every state: ${applied}`);
  process.exit(1);
}

const shop = async (id) =>
  (await one(db, `select status::text as status, approved, status_reason from public.restaurants where id = '${id}'`))[0];

async function as(role, uid, sql) {
  await db.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false);`);
  try {
    return { ok: true, rows: (await db.query(sql)).rows };
  } catch (e) {
    return { ok: false, msg: String(e.message) };
  } finally {
    await db.exec(`reset role; select set_config('test.uid','',false);`);
  }
}

async function svc(sql) {
  await db.exec(`select set_config('test.jwt','{"role":"service_role"}',false);`);
  try {
    return { ok: true, rows: (await db.query(sql)).rows };
  } catch (e) {
    return { ok: false, msg: String(e.message) };
  } finally {
    await db.exec(`select set_config('test.jwt','',false);`);
  }
}

let cid = 0;
const action = () => `00000000-0000-4000-9000-${String(++cid).padStart(12, "0")}`;

const onboard = (actor, zone, slug, pin) =>
  svc(`select public.ops_onboard_vendor('${actor}','${VENDOR}','${zone}',
    '${JSON.stringify({ slug, name: slug, ...(pin ? { lat: 21.7, lng: 81.5 } : {}) })}'::jsonb, '[]'::jsonb, '${action()}') as r`);
const slugStatus = async (slug) =>
  (await one(db, `select status::text as status, approved from public.restaurants where slug = '${slug}'`))[0];

const setStatus = (act, shopId, expected) =>
  svc(`select public.ops_set_vendor_status('${MANAGER}','${shopId}','${act}','${expected}','Owner asked',false,'${action()}')`);

// ---------- 1. existing shops ----------
{
  const a = await shop(PENDING_PINNED);
  ok(a.status === "active" && a.approved === true, "a waiting shop with a pin goes live", JSON.stringify(a));
  ok(/review step/.test(a.status_reason ?? ""), "and says why");
  const b = await shop(PENDING_BARE);
  ok(b.status === "inactive" && b.approved === false, "a waiting shop with no pin stays off", JSON.stringify(b));
  ok(/map pin/.test(b.status_reason ?? ""), "and says it needs a map pin");
  const c = await shop(REJECTED);
  ok(c.status === "inactive" && c.approved === false, "a rejected shop stays off", JSON.stringify(c));
  ok((await shop(SUSPENDED)).status === "suspended", "a suspended shop is not touched");
  ok((await shop(INACTIVE)).status === "inactive", "an inactive shop is not touched");
  const d = await shop(ACTIVE_BARE);
  ok(d.status === "active" && d.status_reason === null, "a shop already live with no pin is not touched", JSON.stringify(d));
  const [left] = await one(db, `select count(*)::int as n from public.restaurants where status::text in ('pending','rejected')`);
  ok(left.n === 0, "no shop is left waiting or rejected");
}

// ---------- 2. the review states cannot come back ----------
{
  for (const s of ["pending", "rejected"]) {
    const r = await svc(`update public.restaurants set status = '${s}' where id = '${INACTIVE}'`);
    ok(!r.ok && /restaurants_status_no_review/.test(r.msg), `a shop cannot be set to ${s}`, r.msg ?? "accepted");
    const viaRpc = await svc(`select public.ops_admin_set_vendor_status('${ADMIN}','${INACTIVE}','${s}','No longer allowed','${action()}')`);
    ok(!viaRpc.ok && /invalid_transition/.test(viaRpc.msg), `the admin status call refuses ${s}`, viaRpc.msg ?? "accepted");
  }
  const [{ d }] = await one(db, `select column_default as d from information_schema.columns where table_name = 'restaurants' and column_name = 'status'`);
  ok(/inactive/.test(d ?? ""), "the column default is inactive", d);

  await db.exec(`
    insert into public.restaurants (owner_id, name, slug, lat, lng, approved) values ('${VENDOR}','Legacy','legacy-live',21.7,81.5,true);
    insert into public.restaurants (owner_id, name, slug) values ('${VENDOR}','Legacy','legacy-off');
    insert into public.restaurants (owner_id, name, slug, status) values ('${VENDOR}','Legacy','legacy-pending','pending');
  `);
  ok((await slugStatus("legacy-live")).status === "active", "an old-style insert with approved = true is still live");
  ok((await slugStatus("legacy-off")).status === "inactive", "an insert with nothing set is off");
  ok((await slugStatus("legacy-pending")).status === "inactive", "an old writer sending pending lands on inactive");
}

// ---------- 3. adding a shop ----------
{
  let r = await onboard(ADMIN, ZONE, "by-admin", true);
  const a = await slugStatus("by-admin");
  ok(r.ok && a.status === "active" && a.approved === true, "a shop an admin adds with a pin is live", r.msg ?? JSON.stringify(a));

  r = await onboard(MANAGER, ZONE, "by-manager", true);
  const m = await slugStatus("by-manager");
  ok(r.ok && m.status === "active" && m.approved === true, "a shop a manager adds with a pin is live", r.msg ?? JSON.stringify(m));

  r = await onboard(ADMIN, ZONE, "no-pin", false);
  const n = await slugStatus("no-pin");
  ok(r.ok && n.status === "inactive" && n.approved === false, "a shop added with no pin is off", r.msg ?? JSON.stringify(n));

  r = await onboard(MANAGER, OTHER_ZONE, "wrong-zone", true);
  ok(!r.ok && /forbidden/.test(r.msg), "a manager cannot add a shop outside their zones", r.msg ?? "accepted");
}

// ---------- 4. status actions ----------
{
  const fresh = (await one(db, `select id from public.restaurants where slug = 'no-pin'`))[0].id;
  for (const act of ["approve", "reject"]) {
    const r = await setStatus(act, fresh, "inactive");
    ok(!r.ok && /invalid_transition/.test(r.msg), `${act} is gone`, r.msg ?? "accepted");
  }
  let r = await setStatus("reactivate", fresh, "inactive");
  ok(!r.ok && /needs_map_pin/.test(r.msg), "switching a shop on still needs a map pin", r.msg ?? "accepted");

  r = await setStatus("reactivate", SUSPENDED, "suspended");
  ok(r.ok && (await shop(SUSPENDED)).status === "active", "reactivate still works", r.msg);
  r = await setStatus("suspend", SUSPENDED, "active");
  ok(r.ok && (await shop(SUSPENDED)).status === "suspended", "suspend still works", r.msg);
  r = await svc(`select public.ops_admin_set_vendor_status('${ADMIN}','${INACTIVE}','active','Switch on','${action()}')`);
  ok(r.ok && (await shop(INACTIVE)).status === "active", "an admin can still switch a shop on", r.msg);

  const [{ n }] = await one(db, `select count(*)::int as n from pg_proc where proname = 'ops_review_vendor_document'`);
  ok(n === 0, "the document review function is gone");
  const [{ a }] = await one(db, `select count(*)::int as a from pg_proc where proname = 'ops_add_vendor_document'`);
  ok(a === 1, "documents can still be added");
}

// ---------- 5. only staff can add a shop ----------
{
  const insert = (slug) => `insert into public.restaurants (owner_id, name, slug, lat, lng, approved)
    values (auth.uid(), 'Mine', '${slug}', 21.7, 81.5, true)`;
  for (const [who, role, uid] of [
    ["a customer", "authenticated", CUSTOMER],
    ["a vendor", "authenticated", VENDOR],
    ["a manager, directly", "authenticated", MANAGER],
    ["someone signed out", "anon", null],
  ]) {
    const r = await as(role, uid, insert(`self-${who.replace(/\W/g, "")}`));
    ok(!r.ok, `${who} cannot insert a shop`, "accepted");
  }
  for (const [who, role, uid] of [
    ["a customer", "authenticated", CUSTOMER],
    ["a vendor", "authenticated", VENDOR],
  ]) {
    const r = await as(role, uid, `select public.ops_onboard_vendor('${uid}','${uid}','${ZONE}','{"slug":"x","name":"x"}'::jsonb,'[]'::jsonb,'${action()}')`);
    ok(!r.ok, `${who} cannot call the onboarding function`, "accepted");
  }
  const r = await as("authenticated", CUSTOMER, `update public.profiles set role = 'restaurant' where id = '${CUSTOMER}'`);
  const [{ role }] = await one(db, `select role::text as role from public.profiles where id = '${CUSTOMER}'`);
  ok(!r.ok && role === "customer", "a customer cannot make themselves a vendor", role);
  const ins = await as("authenticated", OTHER_MANAGER, `update public.restaurants set status = 'active' where id = '${REJECTED}'`);
  ok((await shop(REJECTED)).status === "inactive", "a manager cannot switch a shop on outside the audited call", ins.msg);
  const own = await as("authenticated", VENDOR, `update public.restaurants set status = 'active', approved = true where id = '${REJECTED}'`);
  ok(!own.ok && (await shop(REJECTED)).status === "inactive", "a vendor cannot switch their own shop on", own.msg ?? "accepted");
}

console.log(fails ? `\n${fails} check(s) failed` : "\nAll 0197 checks passed");
process.exit(fails ? 1 : 0);
