// Runs migration 0162 (customers for managers) in PGlite on top of growth-base.mjs.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0162.mjs
import { growthBase, harness, readMigration, id, IDS } from "./growth-base.mjs";

const { db, ZA, ZB } = await growthBase();
const { A, M, MB, V, C, D1, D5, R1, R2 } = IDS;
const CB = id(31), CNEW = id(32), C3 = id(33);

await db.exec(`
  create table if not exists auth.users (id uuid primary key, email text);
  insert into auth.users (id, email) values ('${C}','asha@example.com');
  update public.profiles set phone = '+919876543210' where id = '${C}';
  insert into public.profiles (id, role, full_name, phone) values ('${CB}','customer','Bela','+919800000001'),
    ('${CNEW}','customer','First Caller','+919800000002'), ('${C3}','customer','Chetan','+919800000003');
  create trigger lock_role before update on public.profiles for each row execute function public.lock_role();
  -- profiles as the live database has it before 0162: 0001's own-row policies and 0023's blanket manager read.
  alter table public.profiles enable row level security;
  create policy "own profile — read" on public.profiles for select using (auth.uid() = id);
  create policy "own profile — update" on public.profiles for update using (auth.uid() = id);
  create policy "profiles — manager read" on public.profiles for select using (public.is_manager());
  -- Asha: two orders in zone A (one 40 days ago). Bela: zone B only. Chetan: one zone-A order.
  insert into public.orders (customer_id, restaurant_id, status, total, created_at, payment_status) values
    ('${C}','${R1}','delivered',300, now() - interval '40 days','paid'), ('${C}','${R1}','delivered',200, now() - interval '1 day','paid'),
    ('${CB}','${R2}','delivered',150, now() - interval '2 days','paid'), ('${C3}','${R1}','cancelled',500, now() - interval '3 days','paid');
`);
await db.exec(readMigration("0162_manager_customers.sql"));
const { ok, as, fails, srv, one, done } = harness(db);

console.log("\n── who a manager sees ──");
const sees = async (uid, who) => (await as("authenticated", uid, `select id from public.profiles where id = '${who}'`)).rows.length === 1;
ok("the zone-A manager sees a customer with a zone-A order", await sees(M, C));
ok("...not one who only ordered in zone B", !(await sees(M, CB)));
ok("...not a customer who never ordered", !(await sees(M, CNEW)));
ok("...still their own profile and a zone-A rider", (await sees(M, M)) && (await sees(M, D1)));
ok("...not a zone-B rider", !(await sees(M, D5)));
ok("...the shop owner of an in-scope shop", await sees(M, V));
ok("the zone-B manager sees Bela", await sees(MB, CB));

console.log("\n── phone desk lookup ──");
let r = await as("authenticated", M, `select public.ops_lookup_caller('+919800000002') as c`);
ok("a manager looks up a never-ordered caller: name only", r.ok && r.rows[0].c.name === "First Caller" && r.rows[0].c.is_staff === false
  && !("id" in r.rows[0].c) && !("phone" in r.rows[0].c), r.msg);
ok("a customer cannot use the lookup", fails(await as("authenticated", C, `select public.ops_lookup_caller('+919800000002')`), /forbidden/));
ok("an unknown number → null", (await as("authenticated", M, `select public.ops_lookup_caller('+919899999999') as c`)).rows[0].c === null);

console.log("\n── contact reveal and phone search ──");
ok("reveal without a reason → reason_required", fails(await srv(`select public.ops_reveal_customer_contact('${M}','${C}',null,null,'rv0')`), /reason_required/));
ok("'other' without a note → reason_required", fails(await srv(`select public.ops_reveal_customer_contact('${M}','${C}','other',null,'rv1')`), /reason_required/));
r = await srv(`select public.ops_reveal_customer_contact('${M}','${C}','refund',null,'rv2') as c`);
ok("a reveal with a reason returns phone and email", r.ok && r.rows[0].c.phone === "+919876543210" && r.rows[0].c.email === "asha@example.com", r.msg);
const auditRow = await one(`select count(*)::int as n, max(after::text) as a, max(reason) as reason from public.ops_audit_log where action = 'customer.contact_reveal'`);
ok("...one audit row, with the reason and without the contact", auditRow.n === 1 && !/9876543210|asha@/.test(auditRow.a) && auditRow.reason === "refund");
await srv(`select public.ops_reveal_customer_contact('${M}','${C}','refund',null,'rv2')`);
ok("a replay adds no second row", (await one(`select count(*)::int as n from public.ops_audit_log where action = 'customer.contact_reveal'`)).n === 1);
ok("the zone-B manager cannot reveal a zone-A customer", fails(await srv(`select public.ops_reveal_customer_contact('${MB}','${C}','refund',null,'rv3')`), /forbidden/));
r = await srv(`select public.ops_search_customer_by_phone('${M}','+919876543210','ps1') as ids`);
ok("phone search finds the in-scope customer and logs the last 4 digits", r.ok && r.rows[0].ids[0] === C
  && (await one(`select after ->> 'phone_last4' as l from public.ops_audit_log where action = 'customer.phone_search'`)).l === "3210", r.msg);
