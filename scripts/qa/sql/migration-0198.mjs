// Proves migration 0198 on the real migration chain (chain-lib.mjs): every money path of
// the customer wallet, with a customer, a rider, a shop and an admin acting as themselves.
//
//   1. adding change: credit, cash recorded as the full amount, the limit, the wrong rider,
//      wrong code, attempt lockout surviving asking again, expired code, retry;
//   2. using points: partial and full, can't overspend, one after the other, retry,
//      cash limit judged on the cash due;
//   3. cancelling: customer, shop and staff, returned once, with a ledger row;
//   4. correcting: admin only, reason required, can't go negative, audited;
//   5. nobody writes it directly, nobody reads a balance sideways;
//   6. the ledger always sums to the balance;
//   7. shop payout and rider cash stay right.
//
// PGlite has ONE connection, so two payments can't truly overlap here. The "simultaneous"
// test sends both at once and they run in turn; the row lock itself is checked by reading
// the function's body. The real race is on the "needs a live system" list.
//
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0198.mjs
import { freshChain, one } from "./chain-lib.mjs";

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

const uuid = (n) => `00000000-0000-4000-8000-0000000198${String(n).padStart(2, "0")}`;
const [ADMIN, CUST, CUST2, RIDER, RIDER2, VEND, MGR, SHOP, DISH] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(uuid);
const IN_TOWN = `'{"label":"Home","line":"1 Main Rd","lat":21.72,"lng":81.54}'::jsonb`;

/** As a signed-in user, through their role and their RLS. */
async function as(role, uid, sql) {
  const claims = role === "authenticated" ? { role: "authenticated", sub: uid } : {};
  await db.exec(`reset role; select set_config('test.uid','${uid ?? ""}',false); select set_config('test.jwt','${JSON.stringify(claims)}',false); set role ${role};`);
  try {
    return { ok: true, rows: (await db.query(sql)).rows };
  } catch (e) {
    return { ok: false, msg: String(e.message) };
  } finally {
    await db.exec(`reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);`);
  }
}
/** As the server: the service role, its grants, its JWT. */
async function svc(sql) {
  await db.exec(`reset role; select set_config('test.uid','',false); select set_config('test.jwt','{"role":"service_role"}',false); set role service_role;`);
  try {
    return { ok: true, rows: (await db.query(sql)).rows };
  } catch (e) {
    return { ok: false, msg: String(e.message) };
  } finally {
    await db.exec(`reset role; select set_config('test.jwt','',false);`);
  }
}
const asOwner = (sql) => db.exec(`select set_config('test.jwt','{"role":"service_role"}',false); ${sql}; select set_config('test.jwt','',false);`);

await asOwner(`
  insert into auth.users (id, email) select id, id || '@x.test' from unnest(array['${ADMIN}','${CUST}','${CUST2}','${RIDER}','${RIDER2}','${VEND}','${MGR}']::uuid[]) id;
  insert into public.profiles (id, role, full_name) values
    ('${ADMIN}','admin','Owner'), ('${CUST}','customer','Asha'), ('${CUST2}','customer','Bina'),
    ('${RIDER}','driver','Ravi'), ('${RIDER2}','driver','Raju'), ('${VEND}','restaurant','Shop'), ('${MGR}','manager','Mina')
    on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;
  insert into public.platform_settings (id, delivery_fee, tax_rate, free_delivery_threshold, min_order, accepting_orders, delivery_radius_km, cash_limit_per_order)
    values (true, 0, 0, 0, 0, true, 8, 0)
    on conflict (id) do update set delivery_fee = 0, tax_rate = 0, free_delivery_threshold = 0, min_order = 0,
      accepting_orders = true, delivery_radius_km = 8, cash_limit_per_order = 0;
  insert into public.restaurants (id, slug, name, owner_id, approved, is_open, lat, lng, accept_cod, cod_max_order)
    values ('${SHOP}', 'wallet-shop', 'Wallet Shop', '${VEND}', true, true, 21.71, 81.53, true, 0);
  insert into public.menu_items (id, restaurant_id, name, price, available)
    values ('${DISH}', '${SHOP}', 'Thali', 50, true);
`);
await db.exec(`
  create or replace function public.restaurant_status_now(p uuid, p_at timestamptz default now()) returns text
    language sql stable as $$ select 'open' $$;
  update public.menu_items set approval_status = 'approved' where id = '${DISH}';
`).catch(() => {});

/** A cash order of qty × ₹50 placed by the customer, exactly as createOrder does it. */
async function placed(customer, qty) {
  const o = await as("authenticated", customer, `insert into public.orders (customer_id, restaurant_id, address, payment_method)
    values ('${customer}', '${SHOP}', ${IN_TOWN}, 'cod') returning id`);
  if (!o.ok) throw new Error(`insert: ${o.msg}`);
  const id = o.rows[0].id;
  const it = await as("authenticated", customer, `insert into public.order_items (order_id, menu_item_id, name, qty, price) values ('${id}', '${DISH}', 'x', ${qty}, 1)`);
  if (!it.ok) throw new Error(`items: ${it.msg}`);
  const t = await as("authenticated", customer, `select public.recompute_order_total('${id}')`);
  if (!t.ok) throw new Error(`recompute: ${t.msg}`);
  return id;
}
/** An order out with `rider`, the rider holding the food. */
async function outForDelivery(customer, qty, rider = RIDER, points = 0) {
  const id = await placed(customer, qty);
  if (points) {
    const r = await spend(customer, id, points);
    if (!r.ok) throw new Error(`spend: ${JSON.stringify(r)}`);
  }
  await asOwner(`
    update public.orders set status = 'kitchen' where id = '${id}';
    update public.orders set status = 'ready' where id = '${id}';
    update public.orders set status = 'on_the_way' where id = '${id}';
    insert into public.deliveries (order_id, driver_id, status, assigned_at)
      values ('${id}', '${rider}', 'assigned', now() - interval '5 minutes');
    update public.deliveries set status = 'picked_up', picked_up_at = now() - interval '1 minute' where order_id = '${id}'
  `);
  return id;
}
const fn = async (sql) => {
  const r = await svc(`select ${sql} as r`);
  if (!r.ok) throw new Error(r.msg);
  return r.rows[0].r;
};
const spend = (customer, id, points) => fn(`public.wallet_spend_on_order('${customer}', '${id}', ${points})`);
const issue = (customer, id) => fn(`public.wallet_issue_change_code('${customer}', '${id}')`);
const addChange = (rider, id, received, code, action = null) =>
  fn(`public.wallet_add_change('${rider}', '${id}', ${received}, ${code === null ? "null" : `'${code}'`}, ${action ? `'${action}'` : "null"})`);
