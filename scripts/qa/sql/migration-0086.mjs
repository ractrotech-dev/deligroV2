// Runs migration 0086 (rider profile, documents, payout accounts, change requests) on top of 0081 in
// one in-process Postgres (PGlite) with stubbed Supabase auth, storage and the tables 0081 leans on.
// Needs: @electric-sql/pglite@0.2.17 resolvable (npm i --no-save, or a scratch install wired in with a `node --import` resolve hook)
// Usage: node scripts/qa/sql/migration-0086.mjs
//
// Proves: the columns, checks and defaults; one live document per type; the Aadhaar mask (no writer can
// keep the full number); the payout-account containment (nobody signed in can touch either table);
// column grants (rider_documents.number, change_requests.new_value, rider_profiles.licence_number are
// never readable by a signed-in client); RLS (a rider reads only their own); rider_add_document and
// rider_decide_change_request; the verified-name guard; the platform setting; the bucket; the
// SECURITY_AUDIT verification queries; idempotency; the rollback block.
//
// CONVERGENCE with the Manager branch's 0150_rider_tables_converge.sql (which builds the same objects):
// three databases — 0086 alone, 0150 then 0086, 0086 then 0150 — must hold the same 0086 objects
// (columns, constraints, indexes, policies, grants, triggers, bucket). 0150 is read from this repo's
// supabase/migrations if it has been merged, else from MANAGER_0150 or the sibling worktree
// F:\hub26\deligro-manager; SKIPPED (not failed) when none exists.
//
// It does not replace running the migration on staging. PGlite is one connection, so concurrency is
// proved by the unique keys and the row lock, not by racing two sessions.
import { PGlite } from "@electric-sql/pglite";
import { existsSync, readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../../../supabase/migrations/${f}`, import.meta.url), "utf8");
const M0081 = read("0081_rider_app_foundation.sql");
let M0086 = "";
try { M0086 = read("0086_rider_profile_documents.sql"); } catch { /* reported below */ }

function find0150() {
  const candidates = [
    new URL("../../../supabase/migrations/0150_rider_tables_converge.sql", import.meta.url),
    process.env.MANAGER_0150,
    "F:/hub26/deligro-manager/supabase/migrations/0150_rider_tables_converge.sql",
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (existsSync(c)) return { sql: readFileSync(c, "utf8"), from: String(c) }; } catch { /* next */ }
  }
  return null;
}

const STUBS = `
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
  create role anon; create role authenticated; create role service_role bypassrls;

  -- Supabase default: every table, sequence and function created later in public
  -- is granted to the API roles. The migrations have to take that back themselves.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]);

  create table public.profiles (id uuid primary key, role text not null, full_name text, phone text,
    created_at timestamptz not null default now());
  create table public.orders (id uuid primary key, status text not null default 'ready', customer_id uuid);
  create type public.delivery_status as enum ('unassigned', 'assigned', 'picked_up', 'delivered', 'cancelled');
  create table public.deliveries (
    id uuid primary key default gen_random_uuid(),
    order_id uuid not null unique references public.orders (id) on delete cascade,
    driver_id uuid references public.profiles (id) on delete set null,
    status public.delivery_status not null default 'unassigned',
    assigned_at timestamptz, picked_up_at timestamptz, delivered_at timestamptz,
    driver_lat double precision, driver_lng double precision, driver_location_at timestamptz,
    offered_driver_id uuid references public.profiles (id) on delete set null, offered_at timestamptz,
    cod_collected_amount integer, cod_collected_at timestamptz);
  -- 0047 (0150's cash_deposits references it).
  create table public.cod_handovers (id uuid primary key default gen_random_uuid());
  create table public.platform_settings (id boolean primary key default true check (id),
    business_name text not null default 'Deligro', vendor_commission_pct numeric);
  insert into public.platform_settings (id) values (true);

  create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;
  create function public.current_role() returns text language sql stable security definer set search_path = public as $$
    select role from public.profiles where id = auth.uid() $$;

  alter table public.profiles enable row level security;
  create policy "profiles — read" on public.profiles for select using (true);
  -- 0001: a person edits their own row; admins edit any.
  create policy "own profile — update" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
  create policy "profiles — admin update" on public.profiles for update using (public.is_admin()) with check (public.is_admin());

  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  revoke select on public.platform_settings from anon, authenticated;
  grant select (id, business_name) on public.platform_settings to anon, authenticated;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`;

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const D1 = id(0xd1), D2 = id(0xd2), D3 = id(0xd3), M = id(0xe1), A = id(0xa1), C = id(0xc1);
const PEOPLE = `
  insert into public.profiles (id, role, full_name, created_at) values
    ('${D1}','driver','Ravi Kumar','2026-01-01'), ('${D2}','driver','Second rider','2026-01-02'),
    ('${D3}','driver','Third rider','2026-01-03'),
    ('${M}','manager','Manager','2026-01-05'), ('${A}','admin','Admin','2026-01-06'), ('${C}','customer','Customer','2026-01-07');
`;

async function fresh(steps) {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(PEOPLE);
  await db.exec(M0081);
  for (const sql of steps) await db.exec(sql);
  return db;
}

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };
const skip = (n) => console.log(`  SKIP ${n}`);

let db;
let applied = true;
try {
  if (!M0086) throw new Error("supabase/migrations/0086_rider_profile_documents.sql not found");
  db = await fresh([M0086]);
} catch (e) { applied = false; console.log(`0086 did not apply: ${e.message}`); }
ok("0086 applies on top of 0081", applied);
if (!applied) { console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }

async function run(sql, on = db) {
  try { const r = await on.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: String(e.message), code: e.code, detail: e.detail }; }
}
async function as(role, uid, sql, on = db) {
  await on.exec(`set role ${role};
    select set_config('test.uid','${uid ?? ""}',false);
    select set_config('test.jwt','{"role":"${role}"}',false);`);
  try { return await run(sql, on); }
  finally { await on.exec("reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);"); }
}
const denied = (r) => !r.ok && /permission denied/.test(r.msg);
const checkFails = (r) => !r.ok && r.code === "23514";
const uniqueFails = (r) => !r.ok && r.code === "23505";
const raises = (r, msg) => !r.ok && r.msg.includes(msg);
const one = async (sql, on = db) => (await on.query(sql)).rows[0];
const count = async (sql, on = db) => Number((await one(`select count(*)::int as n from (${sql}) q`, on)).n);

// ── rider_profiles ──
console.log("\n── rider_profiles: the profile ──");
let p = await one(`select * from public.rider_profiles where driver_id = '${D1}'`);
ok("verification starts 'unverified'; vehicle owner 'deligro'; prefs {}; language 'en'",
  p.verification_status === "unverified" && p.vehicle_owner === "deligro" && JSON.stringify(p.notification_prefs) === "{}" && p.language === "en");
ok("a 5-digit pincode is refused", checkFails(await run(`update public.rider_profiles set pincode = '56001' where driver_id = '${D1}'`)));
ok("a pincode with a letter is refused", checkFails(await run(`update public.rider_profiles set pincode = '56000A' where driver_id = '${D1}'`)));
ok("a 6-digit pincode is kept", (await run(`update public.rider_profiles set pincode = '560001' where driver_id = '${D1}'`)).ok);
ok("an emergency phone of 9 digits is refused", checkFails(await run(`update public.rider_profiles set emergency_phone = '987654321' where driver_id = '${D1}'`)));
ok("an emergency phone with spaces is refused (the server normalises first)", checkFails(await run(`update public.rider_profiles set emergency_phone = '98765 43210' where driver_id = '${D1}'`)));
ok("+91 and 10 digits is kept", (await run(`update public.rider_profiles set emergency_phone = '+919876543210' where driver_id = '${D1}'`)).ok);
ok("vehicle type 'car' is refused", checkFails(await run(`update public.rider_profiles set vehicle_type = 'car' where driver_id = '${D1}'`)));
ok("vehicle owner 'friend' is refused", checkFails(await run(`update public.rider_profiles set vehicle_owner = 'friend' where driver_id = '${D1}'`)));
ok("verification 'approved' is refused", checkFails(await run(`update public.rider_profiles set verification_status = 'approved' where driver_id = '${D1}'`)));
ok("verification null is refused", !(await run(`update public.rider_profiles set verification_status = null where driver_id = '${D1}'`)).ok);
await db.exec(`update public.rider_profiles set address_line = 'Flat 2, Rāma Nivās, शिवाजी नगर', city = 'Pune',
  licence_number = 'MH1220110012345', licence_expires_on = '2031-01-01', vehicle_type = 'ev_bike' where driver_id = '${D1}'`);
p = await one(`select address_line from public.rider_profiles where driver_id = '${D1}'`);
ok("non-ASCII address (accents, Devanagari) is stored intact", p.address_line === "Flat 2, Rāma Nivās, शिवाजी नगर");

let r = await as("authenticated", D1, `select driver_id, rider_code, address_line, emergency_phone, verification_status from public.rider_profiles`);
ok("a rider reads their own profile row only", r.ok && r.rows.length === 1 && r.rows[0].driver_id === D1);
ok("a rider cannot select licence_number (column grant)", denied(await as("authenticated", D1, `select licence_number from public.rider_profiles`)));
ok("...nor select * (the whole row includes it)", denied(await as("authenticated", D1, `select * from public.rider_profiles`)));
r = await as("authenticated", M, `select driver_id, address_line from public.rider_profiles`);
ok("a manager still reads rider profiles (0081's policy), by the granted columns", r.ok && r.rows.length === 3);
ok("...but never the licence number", denied(await as("authenticated", M, `select licence_number from public.rider_profiles`)));
ok("a rider cannot update their own profile row (service role writes)", denied(await as("authenticated", D1, `update public.rider_profiles set city = 'X' where driver_id = '${D1}'`)));
ok("anon reads nothing from rider_profiles", denied(await as("anon", null, `select driver_id from public.rider_profiles`)));

// ── notification_prefs: the compare-and-swap PostgREST generates ──
// updateNotificationPrefs (data-access/rider-profile.ts) writes `{...}` and then updates
// `where driver_id = $1 and notification_prefs = <the JSON it read>`. PostgREST sends that filter value as
// an UNTYPED literal, so Postgres must resolve it as jsonb: equal as JSON whatever the key order or spacing.
console.log("\n── notification_prefs: jsonb compare-and-swap (the eq filter) ──");
{
  const w = (sql) => as("service_role", null, sql);
  ok("the service role writes {a,b} off", (await w(`update public.rider_profiles set notification_prefs = '{"a":false,"b":false}'::jsonb where driver_id = '${D3}'`)).ok);
  r = await w(`update public.rider_profiles set notification_prefs = '{"a":false}'::jsonb where driver_id = '${D3}' and notification_prefs = '{"b":false,"a":false}' returning driver_id`);
  ok("an untyped literal with the keys in another order matches: 1 row updated", r.ok && r.rows.length === 1);
  r = await w(`update public.rider_profiles set notification_prefs = '{"a":false,"c":false}'::jsonb where driver_id = '${D3}' and notification_prefs = '{ "a" : false }' returning driver_id`);
  ok("...and whitespace in the literal does not matter", r.ok && r.rows.length === 1);
  r = await w(`update public.rider_profiles set notification_prefs = '{"z":false}'::jsonb where driver_id = '${D3}' and notification_prefs = '{"a":false}' returning driver_id`);
  ok("a stale read (the row has moved on) matches 0 rows: the lost race is detected", r.ok && r.rows.length === 0);
  ok("...and the row is untouched by the lost write", JSON.stringify((await one(`select notification_prefs from public.rider_profiles where driver_id = '${D3}'`)).notification_prefs) === '{"a":false,"c":false}');
  r = await w(`update public.rider_profiles set notification_prefs = '{"q":false}'::jsonb where driver_id = '${D3}' and notification_prefs = '{}' returning driver_id`);
  ok("an empty-object read does not match a non-empty row", r.ok && r.rows.length === 0);
  await w(`update public.rider_profiles set notification_prefs = '{}'::jsonb where driver_id = '${D3}'`);
  r = await w(`update public.rider_profiles set notification_prefs = '{"q":false}'::jsonb where driver_id = '${D3}' and notification_prefs = '{}' returning driver_id`);
  ok("...and '{}' matches the default empty row", r.ok && r.rows.length === 1);
  // as a bound parameter, the way a driver would send it (type resolved from the column)
  try {
    const pr = await db.query(`update public.rider_profiles set notification_prefs = $1::jsonb where driver_id = $2 and notification_prefs = $3 returning driver_id`, ['{"x":false}', D3, '{"q": false}']);
    ok("an untyped bound parameter ($3) resolves to jsonb too", pr.rows.length === 1);
  } catch (e) { ok(`an untyped bound parameter ($3) resolves to jsonb too (${e.message})`, false); }
  await w(`update public.rider_profiles set notification_prefs = '{}'::jsonb where driver_id = '${D3}'`);
}

// ── rider_documents ──
console.log("\n── rider_documents ──");
const doc = (driver, type, extra = "") => `insert into public.rider_documents (driver_id, doc_type, file_path${extra ? ", " + extra.split("=")[0] : ""})
  values ('${driver}','${type}','${driver}/${type}/x.pdf'${extra ? ", " + extra.split("=").slice(1).join("=") : ""}) returning id`;
ok("doc type 'passport' is refused", checkFails(await run(doc(D1, "passport"))));
let d1pan = (await one(doc(D1, "pan", "number='ABCDE1234F'"))).id;
ok("a PAN is stored with its number in full", (await one(`select number from public.rider_documents where id = '${d1pan}'`)).number === "ABCDE1234F");
ok("status starts 'pending'", (await one(`select status from public.rider_documents where id = '${d1pan}'`)).status === "pending");
ok("status 'archived' is refused", checkFails(await run(`update public.rider_documents set status = 'archived' where id = '${d1pan}'`)));
ok("a second live PAN for the same rider is refused (one live per type)", uniqueFails(await run(doc(D1, "pan"))));
await db.exec(`update public.rider_documents set status = 'replaced' where id = '${d1pan}'`);
ok("...after the first is replaced, a new one is accepted", (await run(doc(D1, "pan"))).ok);
ok("...and a third live one is refused again", uniqueFails(await run(doc(D1, "pan"))));
ok("another rider's PAN does not collide", (await run(doc(D2, "pan"))).ok);
ok("a rejected document still counts as live (replace it, don't stack)",
  (await run(`update public.rider_documents set status = 'rejected' where driver_id = '${D2}' and doc_type = 'pan'`)).ok && uniqueFails(await run(doc(D2, "pan"))));

console.log("\n── Aadhaar: last four only, whoever writes ──");
const aad = (await one(doc(D1, "aadhaar", "number='1234 5678 9012'"))).id;
let a = await one(`select number, number_masked from public.rider_documents where id = '${aad}'`);
ok("the service role inserting 12 digits keeps NONE of them in number", a.number === null);
ok("...number_masked is 'XXXX-XXXX-9012'", a.number_masked === "XXXX-XXXX-9012");
await db.exec(`update public.rider_documents set number = '999988887777' where id = '${aad}'`);
a = await one(`select number, number_masked from public.rider_documents where id = '${aad}'`);
ok("an UPDATE that sets the number is masked too", a.number === null && a.number_masked === "XXXX-XXXX-7777");
const aadMaskedOnly = (await one(`insert into public.rider_documents (driver_id, doc_type, number_masked, file_path)
  values ('${D2}','aadhaar','123412341234','${D2}/aadhaar/m.pdf') returning id`)).id;
a = await one(`select number, number_masked from public.rider_documents where id = '${aadMaskedOnly}'`);
ok("twelve digits written into number_masked (not number) are masked too", a.number === null && a.number_masked === "XXXX-XXXX-1234");
await db.exec(`update public.rider_documents set number_masked = '5555 6666 7777' where id = '${aadMaskedOnly}'`);
ok("...on update as well", (await one(`select number_masked from public.rider_documents where id = '${aadMaskedOnly}'`)).number_masked === "XXXX-XXXX-7777");
await db.exec(`update public.rider_documents set status = 'replaced' where id = '${aadMaskedOnly}'`);
const aadNone = (await one(`insert into public.rider_documents (driver_id, doc_type, file_path) values ('${D2}','aadhaar','${D2}/aadhaar/n.pdf') returning id`)).id;
ok("an Aadhaar with no number at all keeps number_masked null", (await one(`select number_masked from public.rider_documents where id = '${aadNone}'`)).number_masked === null);
await db.exec(`delete from public.rider_documents where id in ('${aadMaskedOnly}', '${aadNone}')`);
ok("no Aadhaar row anywhere holds a number",
  (await count(`select 1 from public.rider_documents where doc_type = 'aadhaar' and number is not null`)) === 0);

r = await as("authenticated", D1, `select id, doc_type, number_masked, status from public.rider_documents`);
ok("a rider reads their own documents", r.ok && r.rows.length > 0 && r.rows.every((x) => x.doc_type));
ok("...and only their own (rider 1 never sees rider 2's PAN)",
  r.ok && (await count(`select 1 from public.rider_documents where driver_id = '${D1}'`)) === r.rows.length);
r = await as("authenticated", D2, `select id from public.rider_documents where id = '${aad}'`);
ok("guessing another rider's document id returns no row", r.ok && r.rows.length === 0);
ok("a rider cannot select the raw number (column grant)", denied(await as("authenticated", D1, `select number from public.rider_documents`)));
ok("...nor select *", denied(await as("authenticated", D1, `select * from public.rider_documents`)));
ok("a rider cannot insert a document directly", denied(await as("authenticated", D1, doc(D1, "photo"))));
ok("a rider cannot verify their own document", denied(await as("authenticated", D1, `update public.rider_documents set status = 'verified' where id = '${aad}'`)));
ok("a rider cannot delete a document", denied(await as("authenticated", D1, `delete from public.rider_documents where id = '${aad}'`)));
r = await as("authenticated", A, `select id, number_masked from public.rider_documents`);
ok("an admin reads every rider's documents (masked column)", r.ok && r.rows.length === (await count(`select 1 from public.rider_documents`)));
ok("...but not the raw number through their JWT either (the server reads it)", denied(await as("authenticated", A, `select number from public.rider_documents`)));
r = await as("authenticated", M, `select id from public.rider_documents`);
ok("a manager reads none here (0151 adds the zone-scoped policy)", r.ok && r.rows.length === 0);
ok("anon reads nothing", denied(await as("anon", null, `select id from public.rider_documents`)));

// ── payout accounts ──
console.log("\n── payout accounts: the containment ──");
await db.exec(`insert into public.rider_payout_accounts (driver_id, kind, holder_name, account_number, ifsc)
               values ('${D1}','bank','Ravi Kumar','123456789012','HDFC0001234')`);
ok("a lower-case IFSC is refused", checkFails(await run(`update public.rider_payout_accounts set ifsc = 'hdfc0001234' where driver_id = '${D1}'`)));
ok("an IFSC whose fifth character is not 0 is refused", checkFails(await run(`update public.rider_payout_accounts set ifsc = 'HDFC1001234' where driver_id = '${D1}'`)));
ok("kind 'cash' is refused", checkFails(await run(`update public.rider_payout_accounts set kind = 'cash' where driver_id = '${D1}'`)));
ok("the staged table checks the IFSC too",
  checkFails(await run(`insert into public.rider_payout_accounts_staged (driver_id, kind, ifsc) values ('${D1}','bank','HDFC01234')`)));
for (const table of ["rider_payout_accounts", "rider_payout_accounts_staged"]) {
  for (const [who, uid, role] of [["the rider", D1, "authenticated"], ["another rider", D2, "authenticated"], ["a manager", M, "authenticated"], ["an admin's JWT", A, "authenticated"], ["anon", null, "anon"]]) {
    ok(`${table}: ${who} cannot select`, denied(await as(role, uid, `select driver_id from public.${table}`)));
  }
  ok(`${table}: the rider cannot insert`, denied(await as("authenticated", D1, `insert into public.${table} (driver_id, kind, upi_id) values ('${D1}','upi','x@ybl')`)));
  ok(`${table}: the rider cannot update`, denied(await as("authenticated", D1, `update public.${table} set upi_id = 'x@ybl'`)));
  ok(`${table}: the rider cannot delete`, denied(await as("authenticated", D1, `delete from public.${table}`)));
  ok(`${table}: the service role can read`, (await as("service_role", null, `select driver_id from public.${table}`)).ok);
}
ok("both tables have RLS on with no policies (deny-all is the point)",
  (await count(`select 1 from pg_class c where c.relname in ('rider_payout_accounts','rider_payout_accounts_staged') and c.relrowsecurity`)) === 2 &&
  (await count(`select 1 from pg_policy pol join pg_class c on c.oid = pol.polrelid where c.relname in ('rider_payout_accounts','rider_payout_accounts_staged')`)) === 0);

// ── change requests ──
console.log("\n── rider_profile_change_requests ──");
ok("field 'phone' is refused", checkFails(await run(`insert into public.rider_profile_change_requests (driver_id, field, new_value) values ('${D1}','phone','{}')`)));
ok("status 'maybe' is refused", checkFails(await run(`insert into public.rider_profile_change_requests (driver_id, field, new_value, status) values ('${D1}','vehicle','{}','maybe')`)));
ok("new_value is required", !(await run(`insert into public.rider_profile_change_requests (driver_id, field) values ('${D1}','vehicle')`)).ok);
const crLic = (await one(`insert into public.rider_profile_change_requests (driver_id, field, new_value)
  values ('${D1}','licence','{"number":"MH1420250099999","expiresOn":"2036-05-01"}') returning id`)).id;
ok("a second pending licence request for the same rider is refused",
  uniqueFails(await run(`insert into public.rider_profile_change_requests (driver_id, field, new_value) values ('${D1}','licence','{"number":"X","expiresOn":"2030-01-01"}')`)));
ok("...a pending request for another field is fine",
  (await run(`insert into public.rider_profile_change_requests (driver_id, field, new_value) values ('${D1}','full_name','{"fullName":"रवि कुमार"}')`)).ok);
r = await as("authenticated", D1, `select id, field, status, decision_note, created_at from public.rider_profile_change_requests`);
ok("a rider reads their own requests (granted columns)", r.ok && r.rows.length === 2);
ok("...but never new_value (it holds a licence number)", denied(await as("authenticated", D1, `select new_value from public.rider_profile_change_requests`)));
r = await as("authenticated", D2, `select id from public.rider_profile_change_requests`);
ok("another rider sees none of them", r.ok && r.rows.length === 0);
ok("a rider cannot file a request directly", denied(await as("authenticated", D1, `insert into public.rider_profile_change_requests (driver_id, field, new_value) values ('${D1}','vehicle','{}')`)));
ok("a rider cannot approve their own request", denied(await as("authenticated", D1, `update public.rider_profile_change_requests set status = 'approved' where id = '${crLic}'`)));
ok("an admin's JWT cannot read new_value either", denied(await as("authenticated", A, `select new_value from public.rider_profile_change_requests`)));

// ── rider_decide_change_request ──
console.log("\n── rider_decide_change_request ──");
const decide = (reqId, actor, decision, note) =>
  run(`select public.rider_decide_change_request('${reqId}', ${actor ? `'${actor}'` : "null"}, '${decision}', ${note === null ? "null" : `'${note}'`}) as r`);
ok("authenticated cannot execute it", denied(await as("authenticated", A, `select public.rider_decide_change_request('${crLic}', '${A}', 'approve', null)`)));
ok("anon cannot execute it", denied(await as("anon", null, `select public.rider_decide_change_request('${crLic}', '${A}', 'approve', null)`)));
ok("an unknown request is not_found", raises(await decide(id(0xdead), A, "approve", null), "not_found"));
ok("a decision other than approve/reject is refused", raises(await decide(crLic, A, "maybe", null), "invalid_decision"));
ok("a rejection without a note is refused", raises(await decide(crLic, A, "reject", null), "reason_required"));
ok("...a two-character note too", raises(await decide(crLic, A, "reject", "no"), "reason_required"));
r = await decide(crLic, A, "approve", null);
ok("approving the licence change succeeds", r.ok && r.rows[0].r.status === "approved");
p = await one(`select licence_number, licence_expires_on::text as e from public.rider_profiles where driver_id = '${D1}'`);
ok("...and applies it to the profile", p.licence_number === "MH1420250099999" && p.e === "2036-05-01");
let cr = await one(`select status, decided_by, decided_at from public.rider_profile_change_requests where id = '${crLic}'`);
ok("...recording who decided and when", cr.status === "approved" && cr.decided_by === A && cr.decided_at !== null);
ok("deciding it again is already_decided", raises(await decide(crLic, A, "reject", "too late"), "already_decided"));
ok("...and a new pending licence request is accepted after the decision",
  (await run(`insert into public.rider_profile_change_requests (driver_id, field, new_value) values ('${D1}','licence','{"number":"MH0000000000001","expiresOn":"2040-01-01"}')`)).ok);

const crName = (await one(`select id from public.rider_profile_change_requests where driver_id = '${D1}' and field = 'full_name' and status = 'pending'`)).id;
await decide(crName, A, "approve", "Matches the Aadhaar");
ok("an approved name change writes profiles.full_name (non-ASCII intact)",
  (await one(`select full_name from public.profiles where id = '${D1}'`)).full_name === "रवि कुमार");
const crVeh = (await one(`insert into public.rider_profile_change_requests (driver_id, field, new_value)
  values ('${D1}','vehicle','{"type":"bike","owner":"rider","registration":"KA01AB1234"}') returning id`)).id;
await decide(crVeh, A, "approve", null);
p = await one(`select vehicle_type, vehicle_owner, vehicle_registration from public.rider_profiles where driver_id = '${D1}'`);
ok("an approved vehicle change writes type, owner and registration", p.vehicle_type === "bike" && p.vehicle_owner === "rider" && p.vehicle_registration === "KA01AB1234");
const crBad = (await one(`insert into public.rider_profile_change_requests (driver_id, field, new_value) values ('${D2}','vehicle','{"type":"car","owner":"rider"}') returning id`)).id;
ok("a vehicle value the profile's check refuses fails the approval (and changes nothing)",
  checkFails(await decide(crBad, A, "approve", null)) &&
  (await one(`select status from public.rider_profile_change_requests where id = '${crBad}'`)).status === "pending");
const crShape = (await one(`insert into public.rider_profile_change_requests (driver_id, field, new_value) values ('${D3}','full_name','{"name":"x"}') returning id`)).id;
ok("a value of the wrong shape is invalid_value", raises(await decide(crShape, A, "approve", null), "invalid_value"));
ok("...and the name was not touched (no null written)", (await one(`select full_name from public.profiles where id = '${D3}'`)).full_name === "Third rider");
const crLong = (await one(`insert into public.rider_profile_change_requests (driver_id, field, new_value) values ('${D2}','full_name','{"fullName":"${"x".repeat(81)}"}') returning id`)).id;
ok("a name over 80 characters is invalid_value", raises(await decide(crLong, A, "approve", null), "invalid_value"));
const crNoStage = (await one(`insert into public.rider_profile_change_requests (driver_id, field, new_value) values ('${D3}','payout_account','{"stagedId":"not-a-uuid"}') returning id`)).id;
ok("a payout request without a valid staged id is invalid_value", raises(await decide(crNoStage, A, "approve", null), "invalid_value"));
ok("...and can still be rejected", (await decide(crNoStage, A, "reject", "Bad request")).ok);

console.log("\n── a bank change while a payout is being recorded (Review Focus 3) ──");
const staged = (await one(`insert into public.rider_payout_accounts_staged (driver_id, kind, holder_name, account_number, ifsc)
  values ('${D1}','bank','Ravi Kumar','999900001111','ICIC0004321') returning id`)).id;
const crPay = (await one(`insert into public.rider_profile_change_requests (driver_id, field, new_value)
  values ('${D1}','payout_account','{"stagedId":"${staged}"}') returning id`)).id;
let acct = await one(`select account_number, ifsc from public.rider_payout_accounts where driver_id = '${D1}'`);
ok("while the request is pending the approved account is untouched (a payout uses it)",
  acct.account_number === "123456789012" && acct.ifsc === "HDFC0001234");
ok("the request carries only a reference to the staged row",
  JSON.stringify(Object.keys((await one(`select new_value from public.rider_profile_change_requests where id = '${crPay}'`)).new_value)) === '["stagedId"]');
r = await decide(crPay, A, "approve", null);
acct = await one(`select account_number, ifsc, updated_by from public.rider_payout_accounts where driver_id = '${D1}'`);
ok("approving copies the staged account in, stamped with the admin",
  r.ok && acct.account_number === "999900001111" && acct.ifsc === "ICIC0004321" && acct.updated_by === A);
ok("...and deletes the staged copy", (await count(`select 1 from public.rider_payout_accounts_staged where id = '${staged}'`)) === 0);
const staged2 = (await one(`insert into public.rider_payout_accounts_staged (driver_id, kind, upi_id) values ('${D1}','upi','ravi@okhdfc') returning id`)).id;
const crPay2 = (await one(`insert into public.rider_profile_change_requests (driver_id, field, new_value)
  values ('${D1}','payout_account','{"stagedId":"${staged2}"}') returning id`)).id;
await decide(crPay2, A, "reject", "Name on the UPI does not match");
ok("rejecting deletes the staged account and leaves the approved one",
  (await count(`select 1 from public.rider_payout_accounts_staged where id = '${staged2}'`)) === 0 &&
  (await one(`select kind from public.rider_payout_accounts where driver_id = '${D1}'`)).kind === "bank");
const staged3 = (await one(`insert into public.rider_payout_accounts_staged (driver_id, kind, upi_id) values ('${D2}','upi','two@ybl') returning id`)).id;
const crPay3 = (await one(`insert into public.rider_profile_change_requests (driver_id, field, new_value)
  values ('${D1}','payout_account','{"stagedId":"${staged3}"}') returning id`)).id;
ok("a request pointing at ANOTHER rider's staged row is staged_missing (never applied)",
  raises(await decide(crPay3, A, "approve", null), "staged_missing") &&
  (await one(`select kind from public.rider_payout_accounts where driver_id = '${D1}'`)).kind === "bank");
r = await decide(crPay3, null, "reject", "Withdrawn");
ok("a server-applied decision records no admin (decided_by null)", r.ok &&
  (await one(`select decided_by from public.rider_profile_change_requests where id = '${crPay3}'`)).decided_by === null);
ok("...and does not delete the other rider's staged row", (await count(`select 1 from public.rider_payout_accounts_staged where id = '${staged3}'`)) === 1);

// ── rider_add_document ──
console.log("\n── rider_add_document ──");
const add = (driver, type, num, masked, path, exp) =>
  run(`select public.rider_add_document('${driver}', '${type}', ${num === null ? "null" : `'${num}'`}, ${masked === null ? "null" : `'${masked}'`},
       '${path}', ${exp === null ? "null" : `'${exp}'`}) as id`);
ok("authenticated cannot execute it", denied(await as("authenticated", D3, `select public.rider_add_document('${D3}','photo',null,null,'${D3}/photo/a.jpg',null)`)));
ok("an unknown type is bad_type", raises(await add(D3, "passport", null, null, `${D3}/passport/a.pdf`, null), "bad_type"));
ok("a licence without expiry is expiry_required", raises(await add(D3, "driving_licence", "KA0120200001234", "XXXX1234", `${D3}/driving_licence/a.pdf`, null), "expiry_required"));
ok("insurance without expiry is expiry_required", raises(await add(D3, "insurance", null, null, `${D3}/insurance/a.pdf`, null), "expiry_required"));
ok("PUC without expiry is expiry_required", raises(await add(D3, "puc", null, null, `${D3}/puc/a.pdf`, null), "expiry_required"));
ok("a path in another rider's folder is forbidden", raises(await add(D3, "photo", null, null, `${D2}/photo/a.jpg`, null), "forbidden"));
ok("a path under another type's folder is forbidden", raises(await add(D3, "photo", null, null, `${D3}/aadhaar/a.jpg`, null), "forbidden"));
ok("a non-driver is not_rider", raises(await add(C, "photo", null, null, `${C}/photo/a.jpg`, null), "not_rider"));
r = await add(D3, "aadhaar", "234567890123", "XXXX-XXXX-0123", `${D3}/aadhaar/a.pdf`, null);
ok("a valid upload returns the new document's id", r.ok && /^[0-9a-f-]{36}$/.test(r.rows[0].id));
const firstAad = r.rows[0].id;
a = await one(`select number, number_masked, status from public.rider_documents where id = '${firstAad}'`);
ok("...pending, with the Aadhaar masked and no number", a.status === "pending" && a.number === null && a.number_masked === "XXXX-XXXX-0123");
ok("...and the rider's verification is now pending", (await one(`select verification_status from public.rider_profiles where driver_id = '${D3}'`)).verification_status === "pending");
await db.exec(`update public.rider_profiles set verification_status = 'verified', verified_at = now(), verified_by = '${A}' where driver_id = '${D3}'`);
r = await add(D3, "aadhaar", null, null, `${D3}/aadhaar/b.pdf`, null);
ok("a replacement upload succeeds", r.ok);
ok("...the previous one becomes 'replaced'", (await one(`select status from public.rider_documents where id = '${firstAad}'`)).status === "replaced");
ok("...exactly one live Aadhaar remains", (await count(`select 1 from public.rider_documents where driver_id = '${D3}' and doc_type = 'aadhaar' and status <> 'replaced'`)) === 1);
ok("P6-R1: a VERIFIED rider stays verified after a replacement upload (only the document is pending)",
  (await one(`select verification_status from public.rider_profiles where driver_id = '${D3}'`)).verification_status === "verified");
await db.exec(`update public.rider_profiles set verification_status = 'rejected' where driver_id = '${D2}'`);
await add(D2, "photo", null, null, `${D2}/photo/r.jpg`, null);
ok("...a REJECTED rider's upload puts them back to pending",
  (await one(`select verification_status from public.rider_profiles where driver_id = '${D2}'`)).verification_status === "pending");
await db.exec(`update public.rider_profiles set verification_status = 'unverified' where driver_id = '${D2}'`);

console.log("\n── CRITICAL 1: an upload cannot reopen verified fields ──");
await db.exec(`update public.rider_profile_change_requests set status = 'rejected', decision_note = 'cleanup'
  where driver_id in ('${D2}', '${D3}') and status = 'pending'`);
for (const [field, value] of [["full_name", '{"fullName":"Not Me"}'], ["licence", '{"number":"XX0000000000001","expiresOn":"2040-01-01"}'], ["vehicle", '{"type":"bike","owner":"rider","registration":"KA99ZZ9999"}']]) {
  const req = (await one(`insert into public.rider_profile_change_requests (driver_id, field, new_value) values ('${D3}','${field}','${value}') returning id`)).id;
  ok(`an ever-verified rider's ${field} change cannot be applied without an admin (approval_required)`,
    raises(await decide(req, null, "approve", "x"), "approval_required") &&
    (await one(`select status from public.rider_profile_change_requests where id = '${req}'`)).status === "pending");
  await decide(req, A, "reject", "Test cleanup");
}
ok("...vehicle_owner was not flipped", (await one(`select vehicle_owner from public.rider_profiles where driver_id = '${D3}'`)).vehicle_owner === "deligro");
await db.exec(`update public.rider_profiles set verification_status = 'pending' where driver_id = '${D3}'`);
const reqP = (await one(`insert into public.rider_profile_change_requests (driver_id, field, new_value) values ('${D3}','full_name','{"fullName":"Still Not Me"}') returning id`)).id;
ok("...even while their status reads 'pending' (verified_at is what counts)", raises(await decide(reqP, null, "approve", null), "approval_required"));
ok("...an admin can still apply it", (await decide(reqP, A, "approve", null)).ok);
const st = (await one(`insert into public.rider_payout_accounts_staged (driver_id, kind, upi_id) values ('${D2}','upi','two@ybl') returning id`)).id;
const reqPay = (await one(`insert into public.rider_profile_change_requests (driver_id, field, new_value) values ('${D2}','payout_account','{"stagedId":"${st}"}') returning id`)).id;
ok("a payout account is never applied without an admin, verified or not", raises(await decide(reqPay, null, "approve", null), "approval_required"));
await decide(reqPay, A, "reject", "Test cleanup");
const reqU = (await one(`insert into public.rider_profile_change_requests (driver_id, field, new_value) values ('${D2}','vehicle','{"type":"scooter","owner":"deligro"}') returning id`)).id;
ok("a never-verified rider's vehicle change is applied directly by the server", (await decide(reqU, null, "approve", "Saved directly")).ok);
r = await add(D3, "driving_licence", "  ", null, `${D3}/driving_licence/c.pdf`, "2030-12-31");
ok("a blank number is stored as null", r.ok && (await one(`select number from public.rider_documents where id = '${r.rows[0].id}'`)).number === null);

