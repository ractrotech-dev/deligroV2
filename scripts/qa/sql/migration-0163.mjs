// Runs migration 0163 (campaign attribution, performance, marketing report) in
// PGlite on top of growth-base.mjs + 0160–0162. The attribution cases are the
// ones scripts/qa/manager-marketing-rules.ts asserts for the TypeScript rule.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0163.mjs
import { growthBase, harness, readMigration, id, IDS } from "./growth-base.mjs";

const { db, ZA, ZB } = await growthBase();
const { A, V, C, R1, R2 } = IDS;
const C2 = id(41), C3 = id(42);
const DISH = id(521), OTHER_DISH = id(522);
const CAMP = id(801), SPON = id(802), BAN = id(803), BCAMP = id(804);

await db.exec(`
  create or replace function public.ops_js_round(x double precision) returns bigint language sql immutable as $$ select floor(x + 0.5)::bigint $$;
  insert into public.profiles (id, role, full_name) values ('${C2}','customer','Two'), ('${C3}','customer','Three');
  insert into public.menu_items (id, restaurant_id, name, price) values ('${DISH}','${R1}','Promo Roll',200), ('${OTHER_DISH}','${R1}','Lassi',100);
  insert into public.coupons (code, kind, value) values ('DIWALI50','flat',50);
`);
for (const f of ["0160_marketing_campaigns.sql", "0161_offers_eligibility_changes.sql", "0162_manager_customers.sql", "0163_campaign_performance.sql"]) {
  await db.exec(readMigration(f));
}
const { ok, as, fails, srv, one, done } = harness(db);

// A featured campaign at Spice Hub, 10 days ago → 10 days ahead, with DIWALI50 linked.
await db.exec(`
  insert into public.campaigns (id, kind, title, zone_id, restaurant_id, starts_at, ends_at, funded_by, slot_position, offer_code, created_by, status)
    values ('${CAMP}','featured_store','Top slot','${ZA}','${R1}', now() - interval '10 days', now() + interval '10 days','deligro',1,'DIWALI50','${A}','in_progress'),
           ('${SPON}','sponsored_product','Push rolls','${ZA}','${R1}', now() - interval '10 days', now() + interval '10 days','deligro',null,null,'${A}','in_progress');
  insert into public.campaign_vendors values ('${CAMP}','${R1}'), ('${SPON}','${R1}');
  insert into public.campaign_items values ('${SPON}','${DISH}');
`);
const T = (h) => `now() - interval '${h} hours'`;
async function order(oid, customer, hoursAgo, extra = {}) {
  const status = extra.status ?? "delivered", code = extra.code ? `'${extra.code}'` : "null", rid = extra.rid ?? R1;
  await db.exec(`insert into public.orders (id, customer_id, restaurant_id, status, total, created_at, payment_status, coupon_code)
    values ('${oid}','${customer}','${rid}','${status}',${extra.total ?? 400}, ${T(hoursAgo)},'paid',${code});
    insert into public.order_items (order_id, menu_item_id, name, qty, price) values ('${oid}','${extra.dish ?? OTHER_DISH}','x',1,${extra.total ?? 400});`);
}
const click = async (campaign, customer, hoursAgo) =>
  db.exec(`insert into public.campaign_events (campaign_id, kind, customer_id, created_at) values ('${campaign}','click','${customer}', ${T(hoursAgo)})`);

// C: clicked 23 h before ordering (counted). C2: clicked 25 h before (not). C3: clicked after ordering (not).
await click(CAMP, C, 47); await order(id(901), C, 24);
await click(CAMP, C2, 50); await order(id(902), C2, 25);
await order(id(903), C3, 30); await click(CAMP, C3, 29);
// C again: a cancelled order after a fresh click (not); then a code order with a click (once).
await click(CAMP, C, 6); await order(id(904), C, 5, { status: "cancelled" });
await order(id(905), C, 4, { code: "DIWALI50", total: 300 });
// An order before the window, with the code (not).
await order(id(906), C, 24 * 12, { code: "DIWALI50" });
// Sponsored: C clicked; one order without the dish (not), one with it (counted).
await click(SPON, C2, 3); await order(id(907), C2, 2); await order(id(908), C2, 1, { dish: DISH, total: 200 });
await db.exec(`insert into public.campaign_events (campaign_id, kind, created_at) values ('${CAMP}','impression', now() - interval '1 hour'),
  ('${CAMP}','impression', now() - interval '1 hour');
  insert into public.coupon_redemptions (code, order_id, customer_id, discount, created_at) values ('DIWALI50','${id(905)}','${C}',50, now() - interval '4 hours');`);

