// Runs migration 0145 (manager vendors) in an in-process Postgres (PGlite) on
// top of manager-base.mjs + 0142 + 0064 §3 + 0143.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0145.mjs
// Proves status transitions, provenance locks, document review, onboarding,
// zone scoping and the ticket thread RPCs; it does not replace staging.
import { managerBase, readMigration, id, IDS } from "./manager-base.mjs";

const MIGRATION = readMigration("0145_manager_vendors.sql");
const { db, ZA, ZB } = await managerBase();
const { A, M, MB, C, V, R1, R2 } = IDS;

// The restaurant columns 0017–0056 add (abridged), the 0017 status ↔ approved
// sync, and the tables 0145 extends.
await db.exec(`
  create type public.vendor_status as enum ('pending', 'active', 'inactive', 'suspended');
  alter table public.restaurants
    add column if not exists slug text unique, add column if not exists approved boolean not null default false,
    add column if not exists status public.vendor_status not null default 'pending',
    add column if not exists lat double precision, add column if not exists lng double precision,
    add column if not exists created_at timestamptz not null default now(),
    add column if not exists description text, add column if not exists category text, add column if not exists image_url text,
    add column if not exists is_open boolean not null default true,
    add column if not exists owner_name text, add column if not exists owner_mobile text, add column if not exists owner_alt_mobile text,
    add column if not exists owner_email text, add column if not exists owner_phone_verified boolean not null default false,
    add column if not exists password_reset_at timestamptz, add column if not exists commission_pct numeric(5,2),
    add column if not exists min_order integer not null default 0, add column if not exists delivery_available boolean not null default true,
    add column if not exists self_pickup boolean not null default false, add column if not exists opening_time time,
    add column if not exists closing_time time, add column if not exists weekly_off text[] not null default '{}',
    add column if not exists address text, add column if not exists landmark text, add column if not exists pincode text,
    add column if not exists upi_id text, add column if not exists bank_account_name text, add column if not exists bank_name text,
    add column if not exists bank_account_number text, add column if not exists bank_ifsc text,
    add column if not exists fssai_number text, add column if not exists gst_number text, add column if not exists pan_number text,
    add column if not exists tc_accepted_at timestamptz, add column if not exists tc_accepted_by uuid, add column if not exists tc_version text,
    add column if not exists accept_cod boolean default true, add column if not exists accept_online boolean default true,
    add column if not exists cod_max_order integer, add column if not exists other_charges_per_order integer default 0,
    add column if not exists settlement_cycle text, add column if not exists rating numeric, add column if not exists rating_count integer default 0,
    add column if not exists rating_sum integer default 0, add column if not exists promoted boolean default false,
    add column if not exists sort_position integer;
  alter table public.restaurants alter column id set default gen_random_uuid();
  update public.restaurants set slug = 'spice-hub', status = 'active', approved = true, lat = 21.7, lng = 81.5 where id = '${R1}';
  update public.restaurants set slug = 'saja-dhaba', status = 'pending' where id = '${R2}';
  create function public.sync_restaurant_status() returns trigger language plpgsql as $$
  begin new.approved := (new.status = 'active'); return new; end; $$;
  create trigger sync_restaurant_status before insert or update on public.restaurants
    for each row execute function public.sync_restaurant_status();
  alter table public.restaurants enable row level security;
  create policy "restaurants — owner manage" on public.restaurants for all
    using (owner_id = auth.uid() or public.is_admin()) with check (owner_id = auth.uid() or public.is_admin());

  create table public.vendor_documents (id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references public.restaurants on delete cascade,
    doc_type text not null check (doc_type in ('fssai','gst','pan','bank_proof','shop_license','other')),
    storage_path text not null, file_name text not null, uploaded_by uuid, created_at timestamptz not null default now());
  alter table public.vendor_documents enable row level security;
  create policy "vendor_documents — read" on public.vendor_documents for select using (public.owns_restaurant(restaurant_id) or public.is_admin());

  create table public.reviews (id uuid primary key default gen_random_uuid(), order_id uuid, user_id uuid,
    restaurant_id uuid not null references public.restaurants, rating int not null, comment text, created_at timestamptz default now());
  alter table public.reviews enable row level security;
  create table public.review_replies (id uuid primary key default gen_random_uuid(), review_id uuid not null unique references public.reviews,
    author_id uuid not null, reply_text text not null, created_at timestamptz default now());
  alter table public.review_replies enable row level security;
  create table public.store_holidays (id uuid primary key default gen_random_uuid(), restaurant_id uuid not null references public.restaurants,
    starts_on date not null, ends_on date not null, note text);
  alter table public.store_holidays enable row level security;
  create table public.menu_items (id uuid primary key default gen_random_uuid(), restaurant_id uuid not null references public.restaurants,
    name text not null, description text, price integer not null, veg boolean default true, available boolean default true, category text);

  grant all on all tables in schema public to anon, authenticated, service_role;
`);
await db.exec(readMigration("0142_manager_orders_live.sql"));
{
  const m0064 = readMigration("0064_growth_support.sql").replace(/\r\n/g, "\n");
  const start = m0064.indexOf("-- 3. Support tickets");
  const end = m0064.indexOf("-- 4. Notification inbox");
  if (start < 0 || end < 0) throw new Error("0064 section markers not found");
  await db.exec(m0064.slice(start, end));
}
await db.exec(readMigration("0143_support_tickets_ops.sql"));
await db.exec(MIGRATION);
await db.exec(`grant select on all tables in schema public to authenticated;`);

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
const status = async (rid) => (await one(`select status::text as s, approved from public.restaurants where id = '${rid}'`));
const audits = async (action) => (await one(`select count(*)::int as n from public.ops_audit_log where action = '${action}'`)).n;