const correct = (actor, customer, delta, reason, action = null) =>
  svc(`select public.wallet_admin_correct('${actor}', '${customer}', ${delta}, ${reason === null ? "null" : `'${reason}'`}, ${action ? `'${action}'` : "null"}) as r`);
const balance = async (id) => Number((await one(db, `select wallet_balance from public.profiles where id = '${id}'`))[0].wallet_balance);
const orderRow = async (id) => (await one(db, `select total, wallet_points_used, payment_method::text as method, payment_status::text as status, status::text as order_status from public.orders where id = '${id}'`))[0];
const delivery = async (id) => (await one(db, `select status::text as status, cod_collected_amount, cod_collected_at from public.deliveries where order_id = '${id}'`))[0];
const ledger = async (where) => (await one(db, `select amount::int as amount, kind, reason, order_id, actor_id, actor_role, balance_after::int as balance_after, created_at from public.wallet_transactions where ${where} order by created_at`));
const sumsMatch = async () => {
  const rows = await one(db, `select p.id, p.wallet_balance, coalesce(s.total, 0) as total from public.profiles p
    left join (select user_id, sum(amount) as total from public.wallet_transactions group by 1) s on s.user_id = p.id
    where p.wallet_balance <> coalesce(s.total, 0)`);
  return rows.length === 0;
};
const position = async (rider) => (await one(db, `select public.ops_rider_cash_position('${rider}', (now() at time zone 'Asia/Kolkata')::date) as p`))[0].p;