console.log("\n── attribution (same cases as the TypeScript rule) ──");
const attributed = async (camp) => (await srv(`select order_id from public._ops_campaign_attributed('${camp}', now() - interval '30 days', now())`)).rows.map((r) => r.order_id);
const featured = await attributed(CAMP);
ok("a click 23 h before the order at the shop → counted", featured.includes(id(901)));
ok("25 h before → not", !featured.includes(id(902)));
ok("a click after the order → not", !featured.includes(id(903)));
ok("a cancelled order → not", !featured.includes(id(904)));
ok("code (+ click) on one order counts once", featured.filter((x) => x === id(905)).length === 1);
ok("before the window, even with the code → not", !featured.includes(id(906)));
const spon = await attributed(SPON);
ok("sponsored: an order without a campaign dish → not", !spon.includes(id(907)));
ok("sponsored: with the dish → counted", spon.includes(id(908)) && spon.length === 1);

console.log("\n── headlines and performance ──");
let r = await srv(`select * from public.ops_campaign_headlines(array['${CAMP}','${SPON}']::uuid[])`);
const h = r.ok ? Object.fromEntries(r.rows.map((x) => [x.campaign_id, x])) : {};
ok("headline: 2 impressions, 4 clicks, 2 orders, ₹700", h[CAMP]?.impressions === 2 && h[CAMP]?.clicks === 4
  && h[CAMP]?.attributed_orders === 2 && h[CAMP]?.attributed_sales === 700, JSON.stringify(h[CAMP]) + (r.msg ?? ""));
r = await srv(`select public.ops_campaign_performance('${CAMP}', now() - interval '3 days', now()) as p`);
const p = r.ok ? r.rows[0].p : {};
ok("performance over 3 days: the code redemption and its ₹50", p.redemptions === 1 && p.discountGiven === 50, JSON.stringify(p).slice(0, 300));
ok("...daily sales add up to the total", p.daily?.reduce((s, d) => s + d.attributedSales, 0) === p.attributedSales && p.attributedSales === 700);
ok("...Before / During for a featured shop", p.comparison && p.comparison.duringOrders >= 2 && typeof p.comparison.beforeOrders === "number");
ok("a client cannot read performance", fails(await as("authenticated", A, `select public.ops_campaign_performance('${CAMP}', now() - interval '1 day', now())`), /permission denied/));

console.log("\n── marketing report ──");
await db.exec(`insert into public.banners (id, name, headline, status, starts_at, ends_at, kind) values
  ('${BAN}','Campaign banner','Hi','active', now() - interval '1 day', now() + interval '5 days','internal');
  insert into public.campaigns (id, kind, title, zone_id, starts_at, ends_at, funded_by, banner_id, created_by, budget)
    values ('${BCAMP}','banner','Diwali banner','${ZA}', now() - interval '1 day', now() + interval '5 days','vendor','${BAN}','${A}', 5000);`);
r = await srv(`select public.ops_report_marketing(null, null, now() - interval '30 days', now() + interval '1 day', null) as m`);
const m = r.ok ? r.rows[0].m : {};
ok("the report lists campaigns with budget and funding", m.campaigns?.some((x) => x.id === BCAMP && x.budget === 5000 && x.fundedBy === "vendor"), r.msg);
ok("...and the campaign's own banner is not listed again as a banner", !m.banners?.some((x) => x.id === BAN));
ok("...featured attributed sales ₹700 in the report too", m.campaigns?.find((x) => x.id === CAMP)?.attributedSales === 700);

console.log("\n── review fixes: a headline works each figure out once ──");
const headlines = readMigration("0163_campaign_performance.sql");
const hbody = headlines.slice(headlines.indexOf("function public.ops_campaign_headlines"), headlines.indexOf("function public.ops_campaign_performance"));
const calls = (re) => (hbody.match(re) ?? []).length;
ok("ops_campaign_headlines reads a campaign's events once and its attributed orders once",
  calls(/_ops_campaign_events\(/g) === 1 && calls(/_ops_campaign_attributed\(/g) === 1, `${calls(/_ops_campaign_events\(/g)} / ${calls(/_ops_campaign_attributed\(/g)}`);

done();