// ── the verified-name guard ──
console.log("\n── guard_rider_verified_name ──");
await db.exec(`update public.rider_profiles set verification_status = 'unverified' where driver_id = '${D2}'`);
r = await as("authenticated", D2, `update public.profiles set full_name = 'Second Rider Renamed' where id = '${D2}'`);
ok("an UNverified rider renames themselves directly", r.ok && (await one(`select full_name from public.profiles where id = '${D2}'`)).full_name === "Second Rider Renamed");
await db.exec(`update public.rider_profiles set verification_status = 'verified', verified_at = now() where driver_id = '${D2}'`);
r = await as("authenticated", D2, `update public.profiles set full_name = 'Someone Else' where id = '${D2}'`);
ok("a VERIFIED rider renaming themselves is needs_approval", raises(r, "needs_approval"));
await db.exec(`update public.rider_profiles set verification_status = 'pending' where driver_id = '${D2}'`);
r = await as("authenticated", D2, `update public.profiles set full_name = 'After An Upload' where id = '${D2}'`);
ok("...still refused once their status reads 'pending' after an upload (ever verified)", raises(r, "needs_approval"));
await db.exec(`update public.rider_profiles set verification_status = 'verified' where driver_id = '${D2}'`);
ok("...and the name is unchanged", (await one(`select full_name from public.profiles where id = '${D2}'`)).full_name === "Second Rider Renamed");
ok("...their other fields still save (phone keeps its own flow)",
  (await as("authenticated", D2, `update public.profiles set phone = '+919000000002' where id = '${D2}'`)).ok);