// ---------- 1. adding change ----------
{
  const id = await outForDelivery(CUST, 3); // ₹150, as in the rule book.
  let code = await issue(CUST, id);
  ok(code.ok && /^\d{6}$/.test(code.code), "the customer gets a six-digit code during their cash delivery", JSON.stringify(code));

  const stored = await one(db, `select code_hash from public.wallet_change_codes where order_id = '${id}'`);
  ok(stored[0].code_hash && !stored[0].code_hash.includes(code.code) && stored[0].code_hash.length === 64, "only a hash of the code is stored");

  const other = await issue(CUST2, id);
  ok(!other.ok && other.error === "not_found", "another customer cannot get the code", JSON.stringify(other));

  let r = await addChange(RIDER2, id, 200, code.code);
  ok(!r.ok && r.error === "not_yours", "another rider cannot add change on this delivery", JSON.stringify(r));
  ok((await balance(CUST)) === 0, "still nothing added");

  r = await addChange(RIDER, id, 150, code.code);
  ok(!r.ok && r.error === "no_change", "exact cash: nothing to add", JSON.stringify(r));
  r = await addChange(RIDER, id, 100, code.code);
  ok(!r.ok && r.error === "no_change", "less than due: nothing to add", JSON.stringify(r));
  r = await addChange(RIDER, id, 251, code.code);
  ok(!r.ok && r.error === "over_limit" && r.limit === 100, "₹101 change over the ₹100 limit is refused", JSON.stringify(r));

  r = await addChange(RIDER, id, 200, "000000" === code.code ? "000001" : "000000");
  ok(!r.ok && r.error === "wrong_code" && r.tries_left === 4, "a wrong code adds nothing and counts one try", JSON.stringify(r));
  ok((await balance(CUST)) === 0, "wrong code: no points added");
  const cashAfterWrong = await delivery(id);
  ok(cashAfterWrong.cod_collected_at === null, "wrong code: no cash recorded");

  r = await addChange(RIDER, id, 200, code.code, "act-change-1");
  ok(r.ok && r.change === 50 && r.received === 200 && !r.replayed, "right code: ₹50 change from ₹200 on ₹150", JSON.stringify(r));
  ok((await balance(CUST)) === 50, "the wallet now holds ₹50");
  const d = await delivery(id);
  ok(d.cod_collected_amount === 200 && d.cod_collected_at, "the cash collected is the full ₹200", JSON.stringify(d));
  ok(d.status === "picked_up", "the rider still taps Delivered afterwards");
  const row = await ledger(`order_id = '${id}'`);
  ok(row.length === 1 && row[0].kind === "change_credit" && row[0].actor_id === RIDER && row[0].actor_role === "driver" && row[0].balance_after === 50 && row[0].created_at,
    "the ledger row says who, when, which order and the balance after", JSON.stringify(row));

  // The normal cash record runs after: conditional on empty, so it leaves ₹200.
  await asOwner(`update public.deliveries set cod_collected_amount = 150, cod_collected_at = now() where order_id = '${id}' and cod_collected_at is null`);
  ok((await delivery(id)).cod_collected_amount === 200, "the Delivered step's own cash record can't overwrite the ₹200");

  const replay = await addChange(RIDER, id, 200, code.code, "act-change-1");
  ok(replay.ok && replay.replayed && replay.change === 50, "a retry answers the same", JSON.stringify(replay));
  ok((await balance(CUST)) === 50, "a retry doesn't add twice");
  const again = await addChange(RIDER, id, 300, "123456");
  ok(again.ok && again.replayed && again.change === 50, "a second attempt with other numbers adds nothing", JSON.stringify(again));
  ok((await balance(CUST)) === 50, "still ₹50");
  ok((await ledger(`order_id = '${id}'`)).length === 1, "still one ledger row");
  const afterUse = await issue(CUST, id);
  ok(!afterUse.ok && afterUse.error === "already_added", "no new code once it's been added", JSON.stringify(afterUse));
  ok(await sumsMatch(), "ledger sum = balance after adding change");

  // Rider cash: all of it, and the change is not lost when they hand it over.
  await asOwner(`update public.orders set status = 'delivered' where id = '${id}'; update public.deliveries set status = 'delivered', delivered_at = now() where order_id = '${id}'`);
  const p = await position(RIDER);
  ok(p.collected_total === 200 && p.pending_deposit === 200, "the rider's cash balance is the full ₹200", JSON.stringify(p));
  const recon = (await one(db, `select public.ops_cash_reconciliation(null, (current_date - 2)::date, (current_date + 2)::date, '${RIDER}') as r`))[0].r;
  ok(Number(recon.riders[0].collected) === 200, "reconciliation counts the full ₹200", JSON.stringify(recon.riders));

  // No code asked for yet.
  const noCode = await outForDelivery(CUST2, 2);
  r = await addChange(RIDER, noCode, 150, "123456");
  ok(!r.ok && r.error === "no_code", "a customer with no app: no code, nothing added", JSON.stringify(r));
  await asOwner(`update public.deliveries set cod_collected_amount = 100, cod_collected_at = now(), status = 'delivered', delivered_at = now() where order_id = '${noCode}';
    update public.orders set status = 'delivered' where id = '${noCode}'`);
  ok((await delivery(noCode)).status === "delivered", "that delivery still completes the normal way");

  // Lockout: 5 wrong tries, and asking again doesn't reset them.
  const lock = await outForDelivery(CUST2, 2);
  let c = await issue(CUST2, lock);
  const bad = c.code === "111111" ? "222222" : "111111";
  for (let i = 0; i < 4; i++) await addChange(RIDER, lock, 150, bad);
  c = await issue(CUST2, lock);
  ok(c.ok, "a fresh code while tries remain");
  const fifth = await addChange(RIDER, lock, 150, c.code === bad ? "333333" : bad);
  ok(!fifth.ok && fifth.error === "locked", "the 5th wrong try locks it", JSON.stringify(fifth));
  const tried = await one(db, `select wrong_tries, locked_at from public.wallet_change_codes where order_id = '${lock}'`);
  ok(tried[0].wrong_tries === 5 && tried[0].locked_at, "the count is kept: asking again didn't reset it, and refusal didn't roll it back", JSON.stringify(tried));
  const right = await addChange(RIDER, lock, 150, c.code);
  ok(!right.ok && right.error === "locked", "locked: even the right code adds nothing", JSON.stringify(right));
  const relock = await issue(CUST2, lock);
  ok(!relock.ok && relock.error === "locked", "locked: no new code either", JSON.stringify(relock));

  // Expiry.
  const exp = await outForDelivery(CUST2, 2);
  const e = await issue(CUST2, exp);
  await db.exec(`update public.wallet_change_codes set expires_at = now() - interval '1 second' where order_id = '${exp}'`);
  const expired = await addChange(RIDER, exp, 150, e.code);
  ok(!expired.ok && expired.error === "code_expired", "an old code is refused", JSON.stringify(expired));

  // Switched off, and not during a delivery.
  const off = await outForDelivery(CUST2, 2);
  const oc = await issue(CUST2, off);
  await db.exec(`update public.platform_settings set feature_wallet = false`);
  const offR = await addChange(RIDER, off, 150, oc.code);
  ok(!offR.ok && offR.error === "wallet_off", "wallet off: nothing added", JSON.stringify(offR));
  await db.exec(`update public.platform_settings set feature_wallet = true`);
  const before = await placed(CUST, 2);
  const early = await issue(CUST, before);
  ok(!early.ok && early.error === "not_out_for_delivery", "no code before the food is out", JSON.stringify(early));

  // Limit moves with the setting.
  const lim = await outForDelivery(CUST2, 2);
  const lc = await issue(CUST2, lim);
  await db.exec(`update public.platform_settings set wallet_change_max_per_order = 20`);
  const limR = await addChange(RIDER, lim, 150, lc.code);
  ok(!limR.ok && limR.error === "over_limit" && limR.limit === 20, "the admin's limit is the one used", JSON.stringify(limR));
  await db.exec(`update public.platform_settings set wallet_change_max_per_order = 100`);
  await asOwner(`select 1`);
}

