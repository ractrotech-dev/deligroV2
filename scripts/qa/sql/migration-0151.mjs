// Runs migration 0151 (manager riders: account status, zone-scoped reads,
// audited verification / suspension / documents / onboarding / adjustments) in
// an in-process Postgres (PGlite) on top of manager-base.mjs + 0142 + 0150.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0151.mjs
import { managerBase, readMigration, id, IDS } from "./manager-base.mjs";

const MIGRATION = readMigration("0151_manager_riders.sql");
const { db, ZA, ZB } = await managerBase();
const { A, M, MB, C, D1, D2, D3, D5, R1 } = IDS;

// profiles.phone and 0003's lock_role(), which 0151 re-declares.
await db.exec(`
  alter table public.profiles add column if not exists phone text;
  create or replace function public.lock_role() returns trigger language plpgsql security definer set search_path = public as $$
  begin
    if new.role is distinct from old.role and not public.is_admin()
       and coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
      raise exception 'role can only be changed by an admin';
    end if;
    return new;
  end; $$;
  create trigger lock_role before update on public.profiles for each row execute function public.lock_role();
  alter table public.profiles enable row level security;
  create policy "own profile — update" on public.profiles for update using (id = auth.uid() or public.is_admin());
  create policy "own profile — read" on public.profiles for select using (id = auth.uid() or public.is_admin() or public.is_manager());
`);
await db.exec(readMigration("0142_manager_orders_live.sql"));
await db.exec(readMigration("0150_rider_tables_converge.sql"));
await db.exec(MIGRATION);