ok("an admin can rename a verified rider", (await as("authenticated", A, `update public.profiles set full_name = 'Fixed By Admin' where id = '${D2}'`)).ok);
ok("the service role can", (await as("service_role", null, `update public.profiles set full_name = 'Fixed By Server' where id = '${D2}'`)).ok);
ok("a customer renames themselves as before", (await as("authenticated", C, `update public.profiles set full_name = 'Customer Two' where id = '${C}'`)).ok);

// ── platform setting and bucket ──
console.log("\n── platform_settings and the bucket ──");
ok("block_dispatch_on_expired_docs defaults to false", (await one(`select block_dispatch_on_expired_docs from public.platform_settings`)).block_dispatch_on_expired_docs === false);
ok("...is not nullable", !(await run(`update public.platform_settings set block_dispatch_on_expired_docs = null`)).ok);
ok("anon and riders can read it (the settings facade reads with the caller's client)",
  (await as("anon", null, `select block_dispatch_on_expired_docs from public.platform_settings`)).ok &&
  (await as("authenticated", D1, `select block_dispatch_on_expired_docs from public.platform_settings`)).ok);
ok("vendor_commission_pct stays private", denied(await as("anon", null, `select vendor_commission_pct from public.platform_settings`)));
const b = await one(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'rider-documents'`);
ok("bucket rider-documents is private, 10 MB, PDF/JPEG/PNG only",
  b && b.public === false && Number(b.file_size_limit) === 10485760 &&
  JSON.stringify([...b.allowed_mime_types].sort()) === JSON.stringify(["application/pdf", "image/jpeg", "image/png"]));

// ── SECURITY_AUDIT §1 verification queries ──
console.log("\n── docs/SECURITY_AUDIT.md §1 queries ──");
const NEW = ["rider_documents", "rider_payout_accounts", "rider_payout_accounts_staged", "rider_profile_change_requests"];
r = await run(`select c.relname, c.relrowsecurity as rls_on, count(p.polname)::int as policies
  from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_policy p on p.polrelid = c.oid
  where n.nspname = 'public' and c.relkind = 'r' and c.relname in (${NEW.map((t) => `'${t}'`).join(",")}) group by 1, 2`);
ok("every new table has RLS on", r.rows.length === 4 && r.rows.every((x) => x.rls_on));
ok("...the two readable ones have a policy; the payout pair deliberately none",
  r.rows.every((x) => (x.relname.startsWith("rider_payout") ? x.policies === 0 : x.policies === 1)));
r = await run(`select table_name, column_name, grantee from information_schema.column_privileges
  where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type = 'SELECT'
    and (column_name ~* 'bank|ifsc|pan_|gst|upi|password|secret|token|api_key|account_number|holder_name|licence_number'
         or column_name ~* 'owner_email|owner_mobile' or (table_name = 'rider_documents' and column_name = 'number')
         or (table_name = 'rider_profile_change_requests' and column_name = 'new_value'))`);
ok("no sensitive column is SELECTable by anon/authenticated", r.ok && r.rows.length === 0);
r = await run(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
    and p.proname in ('rider_add_document','rider_decide_change_request','mask_rider_aadhaar','guard_rider_verified_name')`);