// ---------- 2. using points ----------
{
  await db.exec(`update public.platform_settings set feature_wallet = true`);
  const start = await balance(CUST);
  ok(start === 50, "starts with the ₹50 from before", String(start));

  // Partial.
  const part = await placed(CUST, 2); // ₹100
  let r = await spend(CUST, part, 30);
  ok(r.ok && r.points === 30 && r.cash_due === 70, "₹30 of points on a ₹100 order leaves ₹70 cash", JSON.stringify(r));
  let o = await orderRow(part);
  ok(o.total === 100 && o.wallet_points_used === 30, "orders.total stays the full bill", JSON.stringify(o));
  ok(o.method === "cod" && o.status === "pending", "still a cash order, still owing", JSON.stringify(o));
  ok((await balance(CUST)) === 20, "balance falls to ₹20");
  const l = await ledger(`order_id = '${part}'`);
  ok(l.length === 1 && l[0].amount === -30 && l[0].kind === "order_spend" && l[0].actor_id === CUST, "a ledger row for the spend", JSON.stringify(l));

  // Retry.
  r = await spend(CUST, part, 30);
  ok(r.ok && r.replayed && r.points === 30, "a retry answers the same", JSON.stringify(r));
  r = await spend(CUST, part, 5);
  ok(r.ok && r.replayed && r.points === 30, "a retry with another amount changes nothing", JSON.stringify(r));
  ok((await balance(CUST)) === 20 && (await orderRow(part)).wallet_points_used === 30, "a retry doesn't take points twice");
  ok(await sumsMatch(), "ledger sum = balance after a partial spend");

  // Overspend, and the bill's limit.
  const over = await placed(CUST, 2);
  r = await spend(CUST, over, 21);
  ok(!r.ok && r.error === "insufficient" && Number(r.balance) === 20, "can't spend more than the balance", JSON.stringify(r));
  ok((await orderRow(over)).wallet_points_used === 0 && (await balance(CUST)) === 20, "a refused spend changes nothing");
  await asOwner(`update public.profiles set wallet_balance = 500 where id = '${CUST2}'`);
  await asOwner(`insert into public.wallet_transactions (user_id, amount, reason, kind) values ('${CUST2}', 500, 'test money', 'legacy')`);
  const big = await placed(CUST2, 1);
  r = await spend(CUST2, big, 51);
  ok(!r.ok && r.error === "over_bill", "can't use more than the bill", JSON.stringify(r));
  r = await spend(CUST, big, 1);
  ok(!r.ok && r.error === "not_found", "can't spend on someone else's order", JSON.stringify(r));
  r = await spend(CUST2, big, 0);
  ok(!r.ok && r.error === "invalid_points", "zero points is refused", JSON.stringify(r));
  r = await spend(CUST2, big, -5);
  ok(!r.ok && r.error === "invalid_points", "negative points are refused", JSON.stringify(r));

  // Full.
  const full = await placed(CUST2, 2);
  r = await spend(CUST2, full, 100);
  ok(r.ok && r.cash_due === 0, "points can cover all of it", JSON.stringify(r));
  o = await orderRow(full);
  ok(o.total === 100 && o.wallet_points_used === 100 && o.method === "cod" && o.status === "paid",
    "fully covered: total stays, method stays cod, status paid", JSON.stringify(o));
  ok((await balance(CUST2)) === 400, "balance falls by the whole bill");

  // Fully covered: nothing to collect, no code, no change.
  await asOwner(`
    update public.orders set status = 'kitchen' where id = '${full}';
    update public.orders set status = 'ready' where id = '${full}';
    update public.orders set status = 'on_the_way' where id = '${full}';
    insert into public.deliveries (order_id, driver_id, status, assigned_at) values ('${full}', '${RIDER2}', 'assigned', now());
    update public.deliveries set status = 'picked_up', picked_up_at = now() where order_id = '${full}';
  `);
  const noCode = await issue(CUST2, full);
  ok(!noCode.ok && noCode.error === "no_cash_due", "fully covered: no code", JSON.stringify(noCode));
  const noAdd = await addChange(RIDER2, full, 200, "123456");
  ok(!noAdd.ok && noAdd.error === "no_cash_due", "fully covered: the rider can't add change", JSON.stringify(noAdd));

  // Change on a partly covered order works from the cash due, not the bill.
  const mixed = await outForDelivery(CUST2, 4, RIDER2, 150); // ₹200 bill, ₹150 points, ₹50 cash
  const mc = await issue(CUST2, mixed);
  const m = await addChange(RIDER2, mixed, 100, mc.code);
  ok(m.ok && m.change === 50, "₹100 cash on ₹50 due adds ₹50", JSON.stringify(m));
  const dm = await delivery(mixed);
  ok(dm.cod_collected_amount === 100, "the rider's cash on that order is the ₹100 they received", JSON.stringify(dm));

  // Two at once for the last of the balance. PGlite runs them in turn: see the header.
  await asOwner(`update public.profiles set wallet_balance = 40 where id = '${CUST}'`);
  await asOwner(`insert into public.wallet_transactions (user_id, amount, reason, kind) values ('${CUST}', 20, 'test money', 'legacy')`);
  const a = await placed(CUST, 1);
  const b = await placed(CUST, 1);
  const [ra, rb] = await Promise.all([spend(CUST, a, 40), spend(CUST, b, 40)]).catch(async () => [await spend(CUST, a, 40), await spend(CUST, b, 40)]);
  ok((ra.ok ? 1 : 0) + (rb.ok ? 1 : 0) === 1, "two spends for the last ₹40: one wins, one is told insufficient", JSON.stringify([ra, rb]));
  ok((await balance(CUST)) === 0, "the balance doesn't go negative");
  const body = (await one(db, `select pg_get_functiondef('public._wallet_apply(uuid,integer,text,text,uuid,uuid,text,text)'::regprocedure) as d`))[0].d;
  ok(/for update/i.test(body), "_wallet_apply takes a row lock");
  const spendBody = (await one(db, `select pg_get_functiondef('public.wallet_spend_on_order(uuid,uuid,integer)'::regprocedure) as d`))[0].d;
  ok((spendBody.match(/for update/gi) ?? []).length >= 2, "the spend locks the order and then the balance before comparing");
  ok(await sumsMatch(), "ledger sum = balance after spending");

  // Whole rupees.
  const frac = await as("authenticated", CUST, `select 1`);
  ok(frac.ok, "harness still healthy");
  const paise = await db.exec(`update public.profiles set wallet_balance = 10.5 where id = '${CUST2}'`).then(() => ({ ok: true }), (e) => ({ ok: false, msg: String(e.message) }));
  ok(!paise.ok && /whole/.test(paise.msg), "a fraction of a rupee is refused on the balance", paise.msg ?? "accepted");
  const paiseL = await db.exec(`insert into public.wallet_transactions (user_id, amount, reason, kind) values ('${CUST2}', 1.5, 'x', 'admin_correction')`).then(() => ({ ok: true }), (e) => ({ ok: false, msg: String(e.message) }));
  ok(!paiseL.ok && /whole/.test(paiseL.msg), "a fraction of a rupee is refused on the ledger", paiseL.msg ?? "accepted");

  // Cash limit: judged on the cash due.
  await db.exec(`update public.platform_settings set cash_limit_per_order = 120`);
  await asOwner(`update public.profiles set wallet_balance = wallet_balance + 100 where id = '${CUST}'`);
  await asOwner(`insert into public.wallet_transactions (user_id, amount, reason, kind) values ('${CUST}', 100, 'test money', 'legacy')`);
  const withPts = await placed(CUST, 4); // ₹200, over the ₹120 limit
  const noPts = await placed(CUST, 4);
  await spend(CUST, withPts, 100); // ₹100 cash due
  let acc = await as("authenticated", VEND, `update public.orders set status = 'kitchen' where id = '${withPts}'`);
  ok(acc.ok, "₹200 bill with ₹100 points: ₹100 cash is under the ₹120 limit", acc.msg);
  acc = await as("authenticated", VEND, `update public.orders set status = 'kitchen' where id = '${noPts}'`);
  ok(!acc.ok && /over the cash limit/.test(acc.msg), "the same bill with no points is still refused", acc.msg ?? "accepted");
  await db.exec(`update public.platform_settings set cash_limit_per_order = 0, feature_online_payment = true, feature_cash_payment = false`);
  const fullOff = await placed(CUST2, 1);
  await spend(CUST2, fullOff, 50);
  acc = await as("authenticated", VEND, `update public.orders set status = 'kitchen' where id = '${fullOff}'`);
  ok(acc.ok, "cash switched off: a fully covered order still goes through, there's no cash", acc.msg);
  await db.exec(`update public.platform_settings set feature_cash_payment = true, feature_online_payment = false`);

  // Online orders can't use points yet.
  const online = await as("authenticated", CUST2, `insert into public.orders (customer_id, restaurant_id, address, payment_method)
    values ('${CUST2}', '${SHOP}', ${IN_TOWN}, 'online') returning id`);
  if (online.ok) {
    const onlineId = online.rows[0].id;
    await as("authenticated", CUST2, `insert into public.order_items (order_id, menu_item_id, name, qty, price) values ('${onlineId}', '${DISH}', 'x', 1, 1)`);
    await as("authenticated", CUST2, `select public.recompute_order_total('${onlineId}')`);
    const on = await spend(CUST2, onlineId, 10);
    ok(!on.ok && on.error === "cash_orders_only", "an online order can't use points yet", JSON.stringify(on));
  } else {
    ok(false, "an online order could be placed for the test", online.msg);
  }

  // A coupon after points: the bill falls below them, the difference goes back.
  const coup = await placed(CUST2, 1);
  await spend(CUST2, coup, 50);
  const bal0 = await balance(CUST2);
  await asOwner(`update public.orders set total = 30 where id = '${coup}'`);
  const co = await orderRow(coup);
  ok(co.wallet_points_used === 30 && co.status === "paid", "a bill that falls below the points: points are capped at the bill", JSON.stringify(co));
  ok((await balance(CUST2)) === bal0 + 20, "and the difference goes back");
  ok((await ledger(`order_id = '${coup}' and kind = 'order_adjust'`))[0].amount === 20, "with a ledger row");
  await asOwner(`update public.orders set total = 60 where id = '${coup}'`);
  const co2 = await orderRow(coup);
  ok(co2.wallet_points_used === 30 && co2.status === "pending", "a bill that rises above the points: it's owing again", JSON.stringify(co2));
  ok(await sumsMatch(), "ledger sum = balance after a changed bill");
}