let passed = 0, failed = 0;
const ok = (n, c, extra) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}${!c && extra ? `\n         ${extra}` : ""}`); };
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
const audits = async (action) => (await one(`select count(*)::int as n from public.ops_audit_log where action = '${action}'`)).n;
const acct = async (rid) => (await one(`select account_status from public.profiles where id = '${rid}'`)).account_status;

console.log("\n── account status is locked ──");
ok("every profile starts active", (await acct(D1)) === "active");
ok("a rider cannot change their own account status",
  fails(await as("authenticated", D1, `update public.profiles set account_status = 'active', status_reason = 'x' where id = '${D1}'`), /admin|only/));

console.log("\n── suspension ──");
// An open shift and a pending offer for D1.
await db.exec(`insert into public.rider_shifts (driver_id, started_at) values ('${D1}', now() - interval '2 hours');
  insert into public.orders (id, customer_id, restaurant_id, status, total) values ('${id(3001)}','${C}','${R1}','ready',300);
  insert into public.deliveries (order_id, status, offered_driver_id, offered_at) values ('${id(3001)}','unassigned','${D1}', now());`);
let r = await srv(`select public.ops_set_rider_account('${M}','${D1}','suspend','active','Repeated cash shortfall','s1') as s`);
ok("a zone manager suspends an idle zone rider", r.ok && r.rows[0].s.account === "suspended", r.msg);
ok("...account is suspended", (await acct(D1)) === "suspended");
let st = await one(`select is_online, break_until from public.rider_status where driver_id = '${D1}'`);
ok("...and they are taken offline", st.is_online === false && st.break_until === null);
let sh = await one(`select ended_by from public.rider_shifts where driver_id = '${D1}' order by started_at desc limit 1`);
ok("...their open shift is ended by ops", sh.ended_by === "ops");
ok("...the pending offer is released", (await one(`select offered_driver_id from public.deliveries where order_id = '${id(3001)}'`)).offered_driver_id === null);
ok("...one audit row", (await audits("rider.suspend")) === 1);
r = await srv(`select public.ops_set_rider_account('${M}','${D1}','suspend','active','Repeated cash shortfall','s1') as s`);
ok("replaying the same action changes nothing", r.ok && r.rows[0].s.replayed === true && (await audits("rider.suspend")) === 1);
ok("rider_can_work is false after suspension", (await one(`select public.rider_can_work('${D1}') as w`)).w === false);
ok("a stale expected status → stale",
  fails(await srv(`select public.ops_set_rider_account('${M}','${D1}','reactivate','active','Back','s2')`), /^stale$/));
ok("a short reason → reason_required",
  fails(await srv(`select public.ops_set_rider_account('${M}','${D1}','reactivate','suspended','ok','s3')`), /reason_required/));

// D2 holds an assigned delivery.
await db.exec(`insert into public.orders (id, customer_id, restaurant_id, status, total) values ('${id(3002)}','${C}','${R1}','ready',300);
  insert into public.deliveries (order_id, driver_id, status, assigned_at) values ('${id(3002)}','${D2}','assigned', now());`);
r = await srv(`select public.ops_set_rider_account('${M}','${D2}','suspend','active','Rude to customer','s4')`);
const code = (await one(`select short_code from public.orders where id = '${id(3002)}'`)).short_code;
ok("suspending a rider on a delivery → active_delivery naming the order", fails(r, /active_delivery/) && r.detail === code, `${r.msg} ${r.detail} vs ${code}`);
ok("force offline with a delivery → active_delivery",
  fails(await srv(`select public.ops_force_rider_offline('${M}','${D2}','Phone unreachable','f1')`), /active_delivery/));
ok("a manager from another zone → forbidden",
  fails(await srv(`select public.ops_set_rider_account('${MB}','${D3}','suspend','active','Not mine','s5')`), /forbidden/));
ok("a manager cannot call it with their own session",
  fails(await as("authenticated", M, `select public.ops_set_rider_account('${M}','${D3}','suspend','active','Direct call','s6')`), /permission denied|forbidden/));
r = await srv(`select public.ops_force_rider_offline('${M}','${D3}','Idle and unreachable','f2') as s`);
ok("force offline an idle rider", r.ok && (await audits("rider.force_offline")) === 1, r.msg);
r = await srv(`select public.ops_set_rider_account('${A}','${D1}','reactivate','suspended','Shortfall repaid','s7') as s`);
ok("an admin reactivates", r.ok && (await acct(D1)) === "active" && (await one(`select public.rider_can_work('${D1}') as w`)).w === true, r.msg);

console.log("\n── dispatch eligibility reads rider_can_work ──");
await srv(`select public.ops_set_rider_account('${M}','${D1}','suspend','active','Investigation','s8')`);
await db.exec(`update public.rider_status set is_online = true, last_fix_at = now() where driver_id = '${D1}'`);
await db.exec(`insert into public.orders (id, customer_id, restaurant_id, status, total) values ('${id(3003)}','${C}','${R1}','ready',300);`);
r = await srv(`select public.ops_assign_rider('${M}','${id(3003)}','${D1}',null,'as1')`);
ok("assigning a suspended rider → rider_ineligible suspended", fails(r, /rider_ineligible/) && r.detail === "suspended", `${r.msg} ${r.detail}`);
await db.exec(`update public.rider_profiles set verification_status = 'rejected' where driver_id = '${D3}'`);
ok("rider_can_work is false for a rejected rider", (await one(`select public.rider_can_work('${D3}') as w`)).w === false);
ok("...and true for an unverified rider", (await one(`select public.rider_can_work('${D5}') as w`)).w === true);
await db.exec(`update public.rider_profiles set verification_status = 'unverified' where driver_id = '${D3}'`);

console.log("\n── verification ──");
await db.exec(`insert into public.rider_documents (id, driver_id, doc_type, file_path) values
  ('${id(601)}','${D3}','aadhaar','d3/a.pdf'), ('${id(602)}','${D3}','driving_licence','d3/l.pdf');`);
r = await srv(`select public.ops_set_rider_verification('${M}','${D3}','approve','unverified','Met in person',false,'v1')`);
ok("approve without verified documents → documents_unverified listing them",
  fails(r, /documents_unverified/) && r.detail === "aadhaar,driving_licence,photo", `${r.msg} ${r.detail}`);
ok("reject a document without remarks → reason_required",
  fails(await srv(`select public.ops_review_rider_document('${M}','${id(601)}','reject','','d1')`), /reason_required/));
r = await srv(`select public.ops_review_rider_document('${M}','${id(601)}','verify',null,'d2') as d`);
ok("a manager verifies the Aadhaar", r.ok && (await one(`select status, reviewed_by from public.rider_documents where id = '${id(601)}'`)).reviewed_by === M, r.msg);
ok("a second decision → already_decided",
  fails(await srv(`select public.ops_review_rider_document('${M}','${id(601)}','reject','Blurred','d3')`), /already_decided/));
r = await srv(`select public.ops_set_rider_verification('${M}','${D3}','approve','unverified','Originals seen at the office',true,'v2') as s`);
ok("approve with override → verified", r.ok && r.rows[0].s.verification === "verified", r.msg);
let row = await one(`select after from public.ops_audit_log where client_action_id = 'v2'`);
ok("...the audit row records the override", row.after.documents_override === true && row.after.missing === "driving_licence,photo");
ok("approving again with a stale expected → stale",
  fails(await srv(`select public.ops_set_rider_verification('${M}','${D3}','approve','unverified','Again',false,'v3')`), /^stale$/));
ok("reject from verified → invalid_transition",
  fails(await srv(`select public.ops_set_rider_verification('${M}','${D3}','reject','verified','Not suitable',false,'v4')`), /invalid_transition/));

console.log("\n── onboarding ──");
const U = id(701);
await db.exec(`insert into public.profiles (id, role, full_name) values ('${U}','customer','New Rider')`);
r = await srv(`select public.ops_onboard_rider('${MB}','${U}','${ZA}','{"fullName":"Ravi K","phone":"+919876543210"}'::jsonb,'o0')`);
ok("onboarding into a zone that is not yours → forbidden", fails(r, /forbidden/), r.msg);
r = await srv(`select public.ops_onboard_rider('${M}','${U}','${ZA}',
  '{"fullName":"Ravi K","phone":"+919876543210","vehicleType":"ev_bike","vehicleOwner":"deligro","pincode":"491335","emergencyPhone":"+919811112222"}'::jsonb,'o1') as s`);
ok("a zone manager onboards a rider", r.ok && /^DR-\d{4,}$/.test(r.rows[0].s.rider_code ?? ""), r.msg);
row = await one(`select p.role, p.full_name, p.phone, rp.vehicle_type, rp.verification_status
                   from public.profiles p join public.rider_profiles rp on rp.driver_id = p.id where p.id = '${U}'`);
ok("...as a pending driver with their profile", row.role === "driver" && row.phone === "+919876543210" && row.vehicle_type === "ev_bike" && row.verification_status === "pending");
const zones = (await db.query(`select zone_id from public.staff_zones where user_id = '${U}'`)).rows.map((x) => x.zone_id);
ok("...in exactly the chosen zone", zones.length === 1 && zones[0] === ZA);
ok("...audited", (await audits("rider.onboard")) === 1);
ok("onboarding a manager account → invalid_transition",
  fails(await srv(`select public.ops_onboard_rider('${M}','${MB}','${ZA}','{"fullName":"X"}'::jsonb,'o2')`), /invalid_transition/));

console.log("\n── adjustments ──");
ok("kind salary is refused (it goes through payment requests)",
  fails(await srv(`select public.ops_add_rider_adjustment('${M}','${D5}','salary',100,'Salary','2026-10-20',null,'a0')`), /forbidden|invalid/));
r = await srv(`select public.ops_add_rider_adjustment('${M}','${D2}','bonus',500,'Diwali rush','2026-10-20',null,'a1') as s`);
ok("a bonus for a zone rider", r.ok && (await one(`select count(*)::int as n from public.rider_adjustments where driver_id = '${D2}' and kind = 'bonus' and created_by = '${M}'`)).n === 1, r.msg);
ok("a zero adjustment → bad amount", fails(await srv(`select public.ops_add_rider_adjustment('${M}','${D2}','adjustment',0,'Nothing','2026-10-20',null,'a2')`), /invalid_amount|violates/));

console.log("\n── zone-scoped reads ──");
await db.exec(`insert into public.rider_documents (driver_id, doc_type, file_path) values ('${D5}','aadhaar','d5/a.pdf');
  insert into public.cash_deposits (driver_id, amount, method) values ('${D2}', 400, 'cash'), ('${D5}', 300, 'cash');
  insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by) values ('${D5}','bonus',10,'x',current_date,'${A}');`);
const count = async (uid, table) => {
  const res = await as("authenticated", uid, `select count(*)::int as n from public.${table}`);
  return res.ok ? res.rows[0].n : `ERR ${res.msg}`;
};
ok("zone A manager reads zone A riders' documents only", (await count(M, "rider_documents")) === 2);
ok("zone B manager reads zone B riders' documents only", (await count(MB, "rider_documents")) === 1);
ok("zone A manager reads zone A deposits only", (await count(M, "cash_deposits")) === 1);
ok("zone B manager reads zone B adjustments only", (await count(MB, "rider_adjustments")) === 1);
ok("managers never read payout accounts", fails(await as("authenticated", M, `select * from public.rider_payout_accounts`), /permission denied/));
ok("managers never read rating customer ids", fails(await as("authenticated", M, `select customer_id from public.rider_ratings`), /permission denied/));

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);
ok("base zones", !!ZA && !!ZB);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