console.log("\n── vendor status ──");
let r = await srv(`select public.ops_set_vendor_status('${M}','${R1}','suspend','active','Hygiene complaint',false,'c1') as s`);
ok("a zone manager suspends an active shop", r.ok && r.rows[0].s.status === "suspended", r.msg);
let s = await status(R1);
ok("...the shop is suspended and off the storefront", s.s === "suspended" && s.approved === false);
let row = await one(`select status_reason, status_changed_by from public.restaurants where id = '${R1}'`);
ok("...with the reason and who decided", row.status_reason === "Hygiene complaint" && row.status_changed_by === M);
ok("...and one audit row", (await audits("vendor.suspend")) === 1);
r = await srv(`select public.ops_set_vendor_status('${M}','${R1}','suspend','active','Hygiene complaint',false,'c1') as s`);
ok("replaying the same action changes nothing", r.ok && r.rows[0].s.status === "suspended" && (await audits("vendor.suspend")) === 1);
ok("reactivate with a stale expected status → stale",
  fails(await srv(`select public.ops_set_vendor_status('${M}','${R1}','reactivate','active','Back to normal',false,'c2')`), /^stale$/));
ok("an empty reason → reason_required",
  fails(await srv(`select public.ops_set_vendor_status('${M}','${R1}','reactivate','suspended','',false,'c3')`), /reason_required/));
ok("reject on a suspended shop → invalid_transition",
  fails(await srv(`select public.ops_set_vendor_status('${M}','${R1}','reject','suspended','Not allowed now',false,'c4')`), /invalid_transition/));
r = await srv(`select public.ops_set_vendor_status('${M}','${R1}','reactivate','suspended','Inspection passed',false,'c5') as s`);
ok("reactivate a pinned shop → active", r.ok && r.rows[0].s.status === "active", r.msg);

// A pending shop in zone A for the approval path.
const R3 = id(103);
await db.exec(`insert into public.restaurants (id, owner_id, name, slug, zone_id, status) values ('${R3}','${V}','New Thali','new-thali','${ZA}','pending')`);
ok("approve without a map pin → needs_map_pin",
  fails(await srv(`select public.ops_set_vendor_status('${M}','${R3}','approve','pending','Looks good',false,'c6')`), /needs_map_pin/));
await db.exec(`update public.restaurants set lat = 21.71, lng = 81.52 where id = '${R3}'`);
r = await srv(`select public.ops_set_vendor_status('${M}','${R3}','approve','pending','Looks good',false,'c7')`);
ok("approve with documents unverified → documents_unverified naming both", fails(r, /documents_unverified/) && r.detail === "fssai,bank_proof", r.detail);
r = await srv(`select public.ops_set_vendor_status('${M}','${R3}','approve','pending','Owner showed originals',true,'c8') as s`);
ok("...with override → active", r.ok && r.rows[0].s.status === "active", r.msg);
row = await one(`select after from public.ops_audit_log where client_action_id = 'c8'`);
ok("...and the audit row records the override", row.after.documents_override === true && row.after.missing === "fssai,bank_proof");

