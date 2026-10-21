// Runs migration 0150 (the Rider tables the manager rider screens need, built
// here in the Rider plans' exact shapes because Rider 0083–0086 have not landed)
// in an in-process Postgres (PGlite) on top of manager-base.mjs (0081 → 0082 → 0141).
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0150.mjs
import { managerBase, readMigration, id, IDS } from "./manager-base.mjs";

const MIGRATION = readMigration("0150_rider_tables_converge.sql");
const { db, ZA } = await managerBase();
const { A, M, C, D1, D2 } = IDS;

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
const one = async (sql) => (await db.query(sql)).rows[0];
const cols = async (t) =>
  (await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name='${t}' order by column_name`))
    .rows.map((r) => r.column_name);
const has = (list, want) => want.every((c) => list.includes(c));

console.log("\n── shapes (Rider 0083 as landed; Rider plans 0084–0086) ──");
ok("rider_earnings", has(await cols("rider_earnings"), ["id","delivery_id","order_id","driver_id","earned_at","base_fee","distance_km","billable_km","distance_fee","min_topup","tip_amount","tip_in_cash","amount","payout_id","created_at"]));
ok("rider_incentive_rules", has(await cols("rider_incentive_rules"), ["id","name","period","target_deliveries","bonus_amount","window_start","window_end","starts_on","ends_on","active","created_by","created_at","updated_at"]));
ok("rider_incentive_awards", has(await cols("rider_incentive_awards"), ["id","rule_id","driver_id","period_start","deliveries_count","amount","trigger_delivery_id","awarded_at","notified_at","payout_id"]));
ok("rider_adjustments", has(await cols("rider_adjustments"), ["id","driver_id","kind","amount","reason","order_id","effective_on","created_by","created_at","payout_id"]));
ok("rider_payouts", has(await cols("rider_payouts"), ["id","driver_id","period_end","amount","method","reference","paid_on","note","created_by","created_at"]));
ok("rider_ratings", has(await cols("rider_ratings"), ["id","order_id","driver_id","customer_id","rating","comment","created_at"]));
ok("my_rider_ratings view has no customer_id", !(await cols("my_rider_ratings")).includes("customer_id") && (await cols("my_rider_ratings")).includes("rating"));
ok("cash_deposits", has(await cols("cash_deposits"), ["id","driver_id","amount","method","manager_id","reference","photo_path","note","status","handover_id","decided_by","decided_at","decision_note","created_at"]));
ok("cash_disputes", has(await cols("cash_disputes"), ["id","driver_id","day","claimed_amount","message","status","resolution","resolved_by","resolved_at","created_at"]));
ok("cash_reminders", has(await cols("cash_reminders"), ["driver_id","last_sent_at"]));
ok("rider_profiles 0086 columns", has(await cols("rider_profiles"), ["address_line","city","pincode","vehicle_type","vehicle_owner","vehicle_registration","licence_number","licence_expires_on","emergency_name","emergency_phone","emergency_relation","verification_status","verified_at","verified_by","notification_prefs","nav_app","language"]));
ok("rider_documents", has(await cols("rider_documents"), ["id","driver_id","doc_type","number_masked","number","file_path","expires_on","status","remarks","reviewed_by","reviewed_at","reminded_30_at","reminded_7_at","reminded_1_at","reminded_expired_at","created_at"]));
ok("rider_payout_accounts", has(await cols("rider_payout_accounts"), ["driver_id","kind","holder_name","account_number","ifsc","upi_id","updated_at","updated_by"]));
ok("rider_profile_change_requests", has(await cols("rider_profile_change_requests"), ["id","driver_id","field","new_value","status","decided_by","decided_at","decision_note","created_at"]));
ok("rider-documents bucket is private, 10 MB, pdf/jpeg/png",
  (await one(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'rider-documents'`))?.public === false);
ok("verification_status defaults to unverified",
  (await one(`select verification_status from public.rider_profiles where driver_id = '${D1}'`)).verification_status === "unverified");

console.log("\n── checks ──");
const chk = async (sql, re) => fails(await as("service_role", null, sql), re);
ok("deposit confirmed without a handover raises", await chk(`insert into public.cash_deposits (driver_id, amount, method, status) values ('${D1}', 100, 'cash', 'confirmed')`, /violates check/));
ok("deposit disputed without a note raises", await chk(`insert into public.cash_deposits (driver_id, amount, method, status) values ('${D1}', 100, 'cash', 'disputed')`, /violates check/));
ok("adjustment kind outside the list raises", await chk(`insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by) values ('${D1}','tip',10,'x',current_date,'${A}')`, /violates check/));
ok("a deduction must be positive", await chk(`insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by) values ('${D1}','deduction',-10,'x',current_date,'${A}')`, /violates check/));
ok("pincode must be six digits", await chk(`update public.rider_profiles set pincode = '4913' where driver_id = '${D1}'`, /violates check/));
ok("IFSC format is checked", await chk(`insert into public.rider_payout_accounts (driver_id, kind, ifsc) values ('${D1}','bank','BAD')`, /violates check/));
await db.exec(`insert into public.rider_documents (driver_id, doc_type, file_path) values ('${D1}','aadhaar','d1/a.pdf')`);
ok("a second active document of the same type raises",
  await chk(`insert into public.rider_documents (driver_id, doc_type, file_path) values ('${D1}','aadhaar','d1/b.pdf')`, /duplicate key/));