// ---------- 3. cancelling ----------
{
  await asOwner(`update public.profiles set wallet_balance = 300 where id = '${CUST}'`);
  await asOwner(`insert into public.wallet_transactions (user_id, amount, reason, kind) select '${CUST}', 300 - coalesce(sum(amount), 0), 'test money', 'legacy' from public.wallet_transactions where user_id = '${CUST}'`);

  // The customer, inside 20 seconds.
  const c1 = await placed(CUST, 2);
  await spend(CUST, c1, 100);
  ok((await orderRow(c1)).status === "paid", "fully covered before the cancel");
  ok((await balance(CUST)) === 200, "points taken");
  let r = await as("authenticated", CUST, `select public.customer_cancel_order('${c1}') as r`);
  ok(r.ok, "the customer cancels inside 20 seconds", r.msg);
  ok((await balance(CUST)) === 300, "the points come back");
  const o = await orderRow(c1);
  ok(o.order_status === "cancelled" && o.wallet_points_used === 100 && o.status === "pending",
    "the order keeps the record of what was used; nothing is owed or paid", JSON.stringify(o));
  const back = await ledger(`order_id = '${c1}' and kind = 'order_return'`);
  ok(back.length === 1 && back[0].amount === 100 && back[0].actor_id === CUST && back[0].actor_role === "customer", "one ledger row for the return, with who did it", JSON.stringify(back));
  r = await as("authenticated", CUST, `select public.customer_cancel_order('${c1}') as r`);
  ok(r.ok && (await balance(CUST)) === 300, "a second tap returns nothing more");
  ok((await ledger(`order_id = '${c1}' and kind = 'order_return'`)).length === 1, "still one return row");

  // The shop rejecting a new order, on its own session.
  const c2 = await placed(CUST, 2);
  await spend(CUST, c2, 40);
  r = await as("authenticated", VEND, `update public.orders set status = 'cancelled' where id = '${c2}'`);
  ok(r.ok, "the shop rejects a new order", r.msg);
  ok((await balance(CUST)) === 300, "the points come back");

  // Staff, later on.
  const zone = (await one(db, `select zone_id from public.orders where id = '${c2}'`))[0].zone_id;
  await asOwner(`insert into public.staff_zones (user_id, zone_id) values ('${MGR}', '${zone}') on conflict do nothing`);
  const c3 = await outForDelivery(CUST, 2, RIDER, 60);
  ok((await balance(CUST)) === 240, "points taken again");
  r = await svc(`select public.ops_cancel_order('${MGR}', '${c3}', 'customer unreachable', 'act-cancel-3') as r`);
  ok(r.ok, "a manager cancels with a reason", r.msg);
  ok((await balance(CUST)) === 300, "the points come back");
  const staffBack = await ledger(`order_id = '${c3}' and kind = 'order_return'`);
  ok(staffBack[0].actor_id === MGR && staffBack[0].actor_role === "manager", "the row names the manager", JSON.stringify(staffBack));
  r = await svc(`select public.ops_cancel_order('${MGR}', '${c3}', 'customer unreachable', 'act-cancel-3') as r`);
  ok(r.ok && (await balance(CUST)) === 300, "a replayed cancel returns nothing more");

  // Service role clean-up (createOrder's own).
  const c4 = await placed(CUST, 2);
  await spend(CUST, c4, 10);
  r = await svc(`update public.orders set status = 'cancelled', cancelled_by = 'system' where id = '${c4}' returning id`);
  ok(r.ok && (await balance(CUST)) === 300, "createOrder's clean-up returns them too", r.msg);

  // Brought back: the points went home, so the whole bill is cash.
  await asOwner(`update public.orders set status = 'placed' where id = '${c4}'`);
  const revived = await orderRow(c4);
  ok(revived.wallet_points_used === 0 && revived.status === "pending", "an order brought back from cancelled owes the whole bill", JSON.stringify(revived));
  await asOwner(`update public.orders set status = 'cancelled' where id = '${c4}'`);
  ok((await balance(CUST)) === 300, "cancelling it again returns nothing");

  // A change credit is not taken back by a cancel: the customer really handed it over.
  const c5 = await outForDelivery(CUST, 2, RIDER);
  const code = await issue(CUST, c5);
  const add = await addChange(RIDER, c5, 150, code.code);
  ok(add.ok && (await balance(CUST)) === 350, "₹50 change added before a cancel", JSON.stringify(add));
  r = await svc(`select public.ops_cancel_order('${MGR}', '${c5}', 'wrong address', null) as r`);
  ok(r.ok && (await balance(CUST)) === 350, "the cancel leaves the change in the wallet", r.msg);
  ok((await delivery(c5)).cod_collected_amount === 150, "and the cash stays on the rider's books");

  // Rider ledger trigger / cod guard: a rider can't be moved off collected cash.
  ok(await sumsMatch(), "ledger sum = balance after cancelling");
}