const R4 = id(104);
await db.exec(`insert into public.restaurants (id, owner_id, name, slug, zone_id, status, lat, lng) values ('${R4}','${V}','Chai Point','chai-point','${ZA}','pending',21.7,81.5);
  insert into public.vendor_documents (id, restaurant_id, doc_type, storage_path, file_name) values
    ('${id(501)}','${R4}','fssai','x/f.pdf','f.pdf'), ('${id(502)}','${R4}','bank_proof','x/b.pdf','b.pdf');`);
ok("rejecting a document without remarks → reason_required",
  fails(await srv(`select public.ops_review_vendor_document('${M}','${id(501)}','rejected','',  'd0')`), /reason_required/));
r = await srv(`select public.ops_review_vendor_document('${M}','${id(501)}','verified',null,'d1') as d`);
ok("a manager verifies the FSSAI licence", r.ok, r.msg);
r = await srv(`select public.ops_review_vendor_document('${M}','${id(502)}','verified',null,'d2') as d`);
row = await one(`select status, reviewed_by from public.vendor_documents where id = '${id(502)}'`);
ok("...and the bank proof, recording who", r.ok && row.status === "verified" && row.reviewed_by === M);
ok("...each document decision audited", (await audits("vendor.document.verified")) === 2);
r = await srv(`select public.ops_set_vendor_status('${M}','${R4}','approve','pending','Documents verified',false,'c9') as s`);
ok("with both verified, approve needs no override", r.ok && r.rows[0].s.status === "active", r.msg);
row = await one(`select after from public.ops_audit_log where client_action_id = 'c9'`);
ok("...and the audit row records no override", row.after.documents_override === undefined);

const R5 = id(105);
await db.exec(`insert into public.restaurants (id, owner_id, name, slug, zone_id, status, lat, lng) values ('${R5}','${V}','Dosa Corner','dosa-corner','${ZA}','pending',21.7,81.5)`);
r = await srv(`select public.ops_set_vendor_status('${M}','${R5}','reject','pending','Outside service area',false,'c10') as s`);
ok("reject a pending shop → rejected", r.ok && r.rows[0].s.status === "rejected", r.msg);
r = await srv(`select public.ops_set_vendor_status('${M}','${R5}','approve','rejected','Moved inside the area',true,'c11') as s`);
ok("approve from rejected is allowed", r.ok && r.rows[0].s.status === "active", r.msg);

console.log("\n── zone and role ──");
ok("a zone-A manager cannot decide a zone-B shop",
  fails(await srv(`select public.ops_set_vendor_status('${M}','${R2}','approve','pending','Mine now',true,'c12')`), /forbidden/));
ok("the zone-B manager can", (await srv(`select public.ops_set_vendor_status('${MB}','${R2}','reject','pending','No licence',false,'c13')`)).ok);
for (const [name, sql] of [
  ["ops_set_vendor_status", `select public.ops_set_vendor_status('${M}','${R1}','suspend','active','x y z',false,'c14')`],
  ["ops_review_vendor_document", `select public.ops_review_vendor_document('${M}','${id(501)}','verified',null,'c15')`],
  ["ops_onboard_vendor", `select public.ops_onboard_vendor('${M}','${V}','${ZA}','{}'::jsonb,'[]'::jsonb,'c16')`],
  ["ops_add_ticket_message", `select public.ops_add_ticket_message('${M}','${id(9)}','hi',false,'c17')`],
]) {
  ok(`a signed-in user cannot call ${name}`, fails(await as("authenticated", M, sql), /permission denied/));
}

console.log("\n── vendor cannot write provenance or zone ──");
ok("the owner cannot set status_reason",
  fails(await as("authenticated", V, `update public.restaurants set status_reason = 'all good' where id = '${R1}'`), /admin-only/));
ok("the owner cannot move their shop's zone",
  fails(await as("authenticated", V, `update public.restaurants set zone_id = '${ZB}' where id = '${R1}'`), /admin-only/));