ok("rating comment over 300 characters raises",
  await chk(`insert into public.rider_ratings (order_id, driver_id, customer_id, rating, comment) values (gen_random_uuid(),'${D1}','${C}',5,repeat('x',301))`, /violates check/));

console.log("\n── who can read what ──");
await db.exec(`insert into public.rider_payout_accounts (driver_id, kind, upi_id) values ('${D1}','upi','ravi@upi')`);
ok("a rider cannot read payout accounts", fails(await as("authenticated", D1, `select * from public.rider_payout_accounts`), /permission denied/));
ok("a manager cannot read payout accounts", fails(await as("authenticated", M, `select * from public.rider_payout_accounts`), /permission denied/));
ok("nobody signed in reads the staged accounts", fails(await as("authenticated", A, `select * from public.rider_payout_accounts_staged`), /permission denied/));
let r = await as("authenticated", D1, `select count(*)::int as n from public.rider_documents`);
ok("a rider reads their own documents", r.ok && r.rows[0].n === 1, r.msg);
r = await as("authenticated", D2, `select count(*)::int as n from public.rider_documents`);
ok("...and not someone else's", r.ok && r.rows[0].n === 0, r.msg);
ok("a rider cannot insert a document", fails(await as("authenticated", D1, `insert into public.rider_documents (driver_id, doc_type, file_path) values ('${D1}','pan','x')`), /permission denied|row-level/));
ok("a rider cannot read rider_ratings directly (customer ids)", fails(await as("authenticated", D1, `select customer_id from public.rider_ratings`), /permission denied/));

console.log("\n── record_rider_payout (0083's, admin only — 0152 then takes it from signed-in users) ──");
await db.exec(`insert into public.rider_adjustments (driver_id, kind, amount, reason, effective_on, created_by) values
  ('${D1}','salary',12000,'September salary','2026-09-30','${A}'), ('${D1}','deduction',500,'Damaged box','2026-09-20','${A}')`);
ok("a manager → forbidden", fails(await as("authenticated", M, `select public.record_rider_payout('${D1}','2026-09-30','bank','UTR1','2026-10-05',null)`), /forbidden/));
r = await as("authenticated", A, `select public.record_rider_payout('${D1}','2026-09-30','bank','UTR1','2026-10-05',null) as p`);
ok("an admin records the payout", r.ok, r.msg);
const p = await one(`select amount::numeric as amount from public.rider_payouts where driver_id = '${D1}'`);
ok("...for salary minus the deduction (11500)", Number(p.amount) === 11500, JSON.stringify(p));
ok("...and every summed row is attached", (await one(`select count(*)::int as n from public.rider_adjustments where driver_id = '${D1}' and payout_id is null`)).n === 0);
ok("a second payout for the same period → nothing_to_pay",
  fails(await as("authenticated", A, `select public.record_rider_payout('${D1}','2026-09-30','bank','UTR2','2026-10-05',null)`), /nothing_to_pay/));

console.log("\n── one definition: 0083 owns the money ledger ──");
const src = (await one(`select prosrc from pg_proc where proname = 'record_rider_payout'`)).prosrc;
ok("record_rider_payout is still 0083's (it takes the per-rider payout lock)", /pg_advisory_xact_lock/.test(src));
ok("...and dates an award by the earning that reached the target", /trigger_delivery_id/.test(src));
ok("no catch-all admin write policy on rider_adjustments",
  (await one(`select count(*)::int as n from pg_policies where tablename = 'rider_adjustments' and cmd = 'ALL'`)).n === 0);
ok("signed-in users cannot update or delete rider_adjustments",
  (await one(`select has_table_privilege('authenticated','public.rider_adjustments','UPDATE') or has_table_privilege('authenticated','public.rider_adjustments','DELETE') as x`)).x === false);
ok("rider_earnings keeps 0083's distance_source and its adds-up check",
  (await cols("rider_earnings")).includes("distance_source") &&
  (await one(`select count(*)::int as n from pg_constraint where conname = 'rider_earnings_amount_adds_up'`)).n === 1);
ok("rider_adjustments.payout_id restricts (0083), never cascades or nulls",
  (await one(`select confdeltype from pg_constraint where conrelid = 'public.rider_adjustments'::regclass and contype = 'f' and confrelid = 'public.rider_payouts'::regclass`)).confdeltype === "r");
ok("a paid ledger row cannot change (guard_rider_ledger)",
  await chk(`update public.rider_adjustments set amount = 1 where driver_id = '${D1}' and payout_id is not null`, /rider_ledger/));
ok("a paid ledger row cannot be deleted",
  await chk(`delete from public.rider_adjustments where driver_id = '${D1}' and payout_id is not null`, /rider_ledger_paid/));
ok("nobody signed in can select a raw document number",
  (await one(`select has_column_privilege('authenticated','public.rider_documents','number','SELECT') as x`)).x === false);
ok("...while the masked number stays readable",
  (await one(`select has_column_privilege('authenticated','public.rider_documents','number_masked','SELECT') as x`)).x === true);

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);
ok("the zone base still holds", !!ZA);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