// ---------- 4. correcting ----------
{
  const start = await balance(CUST2);
  let r = await correct(MGR, CUST2, 10, "a manager trying");
  ok(!r.ok && /forbidden/.test(r.msg), "a manager can't correct a balance", r.msg ?? "accepted");
  r = await correct(RIDER, CUST2, 10, "a rider trying");
  ok(!r.ok && /forbidden/.test(r.msg), "a rider can't correct a balance", r.msg ?? "accepted");
  r = await correct(ADMIN, CUST2, 10, null);
  ok(r.ok && !r.rows[0].r.ok && r.rows[0].r.error === "reason_required", "no reason: refused", JSON.stringify(r));
  r = await correct(ADMIN, CUST2, 10, "   ");
  ok(r.ok && r.rows[0].r.error === "reason_required", "a blank reason: refused", JSON.stringify(r));
  r = await correct(ADMIN, CUST2, 0, "nothing at all");
  ok(r.ok && r.rows[0].r.error === "invalid_amount", "zero: refused", JSON.stringify(r));
  r = await correct(ADMIN, CUST2, -(start + 1), "too far down");
  ok(r.ok && r.rows[0].r.error === "would_go_negative", "can't take it below zero", JSON.stringify(r));
  ok((await balance(CUST2)) === start, "nothing changed yet");

  r = await correct(ADMIN, CUST2, 25, "Rider typed the wrong order", "act-correct-1");
  ok(r.ok && r.rows[0].r.ok && !r.rows[0].r.replayed, "an admin with a reason", JSON.stringify(r));
  ok((await balance(CUST2)) === start + 25, "the balance moves");
  const row = (await ledger(`kind = 'admin_correction' and user_id = '${CUST2}'`))[0];
  ok(row.actor_id === ADMIN && row.reason === "Rider typed the wrong order" && row.amount === 25, "the ledger keeps who and why", JSON.stringify(row));
  const audit = await one(db, `select action, reason, actor_id from public.ops_audit_log where action = 'wallet.correct' and entity_id = '${CUST2}'`);
  ok(audit.length === 1 && audit[0].actor_id === ADMIN, "and the ops audit log has it too", JSON.stringify(audit));
  r = await correct(ADMIN, CUST2, 25, "Rider typed the wrong order", "act-correct-1");
  ok(r.ok && r.rows[0].r.replayed && (await balance(CUST2)) === start + 25, "a retry with the same action id applies once", JSON.stringify(r));
  r = await correct(ADMIN, CUST2, -25, "Taking the test money back");
  ok(r.ok && (await balance(CUST2)) === start, "a correction can go down too", JSON.stringify(r));
  ok(await sumsMatch(), "ledger sum = balance after corrections");
}