ok("the owner can still edit their description",
  (await as("authenticated", V, `update public.restaurants set description = 'Best dosa' where id = '${R1}'`)).ok);

console.log("\n── onboarding ──");
const OWNER = id(77);
await db.exec(`insert into public.profiles (id, role, full_name) values ('${OWNER}','restaurant','Ravi Owner')`);
ok("a zone-A manager cannot onboard into zone B",
  fails(await srv(`select public.ops_onboard_vendor('${M}','${OWNER}','${ZB}','{"slug":"x-b","name":"X"}'::jsonb,'[]'::jsonb,'o0')`), /forbidden/));
r = await srv(`select public.ops_onboard_vendor('${M}','${OWNER}','${ZA}',
  '{"slug":"ravi-rolls","name":"Ravi Rolls","commission_pct":1,"bank_account_number":"123","owner_mobile":"+919800000000","lat":21.7,"lng":81.5,"weekly_off":["monday"]}'::jsonb,
  '[{"name":"Egg Roll","price":60,"category":"Rolls"},{"name":"  "}]'::jsonb,'o1') as v`);
ok("a manager onboards a shop into their zone", r.ok && r.rows[0].v.slug === "ravi-rolls", r.msg);
const NEW = r.rows?.[0]?.v.restaurant_id;
row = await one(`select status::text as s, zone_id, commission_pct, bank_account_number, weekly_off, tc_accepted_by from public.restaurants where id = '${NEW}'`);
ok("...pending, in that zone, at platform commission, with no bank details",
  row.s === "pending" && row.zone_id === ZA && row.commission_pct === null && row.bank_account_number === null);
ok("...weekly off and terms acceptance recorded", JSON.stringify(row.weekly_off) === '["monday"]' && row.tc_accepted_by === M);
ok("...seed menu inserted, blank rows skipped", (await one(`select count(*)::int as n from public.menu_items where restaurant_id = '${NEW}'`)).n === 1);
ok("...one audit row", (await audits("vendor.onboard")) === 1);
r = await srv(`select public.ops_onboard_vendor('${M}','${OWNER}','${ZA}','{"slug":"ravi-rolls-2","name":"Ravi Rolls"}'::jsonb,'[]'::jsonb,'o1') as v`);
ok("replaying onboarding returns the same shop", r.ok && r.rows[0].v.restaurant_id === NEW && r.rows[0].v.slug === "ravi-rolls");
r = await srv(`select public.ops_onboard_vendor('${A}','${OWNER}',null,'{"slug":"admin-shop","name":"Admin Shop","commission_pct":8}'::jsonb,'[]'::jsonb,'o2') as v`);
row = await one(`select zone_id, commission_pct from public.restaurants where id = '${r.rows?.[0]?.v.restaurant_id}'`);
ok("an admin may set commission; no zone given → default zone", r.ok && Number(row.commission_pct) === 8 && row.zone_id === ZA);
r = await srv(`select public.ops_add_vendor_document('${M}','${NEW}','fssai','restaurants/x/f.pdf','fssai.pdf','u1') as d`);
ok("a manager records an uploaded document", r.ok && !!r.rows[0].d.document_id, r.msg);
r = await srv(`select public.ops_add_vendor_document('${M}','${NEW}','fssai','restaurants/x/f.pdf','fssai.pdf','u1') as d`);
ok("...replay returns the same document", r.ok && (await one(`select count(*)::int as n from public.vendor_documents where restaurant_id = '${NEW}'`)).n === 1);

console.log("\n── manager reads ──");
await db.exec(`insert into public.reviews (restaurant_id, rating) values ('${R1}', 5), ('${R2}', 2);
  insert into public.store_holidays (restaurant_id, starts_on, ends_on) values ('${R1}', '2026-11-01', '2026-11-02'), ('${R2}', '2026-11-01', '2026-11-02');`);
