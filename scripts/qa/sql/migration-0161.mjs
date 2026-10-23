// Runs migration 0161 (offer eligibility, change log, audited offer writes) in
// PGlite on top of growth-base.mjs + 0160. Needs: npm i --no-save @electric-sql/pglite@0.2.17
// Usage: node scripts/qa/sql/migration-0161.mjs
import { growthBase, harness, readMigration, id, IDS } from "./growth-base.mjs";

const { db, ZA, ZB } = await growthBase();
const { A, M, MB, V, C, R1, R2 } = IDS;
const I1 = id(511), I2 = id(512), IB = id(513);
const REQ = id(611), REQ_FEAT = id(612);
const O = (n) => id(700 + n);

await db.exec(`
  insert into public.menu_items (id, restaurant_id, name, price) values ('${I1}','${R1}','Roll',200), ('${I2}','${R1}','Lassi',300),
    ('${IB}','${R2}','Thali',150);
  insert into public.coupons (code, kind, value, min_order, restaurant_id, funded_by, created_by) values
    ('SPICE10','percent',10,0,'${R1}','vendor','${V}'), ('WELCOME50','flat',50,149,null,'platform',null);
  insert into public.marketing_requests (id, restaurant_id, requested_by, kind, title, details, status) values
    ('${REQ}','${R1}','${V}','discount_offer','₹50 off','', 'pending'),
    ('${REQ_FEAT}','${R1}','${V}','featured','Top slot','', 'approved');
`);
await db.exec(readMigration("0160_marketing_campaigns.sql"));
await db.exec(readMigration("0161_offers_eligibility_changes.sql"));
const { ok, as, fails, srv, one, done } = harness(db);
const audits = async (action) => (await one(`select count(*)::int as n from public.ops_audit_log where action = '${action}'`)).n;
const in1d = `(now() + interval '1 day')::text`;
const in30d = `(now() + interval '30 days')::text`;

// An order to price coupons against: lines Roll ₹200 + Lassi ₹300 at Spice Hub.
async function order(n, rid = R1, lines = [[I1, 200], [I2, 300]]) {
  await db.exec(`insert into public.orders (id, customer_id, restaurant_id, status, total) values ('${O(n)}','${C}','${rid}','placed',0);
    ${lines.map(([i, p]) => `insert into public.order_items (order_id, menu_item_id, name, qty, price) values ('${O(n)}','${i}','x',1,${p});`).join("\n")}`);
  return O(n);
}
const apply = async (oid, code) => (await srv(`select public.apply_coupon_to_order('${oid}','${code}') as r`)).rows[0].r;

console.log("\n── backfill, mirror, change log ──");
ok("the existing shop code is mirrored into coupon_restaurants",
  (await one(`select count(*)::int as n from public.coupon_restaurants where code = 'SPICE10' and restaurant_id = '${R1}'`)).n === 1);
await db.exec(`set role authenticated; select set_config('test.uid','${V}',false);
  update public.coupons set value = 15 where code = 'SPICE10'; reset role; select set_config('test.uid','',false);`);
const ch = await one(`select actor_id, op, target, (before ->> 'value') as b, (after ->> 'value') as a from public.coupon_changes
  where code = 'SPICE10' and op = 'update' order by id desc limit 1`);
ok("a vendor's own edit is logged with the vendor as actor", ch?.actor_id === V && ch.b === "10.00" && ch.a === "15.00", JSON.stringify(ch));
ok("the change log cannot be edited", fails(await srv(`update public.coupon_changes set reason = 'x'`), /append-only/));
ok("...or deleted", fails(await srv(`delete from public.coupon_changes`), /append-only/));