// ---------- 5. nobody writes it directly ----------
{
  const start = await balance(CUST);
  const someOrder = (await one(db, `select id from public.orders where customer_id = '${CUST}' and status = 'placed' limit 1`))[0]?.id;

  let r = await as("authenticated", CUST, `update public.profiles set wallet_balance = 9999 where id = '${CUST}'`);
  ok(!r.ok, "a customer can't set their own balance", r.msg ?? "accepted");
  r = await as("authenticated", ADMIN, `update public.profiles set wallet_balance = 9999 where id = '${CUST}'`);
  ok(!r.ok, "an admin's session can't write the balance directly, only through a correction", r.msg ?? "accepted");
  r = await svc(`update public.profiles set wallet_balance = 9999 where id = '${CUST}'`);
  ok(!r.ok && /only be changed by the server/.test(r.msg), "the service role can't write it directly either", r.msg ?? "accepted");
  ok((await balance(CUST)) === start, "still the same balance");

  r = await as("authenticated", CUST, `insert into public.wallet_transactions (user_id, amount, reason) values ('${CUST}', 100, 'gift')`);
  ok(!r.ok, "a customer can't insert a ledger row", r.msg ?? "accepted");
  r = await as("authenticated", CUST, `update public.wallet_transactions set amount = 1000 where user_id = '${CUST}'`);
  ok(!r.ok, "a customer can't change a ledger row", r.msg ?? "accepted");
  r = await as("authenticated", CUST, `delete from public.wallet_transactions where user_id = '${CUST}'`);
  ok(!r.ok, "a customer can't delete a ledger row", r.msg ?? "accepted");
  r = await svc(`insert into public.wallet_transactions (user_id, amount, reason) values ('${CUST}', 100, 'gift')`);
  ok(!r.ok, "the service role can't insert a ledger row", r.msg ?? "accepted");
  r = await svc(`delete from public.wallet_transactions where user_id = '${CUST}'`);
  ok(!r.ok, "the service role can't delete a ledger row", r.msg ?? "accepted");
  const del = await db.exec(`delete from public.wallet_transactions where user_id = '${CUST}'`).then(() => ({ ok: true }), (e) => ({ ok: false, msg: String(e.message) }));
  ok(!del.ok && /append-only/.test(del.msg), "even a person with database access can't quietly delete one", del.msg ?? "accepted");
  const gone = await db.exec(`delete from public.profiles where id = '${CUST}'`).then(() => ({ ok: true }), (e) => ({ ok: false, msg: String(e.message) }));
  ok(!gone.ok, "a profile with wallet history can't vanish", gone.msg ?? "accepted");

  for (const [name, call] of [
    ["wallet_spend_on_order", `public.wallet_spend_on_order('${CUST}', '${someOrder ?? uuid(99)}', 1)`],
    ["wallet_add_change", `public.wallet_add_change('${RIDER}', '${someOrder ?? uuid(99)}', 100, '123456', null)`],
    ["wallet_issue_change_code", `public.wallet_issue_change_code('${CUST}', '${someOrder ?? uuid(99)}')`],
    ["wallet_admin_correct", `public.wallet_admin_correct('${ADMIN}', '${CUST}', 100, 'nope nope', null)`],
    ["ops_wallet_summary", `public.ops_wallet_summary()`],
  ]) {
    r = await as("authenticated", CUST, `select ${call}`);
    ok(!r.ok && /permission denied/.test(r.msg), `a customer can't call ${name}`, r.msg ?? "accepted");
    r = await as("anon", null, `select ${call}`);
    ok(!r.ok && /permission denied/.test(r.msg), `a signed-out caller can't call ${name}`, r.msg ?? "accepted");
  }
  r = await svc(`select public._wallet_apply('${CUST}', 100, 'admin_correction', 'x', null, null, null, null)`);
  ok(!r.ok && /permission denied/.test(r.msg), "the service role can't reach the inner function", r.msg ?? "accepted");

  // The order column.
  r = await as("authenticated", CUST, `insert into public.orders (customer_id, restaurant_id, address, payment_method, wallet_points_used)
    values ('${CUST}', '${SHOP}', ${IN_TOWN}, 'cod', 999) returning wallet_points_used`);
  ok(r.ok && r.rows[0].wallet_points_used === 0, "a customer's insert can't claim points", JSON.stringify(r));
  const free = await placed(CUST, 1);
  r = await as("authenticated", CUST, `update public.orders set wallet_points_used = 50 where id = '${free}'`);
  ok(!r.ok || (await orderRow(free)).wallet_points_used === 0, "a customer can't set points on an order", r.msg ?? "");
  r = await as("authenticated", VEND, `update public.orders set wallet_points_used = 50 where id = '${free}'`);
  ok(!r.ok, "a shop can't either", r.msg ?? "accepted");
  r = await svc(`update public.orders set wallet_points_used = 50 where id = '${free}'`);
  ok(!r.ok && /only be changed by the server/.test(r.msg), "nor can the service role", r.msg ?? "accepted");

  // Reading.
  r = await as("authenticated", CUST, `select wallet_balance from public.profiles where id = '${CUST}'`);
  ok(!r.ok && /permission denied/.test(r.msg), "the balance column isn't granted: it's read through the API", r.msg ?? "readable");
  r = await as("authenticated", VEND, `select wallet_balance from public.profiles where id = '${CUST}'`);
  ok(!r.ok && /permission denied/.test(r.msg), "a shop can't read a customer's balance", r.msg ?? "readable");
  r = await as("authenticated", VEND, `select full_name from public.profiles where id = '${CUST}'`);
  ok(r.ok && r.rows[0]?.full_name === "Asha", "a shop can still read the customer's name", JSON.stringify(r));
  r = await as("authenticated", CUST, `select id, full_name, phone, role, created_at from public.profiles where id = '${CUST}'`);
  ok(r.ok && r.rows.length === 1, "a customer can still read their own profile", JSON.stringify(r));
  r = await as("authenticated", CUST, `select amount from public.wallet_transactions where user_id = '${CUST}'`);
  ok(r.ok && r.rows.length > 0, "a customer reads their own history", r.msg);
  r = await as("authenticated", CUST, `select amount from public.wallet_transactions where user_id = '${CUST2}'`);
  ok(r.ok && r.rows.length === 0, "and nobody else's", JSON.stringify(r));
  r = await as("authenticated", RIDER, `select amount from public.wallet_transactions`);
  ok(r.ok && r.rows.length === 0, "a rider reads no ledger rows", JSON.stringify(r));
  r = await as("authenticated", CUST, `select * from public.wallet_change_codes`);
  ok(!r.ok && /permission denied/.test(r.msg), "a customer can't read the codes table", r.msg ?? "readable");
  r = await as("authenticated", RIDER, `select * from public.wallet_change_codes`);
  ok(!r.ok && /permission denied/.test(r.msg), "a rider can't read the codes table", r.msg ?? "readable");
  r = await svc(`select code_hash from public.wallet_change_codes`);
  ok(!r.ok && /permission denied/.test(r.msg), "nor can the service role, only the functions", r.msg ?? "readable");
  r = await as("authenticated", CUST, `select wallet_points_used from public.orders where id = '${free}'`);
  ok(r.ok && r.rows.length === 1, "orders.wallet_points_used is granted to read", r.msg);
  r = await as("authenticated", CUST, `select feature_wallet, wallet_change_max_per_order from public.platform_settings`);
  ok(r.ok && r.rows[0].wallet_change_max_per_order === 100, "checkout can read the wallet settings, default ₹100", JSON.stringify(r));
  r = await as("authenticated", CUST, `update public.platform_settings set wallet_change_max_per_order = 9000`);
  ok((await one(db, `select wallet_change_max_per_order as m from public.platform_settings`))[0].m === 100, "a customer can't change them");
}