r = await as("authenticated", M, `select id from public.restaurants`);
ok("a zone-A manager reads zone-A shops only", r.ok && r.rows.length > 0 && !r.rows.some((x) => x.id === R2), r.msg);
r = await as("authenticated", M, `select restaurant_id from public.vendor_documents`);
ok("...their documents", r.ok && r.rows.length >= 2 && r.rows.every((x) => x.restaurant_id !== R2));
r = await as("authenticated", M, `select restaurant_id from public.reviews`);
ok("...their reviews", r.ok && r.rows.length === 1 && r.rows[0].restaurant_id === R1);
r = await as("authenticated", M, `select restaurant_id from public.store_holidays`);
ok("...their holidays", r.ok && r.rows.length === 1 && r.rows[0].restaurant_id === R1);
r = await as("authenticated", MB, `select id from public.restaurants`);
ok("the zone-B manager reads only zone B", r.ok && r.rows.length === 1 && r.rows[0].id === R2);

console.log("\n── tickets ──");
const O1 = id(2001);
await db.exec(`insert into public.orders (id, customer_id, restaurant_id, total) values ('${O1}','${C}','${R1}', 300)`);
const T1 = id(3001), T2 = id(3002), T3 = id(3003);
await db.exec(`insert into public.support_tickets (id, requester_id, requester_role, category, subject, order_id)
                 values ('${T1}','${C}','customer','order_issue','Cold food','${O1}');
               insert into public.support_tickets (id, requester_id, requester_role, category, subject, restaurant_id, zone_id)
                 values ('${T2}','${V}','restaurant','payments','Settlement late','${R2}','${ZB}');`);
row = await one(`select restaurant_id, zone_id from public.support_tickets where id = '${T1}'`);
ok("a ticket with an order is linked to the order's shop", row.restaurant_id === R1 && row.zone_id === ZA);
row = await one(`select restaurant_id, zone_id from public.support_tickets where id = '${T2}'`);
ok("a vendor's ticket without an order → their oldest shop, whatever they sent", row.restaurant_id === R1 && row.zone_id === ZA, JSON.stringify(row));
ok("an empty reply is refused",
  fails(await srv(`select public.ops_add_ticket_message('${M}','${T1}','   ',false,'t0')`), /reason_required/));
r = await srv(`select public.ops_add_ticket_message('${M}','${T1}','Checking with the kitchen',true,'t1')`);
row = await one(`select status, first_response_at from public.support_tickets where id = '${T1}'`);
ok("an internal note does not count as a first response", r.ok && row.status === "open" && row.first_response_at === null, r.msg);
r = await srv(`select public.ops_add_ticket_message('${M}','${T1}','Sorry, a refund is on the way',false,'t2')`);
row = await one(`select status, first_response_at from public.support_tickets where id = '${T1}'`);
ok("the first public reply sets first response and in_progress", r.ok && row.status === "in_progress" && row.first_response_at !== null);
ok("...each message audited", (await audits("ticket.message")) === 2);
ok("another zone's manager cannot reply",
  fails(await srv(`select public.ops_add_ticket_message('${MB}','${T1}','Not mine',false,'t3')`), /forbidden/));
ok("resolve without a resolution → reason_required",
  fails(await srv(`select public.ops_set_ticket_status('${M}','${T1}','resolved','','t4')`), /reason_required/));
r = await srv(`select public.ops_set_ticket_status('${M}','${T1}','resolved','Refunded ₹120','t5')`);
row = await one(`select status, resolution, resolved_at from public.support_tickets where id = '${T1}'`);
ok("resolve with a resolution records it", r.ok && row.status === "resolved" && row.resolution === "Refunded ₹120" && row.resolved_at !== null);
await srv(`select public.ops_set_ticket_status('${M}','${T1}','closed','Customer confirmed','t6')`);
ok("closed is final",
  fails(await srv(`select public.ops_set_ticket_status('${M}','${T1}','in_progress',null,'t7')`), /invalid_transition/));
ok("no reply on a closed ticket",
  fails(await srv(`select public.ops_add_ticket_message('${M}','${T1}','One more thing',false,'t8')`), /invalid_transition/));
await db.exec(`insert into public.support_tickets (id, requester_id, requester_role, category, subject) values ('${T3}','${C}','customer','other','Hello')`);
row = await one(`select restaurant_id from public.support_tickets where id = '${T3}'`);
ok("a customer's ticket without an order has no shop", row.restaurant_id === null);

console.log("\n── idempotent ──");
let again = true; try { await db.exec(MIGRATION); } catch (e) { again = false; console.log(e.message); }
ok("migration can be applied twice", again);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