console.log("\n── pricing rules ──");
await db.exec(`insert into public.coupons (code, kind, value, starts_at, expires_at) values ('LATER','flat',40, now() + interval '1 day', now() + interval '9 days')`);
ok("a not-started code is refused at apply", (await apply(await order(1), "LATER")).error === "not_started");
let r = await srv(`select public.ops_upsert_offer('${A}','ZONEB20',jsonb_build_object('kind','flat','value',20,'zoneIds',jsonb_build_array('${ZB}'),'expiresAt',${in30d}),null,null,'o0') as s`);
ok("an admin creates a zone-B code", r.ok, r.msg);
ok("...refused at a zone-A shop: wrong_zone", (await apply(await order(2), "ZONEB20")).error === "wrong_zone");
r = await srv(`select public.ops_upsert_offer('${A}','ROLL20',jsonb_build_object('kind','percent','value',20,'minOrder',400,
  'vendorIds',jsonb_build_array('${R1}'),'itemIds',jsonb_build_array('${I1}'),'expiresAt',${in30d}),null,null,'o1') as s`);
ok("an admin creates an item-limited 20% code", r.ok, r.msg);
const oid3 = await order(3);
const applied = await apply(oid3, "ROLL20");
ok("20% of the eligible ₹200 line only = 40; min_order 400 checks the ₹500 basket", applied.ok === true && applied.discount === 40, JSON.stringify(applied));
const pv = await as("authenticated", C, `select public.preview_coupon('ROLL20','${R1}',
  jsonb_build_array(jsonb_build_object('menuItemId','${I1}','qty',1), jsonb_build_object('menuItemId','${I2}','qty',1))) as p`);
ok("the basket preview equals the bill", pv.ok && pv.rows[0].p.discount === 40, pv.msg ?? JSON.stringify(pv.rows?.[0]));
const pvNone = await as("authenticated", C, `select public.preview_coupon('ROLL20','${R1}', jsonb_build_array(jsonb_build_object('menuItemId','${I2}','qty',2))) as p`);
ok("a basket with no eligible dish → no_eligible_items (min order met)", pvNone.rows?.[0].p.error === "no_eligible_items", JSON.stringify(pvNone.rows?.[0]));
ok("a different shop → wrong_restaurant", (await apply(await order(4, R2, [[IB, 500]]), "ROLL20")).error === "wrong_restaurant");
await db.exec(`update public.coupons set active = false where code = 'WELCOME50'`);
ok("an inactive code is refused at apply even without a preview", (await apply(await order(5), "WELCOME50")).error === "invalid");
await db.exec(`update public.coupons set active = true, max_redemptions = 1, max_per_customer = null where code = 'WELCOME50'`);
ok("a 1-use code applies once", (await apply(await order(6), "WELCOME50")).ok === true);
ok("...then is exhausted", (await apply(await order(7), "WELCOME50")).error === "exhausted");

console.log("\n── ops_upsert_offer ──");
ok("a manager naming a zone-B dish → out_of_scope", fails(await srv(`select public.ops_upsert_offer('${M}','BAD1',
  jsonb_build_object('kind','flat','value',10,'vendorIds',jsonb_build_array('${R1}'),'itemIds',jsonb_build_array('${IB}'),'expiresAt',${in30d}),null,null,'o2')`), /out_of_scope/));
ok("a manager naming a zone-B shop → out_of_scope", fails(await srv(`select public.ops_upsert_offer('${M}','BAD2',
  jsonb_build_object('kind','flat','value',10,'vendorIds',jsonb_build_array('${R2}'),'expiresAt',${in30d}),null,null,'o3')`), /out_of_scope/));
ok("a manager's platform-wide code → platform_wide_admin_only", fails(await srv(`select public.ops_upsert_offer('${M}','ALL10',
  jsonb_build_object('kind','flat','value',10,'expiresAt',${in30d}),null,null,'o4')`), /platform_wide_admin_only/));
ok("a manager's code without an expiry → bad_request expiresAt", fails(await srv(`select public.ops_upsert_offer('${M}','NOEND',
  jsonb_build_object('kind','flat','value',10,'zoneIds',jsonb_build_array('${ZA}')),null,null,'o5')`), /bad_request/));
ok("a 95% code → bad_request", fails(await srv(`select public.ops_upsert_offer('${M}','BIG95',
  jsonb_build_object('kind','percent','value',95,'zoneIds',jsonb_build_array('${ZA}'),'expiresAt',${in30d}),null,null,'o6')`), /bad_request/));