ok("no 0086 function is executable by anon or authenticated", r.ok && r.rows.length === 0);
r = await run(`select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('rider_add_document','rider_decide_change_request','mask_rider_aadhaar','guard_rider_verified_name')`);
ok("every 0086 function pins search_path", r.rows.length === 4 && r.rows.every((x) => (x.proconfig ?? []).some((c) => c.startsWith("search_path="))));

// ── idempotent ──
console.log("\n── re-running 0086 ──");
const before = await count(`select 1 from public.rider_documents`);
let rerun = true; try { await db.exec(M0086); } catch (e) { rerun = false; console.log(e.message); }
ok("0086 re-runs cleanly", rerun);
ok("...keeping every document and the payout account",
  (await count(`select 1 from public.rider_documents`)) === before && (await count(`select 1 from public.rider_payout_accounts`)) === 1);
ok("...and the setting keeps its value", (await run(`update public.platform_settings set block_dispatch_on_expired_docs = true`)).ok &&
  (await db.exec(M0086), (await one(`select block_dispatch_on_expired_docs from public.platform_settings`)).block_dispatch_on_expired_docs === true));

// ── convergence with the Manager branch's 0150 ──
console.log("\n── convergence with 0150_rider_tables_converge.sql ──");
async function snapshot(on) {
  const q = async (sql) => JSON.stringify((await on.query(sql)).rows);
  const T = `('rider_profiles','rider_documents','rider_payout_accounts','rider_payout_accounts_staged','rider_profile_change_requests')`;
  return {
    columns: await q(`select table_name, column_name, data_type, column_default, is_nullable from information_schema.columns
                      where table_schema = 'public' and table_name in ${T} order by 1, 2`),
    constraints: await q(`select c.relname as t, k.conname, pg_get_constraintdef(k.oid) as def
                          from pg_constraint k join pg_class c on c.oid = k.conrelid
                          where c.relnamespace = 'public'::regnamespace and c.relname in ${T} order by 1, 2`),
    indexes: await q(`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ${T} order by 1, 2`),
    policies: await q(`select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname = 'public' and tablename in ${T} order by 1, 2`),
    rls: await q(`select relname, relrowsecurity from pg_class where relname in ${T} and relkind = 'r' order by 1`),
    tableGrants: await q(`select table_name, grantee, privilege_type from information_schema.role_table_grants
                          where table_schema = 'public' and table_name in ${T} and grantee in ('anon','authenticated','service_role') order by 1, 2, 3`),
    columnGrants: await q(`select table_name, column_name, grantee, privilege_type from information_schema.column_privileges
                           where table_schema = 'public' and table_name in ${T} and grantee in ('anon','authenticated') order by 1, 2, 3, 4`),
    triggers: await q(`select tgrelid::regclass::text as t, tgname from pg_trigger where not tgisinternal
                       and tgname in ('mask_rider_aadhaar','guard_rider_verified_name') order by 1, 2`),
    bucket: await q(`select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'rider-documents'`),
    setting: await q(`select column_name, data_type, column_default, is_nullable from information_schema.columns
                      where table_name = 'platform_settings' and column_name = 'block_dispatch_on_expired_docs'`),
  };
}
const m0150 = find0150();
if (!m0150) {
  skip("0150 not found (not merged, no MANAGER_0150, no sibling worktree) — convergence not checked");
} else {
  console.log(`  (0150 read from ${m0150.from})`);
  let alone, first150, after150, only150;
  let built = true;
  try {
    alone = await fresh([M0086]);
    first150 = await fresh([m0150.sql, M0086]);
    after150 = await fresh([M0086, m0150.sql]);
    only150 = await fresh([m0150.sql]);
  } catch (e) { built = false; console.log(`  could not build: ${e.message}`); }
  ok("0150 then 0086, and 0086 then 0150, both apply", built);
  if (built) {
    const s = await snapshot(alone), s1 = await snapshot(first150), s2 = await snapshot(after150), s0 = await snapshot(only150);
    ok("the snapshot is not vacuous (columns, grants, policies, triggers, bucket all present)",
      JSON.parse(s.columns).length >= 60 && JSON.parse(s.columnGrants).length >= 40 && JSON.parse(s.policies).length === 3 &&
      JSON.parse(s.triggers).length === 2 && JSON.parse(s.bucket).length === 1 && JSON.parse(s.constraints).length >= 20);
    for (const k of Object.keys(s)) {
      ok(`0150 → 0086 holds the same ${k} as 0086 alone`, s[k] === s1[k]);
      ok(`0086 → 0150 holds the same ${k} as 0086 alone`, s[k] === s2[k]);
    }
    // Where 0150's own shape matches 0086's sections 1–4 and 9 (everything but 0086's additions).
    // verification_note (and its check) is 0086's own addition, not in 0150.
    const no086 = (x) => JSON.stringify(JSON.parse(x).filter((c) => c.column_name !== "verification_note" && !/verification_note/.test(c.def ?? "") && !/verification_note/.test(c.conname ?? "")));
    for (const k of ["columns", "indexes", "policies", "rls", "bucket"]) {
      ok(`0150 alone builds the same ${k} as 0086 (identical shape; 0086's verification_note aside)`, no086(s[k]) === no086(s0[k]));
    }
    ok("0150 alone builds the same constraints as 0086 (verification_note's check aside)", no086(s.constraints) === no086(s0.constraints));
    const g = (x) => JSON.parse(x).filter((c) => c.table_name !== "rider_profiles");
    ok("0150 alone grants the same columns on the four new tables", JSON.stringify(g(s.columnGrants)) === JSON.stringify(g(s0.columnGrants)));
    ok("0150 alone grants the same table privileges on the four new tables", JSON.stringify(g(s.tableGrants)) === JSON.stringify(g(s0.tableGrants)));
    // And the behaviour 0086 adds holds when 0150 landed first.
    await first150.exec(`insert into public.rider_documents (driver_id, doc_type, number, file_path) values ('${D1}','aadhaar','123412341234','${D1}/aadhaar/z.pdf')`);
    const z = (await first150.query(`select number, number_masked from public.rider_documents where driver_id = '${D1}' and doc_type = 'aadhaar'`)).rows[0];
    ok("with 0150 first, an Aadhaar written the 0151 way (ops_add_rider_document passes the number) is still masked",
      z.number === null && z.number_masked === "XXXX-XXXX-1234");
    r = await as("authenticated", D1, `select licence_number from public.rider_profiles`, first150);
    ok("with 0150 first, licence_number is still not readable by a signed-in client", denied(r));
  }
}