// ---------- 6. shop payout: the same with and without points ----------
{
  await asOwner(`update public.profiles set wallet_balance = wallet_balance + 500 where id = '${CUST}'`);
  await asOwner(`insert into public.wallet_transactions (user_id, amount, reason, kind) values ('${CUST}', 500, 'test money', 'legacy')`);
  const plain = await placed(CUST, 4);
  const part = await placed(CUST, 4);
  const full = await placed(CUST, 4);
  await spend(CUST, part, 75);
  await spend(CUST, full, 200);
  const read = async (id) => (await one(db, `select b.* from public.orders o,
    lateral public.ops_order_breakdown(o.total, o.delivery_fee, o.tax_amount, o.tip, o.discount, o.discount_funded_by::text, 20, 18, 5, o.payment_method::text, o.payment_status::text, 0) b
    where o.id = '${id}'`))[0];
  const [a, b, c] = [await read(plain), await read(part), await read(full)];
  ok(JSON.stringify(a) === JSON.stringify(b), "the SQL payout is the same with some points", JSON.stringify([a, b]));
  ok(JSON.stringify(a) === JSON.stringify(c), "and with all points", JSON.stringify([a, c]));
  ok((await orderRow(full)).total === (await orderRow(plain)).total, "the bill is the same on all three");
}

// ---------- 7. the summary ----------
{
  const s = await svc(`select public.ops_wallet_summary() as s`);
  ok(s.ok, "the summary runs for the service role", s.msg);
  const held = await one(db, `select coalesce(sum(wallet_balance), 0)::int as h, count(*) filter (where wallet_balance > 0)::int as c from public.profiles`);
  ok(Number(s.rows[0].s.held) === held[0].h && Number(s.rows[0].s.customers) === held[0].c, "total held and customers with points match the balances", JSON.stringify([s.rows[0].s, held]));
  ok(Number(s.rows[0].s.added_this_month) > 0 && Number(s.rows[0].s.used_this_month) > 0, "added and used this month are counted", JSON.stringify(s.rows[0].s));
  ok(await sumsMatch(), "ledger sum = balance at the very end");
}

// ---------- 8. a re-run, and reconciling old rows ----------
{
  await db.exec(`alter table public.wallet_transactions disable trigger wallet_ledger_append_only`);
  await asOwner(`select 1`);
  const { readFileSync } = await import("node:fs");
  const { migDir, adapt } = await import("./chain-lib.mjs");
  const path = await import("node:path");
  const sql = adapt(readFileSync(path.join(migDir, "0198_customer_wallet.sql"), "utf8"));
  // The odd old balances the 0056 guard allowed an admin session to write by hand.
  await db.exec(`alter table public.profiles drop constraint profiles_wallet_balance_whole;
    alter table public.profiles drop constraint profiles_wallet_balance_nonneg;
    alter table public.profiles disable trigger profiles_guard_wallet_balance;
    update public.profiles set wallet_balance = 12.40 where id = '${RIDER}';
    update public.profiles set wallet_balance = -7 where id = '${RIDER2}';
    alter table public.profiles enable trigger profiles_guard_wallet_balance;
    alter table public.profiles add constraint profiles_wallet_balance_nonneg check (wallet_balance >= 0) not valid;`);
  await db.exec(`alter table public.wallet_transactions enable trigger wallet_ledger_append_only`);
  let rerun = { ok: true };
  await db.exec(sql).catch((e) => { rerun = { ok: false, msg: String(e.message) }; });
  ok(rerun.ok, "the migration is safe to run again", rerun.msg);
  ok((await balance(RIDER)) === 13, "an old fraction rounds up: it's the customer's money", String(await balance(RIDER)));
  ok((await balance(RIDER2)) === 0, "an old negative becomes zero", String(await balance(RIDER2)));
  ok(await sumsMatch(), "reconciling leaves ledger sum = balance");
  const legacy = await ledger(`user_id = '${RIDER}' and kind = 'legacy'`);
  ok(legacy.length === 1 && legacy[0].amount === 13, "with a legacy ledger row saying so", JSON.stringify(legacy));
}

await db.close();
console.log(fails ? `\n${fails} check(s) failed` : "\nAll 0198 checks passed.");
process.exit(fails ? 1 : 0);