ok("vendor-funded without a request → consent_required", fails(await srv(`select public.ops_upsert_offer('${M}','VEND1',
  jsonb_build_object('kind','flat','value',30,'vendorIds',jsonb_build_array('${R1}'),'fundedBy','vendor','expiresAt',${in30d}),null,null,'o7')`), /consent_required/));
ok("...or with a request of the wrong kind → consent_required", fails(await srv(`select public.ops_upsert_offer('${M}','VEND2',
  jsonb_build_object('kind','flat','value',30,'vendorIds',jsonb_build_array('${R1}'),'fundedBy','vendor','requestId','${REQ_FEAT}','expiresAt',${in30d}),null,null,'o8')`), /consent_required/));
ok("an admin may set up a vendor-funded code for one shop without a request", (await srv(`select public.ops_upsert_offer('${A}','ADMINV',
  jsonb_build_object('kind','flat','value',30,'vendorIds',jsonb_build_array('${R1}'),'fundedBy','vendor'),null,null,'oa1')`)).ok);
ok("...but not across two shops → consent_required", fails(await srv(`select public.ops_upsert_offer('${A}','ADMINV2',
  jsonb_build_object('kind','flat','value',30,'vendorIds',jsonb_build_array('${R1}','${R2}'),'fundedBy','vendor'),null,null,'oa2')`), /consent_required/));
r = await srv(`select public.ops_decide_marketing_request('${M}','${REQ}','approve','pending','Agreed on call',null,
  jsonb_build_object('code','SPICE50','kind','flat','value',50,'fundedBy','vendor','minOrder',299,'expiresAt',${in30d}),'o9') as s`);
ok("approving the vendor's discount request creates its vendor-funded code", r.ok && r.rows[0].s.offer_code === "SPICE50", r.msg);
ok("...for that shop only, funded by the vendor", await (async () => {
  const c = await one(`select restaurant_id, funded_by, created_by from public.coupons where code = 'SPICE50'`);
  return c.restaurant_id === R1 && c.funded_by === "vendor" && c.created_by === M;
})());
r = await srv(`select public.ops_upsert_offer('${M}','ZONEA30',jsonb_build_object('kind','flat','value',30,'zoneIds',jsonb_build_array('${ZA}'),
  'expiresAt',${in1d}),null,null,'o10') as s`);
ok("a manager creates a zone-A platform-funded code", r.ok && (await audits("offer.create")) >= 2, r.msg);
r = await srv(`select public.ops_upsert_offer('${M}','ZONEA30',jsonb_build_object('kind','flat','value',30,'zoneIds',jsonb_build_array('${ZA}'),
  'expiresAt',${in1d}),null,null,'o10') as s`);
ok("replaying the create returns the code, replayed", r.ok && r.rows[0].s.replayed === true, r.msg);
ok("the same code again → code_taken", fails(await srv(`select public.ops_upsert_offer('${M}','ZONEA30',
  jsonb_build_object('kind','flat','value',30,'zoneIds',jsonb_build_array('${ZA}'),'expiresAt',${in1d}),null,null,'o11')`), /code_taken/));
const upd = (await one(`select updated_at from public.coupons where code = 'ZONEA30'`)).updated_at.toISOString();
ok("an edit without a reason → reason_required", fails(await srv(`select public.ops_upsert_offer('${M}','ZONEA30',
  jsonb_build_object('maxDiscount',25),'${upd}',null,'o12')`), /reason_required/));
r = await srv(`select public.ops_upsert_offer('${M}','ZONEA30',jsonb_build_object('value',35),'${upd}','Weekend boost','o13') as s`);
ok("an edit with the current token and a reason", r.ok && (await one(`select value from public.coupons where code = 'ZONEA30'`)).value === "35.00", r.msg);
ok("...logged with the manager as actor and the reason", await (async () => {
  const c = await one(`select actor_id, reason from public.coupon_changes where code = 'ZONEA30' and op = 'update' order by id desc limit 1`);
  return c.actor_id === M && c.reason === "Weekend boost";
})());
ok("the old token → stale", fails(await srv(`select public.ops_upsert_offer('${M}','ZONEA30',jsonb_build_object('value',40),'${upd}','Again','o14')`), /stale/));
ok("the zone-B manager cannot edit it", fails(await srv(`select public.ops_upsert_offer('${MB}','ZONEA30',jsonb_build_object('value',40),
  (select updated_at from public.coupons where code = 'ZONEA30'),'Mine now','o15')`), /forbidden/));