// ── rollback ──
console.log("\n── the rollback block (fresh instance) ──");
const lines = M0086.split("\n");
const from = lines.findIndex((l) => l.startsWith("-- Rollback"));
const block = [];
for (const l of lines.slice(from + 1)) {
  if (l.startsWith("-- ====") || l.startsWith("-- (")) break;
  if (/^--   /.test(l) && !/^--\s+--/.test(l)) block.push(l.slice(2));
}
const ROLLBACK = block.join("\n");
ok("the rollback block was found", from > 0 && /drop table/.test(ROLLBACK));
const rb = await fresh([M0086]);
await rb.exec(`select public.rider_add_document('${D1}','photo',null,null,'${D1}/photo/a.jpg',null)`);
let rolled = true; try { await rb.exec(ROLLBACK); } catch (err) { rolled = false; console.log(`rollback failed: ${err.message}`); }
ok("the rollback block runs to completion", rolled);
ok("...and removes every 0086 table, function, trigger and column",
  (await rb.query(`select to_regclass('public.rider_documents') is null and to_regclass('public.rider_payout_accounts') is null
     and to_regclass('public.rider_payout_accounts_staged') is null and to_regclass('public.rider_profile_change_requests') is null
     and not exists (select 1 from pg_proc where proname in ('rider_add_document','rider_decide_change_request','mask_rider_aadhaar','guard_rider_verified_name'))
     and not exists (select 1 from information_schema.columns where table_name = 'rider_profiles' and column_name in ('licence_number','verification_status','address_line'))
     and not exists (select 1 from information_schema.columns where table_name = 'platform_settings' and column_name = 'block_dispatch_on_expired_docs')
     and not exists (select 1 from storage.buckets where id = 'rider-documents') as gone`)).rows[0].gone === true);
ok("...rider_profiles is readable again as 0081 left it", (await as("authenticated", D1, `select * from public.rider_profiles`, rb)).ok);
ok("...a rider can rename themselves again (no dangling trigger)", (await as("authenticated", D1, `update public.profiles set full_name = 'Back' where id = '${D1}'`, rb)).ok);
let reapplied = true; try { await rb.exec(M0086); } catch (err) { reapplied = false; console.log(err.message); }
ok("...and 0086 applies again after the rollback", reapplied);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