r = await srv(`select public.ops_search_customer_by_phone('${M}','+919800000001','ps2') as ids`);
ok("...but not an out-of-scope one", r.ok && r.rows[0].ids.length === 0);

console.log("\n── suspend, restrict, reactivate ──");
ok("suspending a vendor account → not_a_customer", fails(await srv(`select public.ops_set_customer_account('${A}','${V}','suspend','active','Fraud','s0')`), /not_a_customer/));
ok("a suspension without a reason → reason_required", fails(await srv(`select public.ops_set_customer_account('${M}','${C}','suspend','active',null,'s1')`), /reason_required/));
ok("a wrong expected status → stale", fails(await srv(`select public.ops_set_customer_account('${M}','${C}','suspend','restricted','Fraud','s2')`), /stale/));
r = await srv(`select public.ops_set_customer_account('${M}','${C}','suspend','active','Repeated refused COD orders','s3') as s`);
ok("a manager suspends a customer in scope", r.ok && r.rows[0].s.status === "suspended", r.msg);
ok("...audited", (await one(`select count(*)::int as n from public.ops_audit_log where action = 'customer.suspend'`)).n === 1);
ok("an order for them is refused, as the customer", fails(await as("authenticated", C,
  `insert into public.orders (customer_id, restaurant_id) values ('${C}','${R1}')`), /account_restricted/));
ok("...and as the service role (phone desk)", fails(await srv(`insert into public.orders (customer_id, restaurant_id) values ('${C}','${R1}')`), /account_restricted/));
ok("the customer cannot reactivate themselves", fails(await as("authenticated", C,
  `update public.profiles set account_status = 'active' where id = '${C}'`), /account status can only be changed by staff/));
r = await srv(`select public.ops_set_customer_account('${M}','${C}','reactivate','suspended','Agreed on a call','s4') as s`);
ok("reactivate → an order goes through again", r.ok && (await srv(`insert into public.orders (customer_id, restaurant_id) values ('${C}','${R1}')`)).ok, r.msg);
ok("the zone-B manager cannot suspend a zone-A customer", fails(await srv(`select public.ops_set_customer_account('${MB}','${C}','restrict','active','x x x','s5')`), /forbidden/));

console.log("\n── list and retention facts ──");
r = await srv(`select * from public.ops_customer_list(array['${ZA}']::uuid[], null, null, 'recent', null, null, 50)`);
const ids = r.ok ? r.rows.map((x) => x.id) : [];
ok("the zone-A list has Asha and Chetan, not Bela", ids.includes(C) && ids.includes(C3) && !ids.includes(CB), r.msg ?? ids.join());
const asha = r.rows.find((x) => x.id === C);
ok("...Asha: 3 counted orders (the reactivated one is ₹0), ₹500 spent", asha.orders === 3 && asha.spent === 500, JSON.stringify(asha));
ok("...Chetan's cancelled order doesn't count", r.rows.find((x) => x.id === C3).orders === 0);
r = await srv(`select * from public.ops_customer_list(array['${ZA}']::uuid[], 'ash', null, 'recent', null, null, 50)`);
ok("a name fragment narrows the list", r.ok && r.rows.length === 1 && r.rows[0].id === C);
r = await srv(`select * from public.ops_customer_list(array['${ZA}']::uuid[], null, null, 'spend', null, null, 1)`);
const r2 = await srv(`select * from public.ops_customer_list(array['${ZA}']::uuid[], null, null, 'spend', '${r.rows[0].sort_key}', '${r.rows[0].id}', 1)`);
ok("keyset paging returns the next row, not the same one", r2.ok && r2.rows.length === 1 && r2.rows[0].id !== r.rows[0].id);
r = await srv(`select * from public.ops_customer_order_facts(array['${ZA}']::uuid[], now() - interval '7 days', now() + interval '1 minute')`);
const f = r.ok ? r.rows.find((x) => x.customer_id === C) : null;
ok("facts: Asha's first order 40 days ago, second within range", f && f.orders_in_range === 2 && f.first_order_at < new Date(Date.now() - 39 * 864e5), JSON.stringify(f));
ok("clients cannot call the list", fails(await as("authenticated", M, `select * from public.ops_customer_list(null, null, null, null, null, null, 5)`), /permission denied/));

done();