ok("a manager cannot edit a platform-wide code", fails(await srv(`select public.ops_upsert_offer('${M}','WELCOME50',jsonb_build_object('value',40),
  (select updated_at from public.coupons where code = 'WELCOME50'),'Cheaper','o16')`), /platform_wide_admin_only/));

console.log("\n── activate / deactivate ──");
ok("deactivate with a reason", (await srv(`select public.ops_offer_action('${M}','ZONEA30','deactivate','Budget used','a1')`)).ok);
await db.exec(`update public.coupons set expires_at = now() - interval '1 minute' where code = 'ZONEA30'`);
ok("activating an expired code → expired", fails(await srv(`select public.ops_offer_action('${M}','ZONEA30','activate','Back on','a2')`), /expired/));
await db.exec(`update public.coupons set expires_at = now() + interval '1 day', max_redemptions = 1 where code = 'ZONEA30';
  insert into public.coupon_redemptions (code, order_id, customer_id, discount) values ('ZONEA30','${O(5)}','${C}',30);`);
ok("activating a used-up code → exhausted", fails(await srv(`select public.ops_offer_action('${M}','ZONEA30','activate','Back on','a3')`), /exhausted/));

console.log("\n── visibility ──");
const codes = async (uid) => (await as("authenticated", uid, `select code from public.coupons order by code`)).rows.map((x) => x.code);
const mCodes = await codes(M), mbCodes = await codes(MB);
ok("the zone-A manager reads zone-A codes and platform-wide ones", mCodes.includes("ZONEA30") && mCodes.includes("WELCOME50") && !mCodes.includes("ZONEB20"), mCodes.join());
ok("the zone-B manager reads no zone-A code, but the platform-wide ones", !mbCodes.includes("ZONEA30") && !mbCodes.includes("SPICE50")
  && mbCodes.includes("WELCOME50") && mbCodes.includes("ZONEB20"), mbCodes.join());
ok("signed-in users cannot write the eligibility lists", fails(await as("authenticated", V,
  `insert into public.coupon_items (code, menu_item_id) values ('SPICE10','${I2}')`), /permission denied/));
ok("clients cannot call ops_upsert_offer", fails(await as("authenticated", M,
  `select public.ops_upsert_offer('${M}','X1',jsonb_build_object('kind','flat','value',1),null,null,'x')`), /permission denied/));

console.log("\n── review fixes: a seasonal campaign's code stays inside its zone and comes back ──");
const iso = (mins) => `'${new Date(Date.now() + mins * 60000).toISOString()}'`;
const win = async (code) => one(`select starts_at, expires_at from public.coupons where code = '${code}'`);
const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(new Date(a) - new Date(b)) < 1000);
for (const [code, extra] of [["SEAS1", `'vendorIds',jsonb_build_array('${R1}')`], ["SEAS2", `'zoneIds',jsonb_build_array('${ZA}')`],
  ["XZONE", `'vendorIds',jsonb_build_array('${R1}','${R2}')`]]) {
  await srv(`select public.ops_upsert_offer('${A}','${code}',jsonb_build_object('kind','flat','value',20,${extra},'expiresAt',${in30d}),null,null,'s-${code}')`);
}
const seasonal = (code, start, end, extra = "") => `jsonb_build_object('kind','seasonal','title','Festival push','zoneId','${ZA}','startsAt',${start},'endsAt',${end},
  'fundedBy','deligro','offerCode','${code}'${extra},
  'banner',jsonb_build_object('headline','Festival','ctaLabel','Order','targetType','external','targetValue','https://example.com'))`;
const welcomeBefore = await win("WELCOME50");
ok("a platform-wide code cannot be linked by a manager", fails(await srv(
  `select public.ops_create_campaign('${M}',${seasonal("WELCOME50", iso(60), iso(600))},'sv1')`), /out_of_scope|platform_wide_admin_only/));
ok("...and its window is untouched", await (async () => { const w = await win("WELCOME50"); return same(w.starts_at, welcomeBefore.starts_at) && same(w.expires_at, welcomeBefore.expires_at); })());
ok("a code that also serves another zone's shop cannot be linked", fails(await srv(
  `select public.ops_create_campaign('${M}',${seasonal("XZONE", iso(60), iso(600))},'sv2')`), /out_of_scope/));
const seas1Before = await win("SEAS1");
const auditsBefore = await audits("offer.update");
r = await srv(`select public.ops_create_campaign('${M}',${seasonal("SEAS1", iso(60), iso(600))},'sv3') as s`);
ok("a code inside the zone links", r.ok, r.msg);
const SC = r.ok ? r.rows[0].s.campaign_id : null;
ok("...it runs for the campaign's window", await (async () => { const w = await win("SEAS1"); return w.starts_at !== null && !same(w.expires_at, seas1Before.expires_at); })());
ok("...the original window is saved on the campaign", await (async () => {
  const c = await one(`select offer_window_saved, offer_prev_starts_at, offer_prev_expires_at from public.campaigns where id = '${SC}'`);
  return c.offer_window_saved === true && same(c.offer_prev_starts_at, seas1Before.starts_at) && same(c.offer_prev_expires_at, seas1Before.expires_at);
})());
ok("...the change is audited as offer.update, with a reason", (await audits("offer.update")) === auditsBefore + 1
  && /Linked to campaign/.test((await one(`select reason from public.ops_audit_log where action = 'offer.update' order by id desc limit 1`)).reason));
ok("...and the change log names the manager", (await one(`select actor_id from public.coupon_changes where code = 'SEAS1' order by id desc limit 1`)).actor_id === M);
ok("a second live campaign cannot take the same code", fails(await srv(
  `select public.ops_create_campaign('${M}',${seasonal("SEAS1", iso(120), iso(700))},'sv4')`), /bad_request/));
r = await srv(`select public.ops_campaign_action('${M}','${SC}','cancel','Not running it','sv5') as s`);
ok("cancelling before start", r.ok, r.msg);
ok("...puts the code's original window back", await (async () => { const w = await win("SEAS1"); return same(w.starts_at, seas1Before.starts_at) && same(w.expires_at, seas1Before.expires_at); })());
ok("...and audits that too", (await audits("offer.update")) === auditsBefore + 2);

r = await srv(`select public.ops_create_campaign('${M}',${seasonal("SEAS1", iso(60), iso(600))},'sv6') as s`);
const SC2 = r.ok ? r.rows[0].s.campaign_id : null;
const seas2Before = await win("SEAS2");
r = await srv(`select public.ops_update_campaign('${M}','${SC2}',(select updated_at from public.campaigns where id = '${SC2}'),
  jsonb_build_object('offerCode','SEAS2'),null,'sv7') as s`);
ok("switching the campaign to another code", r.ok, r.msg);
ok("...the old code is restored and the new one linked", await (async () => {
  const a = await win("SEAS1"), b = await win("SEAS2");
  return same(a.starts_at, seas1Before.starts_at) && same(a.expires_at, seas1Before.expires_at) && b.starts_at !== null && !same(b.expires_at, seas2Before.expires_at);
})());
ok("a code outside the manager's zones cannot be switched in", fails(await srv(`select public.ops_update_campaign('${M}','${SC2}',
  (select updated_at from public.campaigns where id = '${SC2}'),jsonb_build_object('offerCode','ZONEB20'),null,'sv8')`), /out_of_scope|forbidden/));
await db.exec(`update public.campaigns set starts_at = now() - interval '10 minutes' where id = '${SC2}'`);
r = await srv(`select public.ops_campaign_action('${M}','${SC2}','end_now','Stop it','sv9') as s`);
ok("ending a running campaign closes its code now", r.ok && new Date((await win("SEAS2")).expires_at) <= new Date(Date.now() + 1000), r.msg);
ok("...and audits it", (await audits("offer.update")) >= auditsBefore + 5);

console.log("\n── review fixes: vendor consent is used once and bounds the terms ──");
const RQ1 = id(620), RQ2 = id(621), RQ3 = id(622);
await db.exec(`insert into public.marketing_requests (id, restaurant_id, requested_by, kind, title, details, status, budget, proposed_offer) values
  ('${RQ1}','${R1}','${V}','discount_offer','Flat 50','','approved',null,'{"kind":"flat","value":50,"maxRedemptions":100}'),
  ('${RQ2}','${R1}','${V}','discount_offer','Budgeted','','approved',5000,null),
  ('${RQ3}','${R1}','${V}','discount_offer','Percent','','approved',5000,null)`);
const vend = (code, req, terms) => srv(`select public.ops_upsert_offer('${M}','${code}',jsonb_build_object('kind','flat','vendorIds',jsonb_build_array('${R1}'),
  'fundedBy','vendor','requestId','${req}','expiresAt',${in30d},${terms}),null,null,'vc-${code}')`);
ok("richer than the proposal (₹90 against ₹50) → consent_required", fails(await vend("VCON1", RQ1, `'value',90,'maxRedemptions',100`), /consent_required/));
ok("more redemptions than proposed → consent_required", fails(await vend("VCON1", RQ1, `'value',50,'maxRedemptions',200`), /consent_required/));
ok("no redemption cap when one was proposed → consent_required", fails(await vend("VCON1", RQ1, `'value',50`), /consent_required/));
ok("exactly what was proposed is fine", (await vend("VCON1", RQ1, `'value',50,'maxRedemptions',100`)).ok);
ok("...and the request now points at the code", (await one(`select offer_code from public.marketing_requests where id = '${RQ1}'`)).offer_code === "VCON1");
ok("the same consent cannot back a second code → consent_required", fails(await vend("VCON2", RQ1, `'value',50,'maxRedemptions',100`), /consent_required/));
ok("budget 5000 with no redemption cap is unbounded → consent_required", fails(await vend("VCON3", RQ2, `'value',50`), /consent_required/));
ok("...₹50 × 200 uses = ₹10,000 > budget → consent_required", fails(await vend("VCON3", RQ2, `'value',50,'maxRedemptions',200`), /consent_required/));
ok("...₹50 × 100 uses = ₹5,000 is within the budget", (await vend("VCON3", RQ2, `'value',50,'maxRedemptions',100`)).ok);
ok("a percent code with a budget and no discount cap → consent_required", fails(await srv(`select public.ops_upsert_offer('${M}','VCON4',
  jsonb_build_object('kind','percent','value',10,'vendorIds',jsonb_build_array('${R1}'),'fundedBy','vendor','requestId','${RQ3}',
  'maxRedemptions',100,'expiresAt',${in30d}),null,null,'vc-VCON4')`), /consent_required/));

console.log("\n── review fixes: a cancelled order gives its use back ──");
await db.exec(`insert into public.coupons (code, kind, value, max_redemptions, max_per_customer) values ('ONCE1','flat',10,1,1)`);
const o8a = await order(8);
ok("a one-use, one-per-customer code applies", (await apply(o8a, "ONCE1")).ok === true);
ok("...a second order is refused while the first stands", (await apply(await order(9), "ONCE1")).error === "already_used");
await db.exec(`update public.orders set status = 'cancelled' where id = '${o8a}'`);
ok("...but once the first order is cancelled the use is free again", (await apply(await order(10), "ONCE1")).ok === true);
ok("...the redemption row of the cancelled order is kept as a record", (await one(`select count(*)::int as n from public.coupon_redemptions where order_id = '${o8a}'`)).n === 1);
ok("...and the offer list's used count agrees (cancelled orders are not counted)", (await one(`select count(*)::int as n from public.coupon_redemptions r
  join public.orders o on o.id = r.order_id where r.code = 'ONCE1' and o.status <> 'cancelled'`)).n === 1);

done();
