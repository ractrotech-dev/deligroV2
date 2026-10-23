// Runs migration 0164 (offer and customer reads) in PGlite on top of growth-base.mjs + 0160–0163.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0164.mjs
import { growthBase, harness, readMigration, id, IDS } from "./growth-base.mjs";

const { db, ZA, ZB } = await growthBase();
const { A, M, C, R1, R2 } = IDS;
await db.exec(`create or replace function public.ops_js_round(x double precision) returns bigint language sql immutable as $$ select floor(x + 0.5)::bigint $$;`);
for (const f of ["0160_marketing_campaigns.sql", "0161_offers_eligibility_changes.sql", "0162_manager_customers.sql",
  "0163_campaign_performance.sql", "0164_offer_customer_reads.sql"]) await db.exec(readMigration(f));
const { ok, as, fails, srv, done } = harness(db);
const O1 = id(931), O2 = id(932), O3 = id(933);

await db.exec(`
  insert into public.coupons (code, kind, value, restaurant_id, funded_by) values ('SPICE10','percent',10,'${R1}','vendor'),
    ('ALL20','flat',20,null,'platform'), ('SAJA5','flat',5,'${R2}','vendor');
  insert into public.coupon_zones (code, zone_id) values ('ALL20','${ZA}');
  insert into public.orders (id, customer_id, restaurant_id, status, total, payment_status, created_at, address) values
    ('${O1}','${C}','${R1}','delivered',300,'paid', now() - interval '3 days', '{"label":"Home","line":"12 Gali, Station Road, Bemetara"}'),
    ('${O2}','${C}','${R1}','delivered',500,'paid', now() - interval '1 day', '{"label":"Home","line":"12 Gali, Station Road, Bemetara"}'),
    ('${O3}','${C}','${R1}','cancelled',200,'paid', now() - interval '2 hours', null);
  insert into public.coupon_redemptions (code, order_id, customer_id, discount, created_at) values
    ('SPICE10','${O1}','${C}',30, now() - interval '3 days'), ('SPICE10','${O2}','${C}',50, now() - interval '1 day'),
    ('SPICE10','${O3}','${C}',20, now() - interval '2 hours');
`);

console.log("\n── offers ──");
let r = await srv(`select * from public.ops_offer_rows(array['${ZA}']::uuid[])`);
const codes = r.ok ? Object.fromEntries(r.rows.map((x) => [x.code, x])) : {};
ok("zone A sees SPICE10 and ALL20, not SAJA5", codes.SPICE10 && codes.ALL20 && !codes.SAJA5, r.msg ?? Object.keys(codes).join());
ok("SPICE10: 2 redemptions on live orders, ₹80 (the cancelled one is left out)", codes.SPICE10?.redemptions === 2 && codes.SPICE10?.discount_given === 80);
ok("...and is wholly in zone A's scope", codes.SPICE10?.in_scope === true);
r = await srv(`select * from public.ops_offer_rows(null)`);
ok("admin (null zones) sees all three", r.ok && r.rows.length >= 3);
r = await srv(`select * from public.ops_offer_redemption_rows('SPICE10', now() - interval '7 days', now())`);
ok("redemption rows: three, the cancelled one flagged, the first one marked first", r.ok && r.rows.length === 3
  && r.rows.find((x) => x.order_id === O3).cancelled === true && r.rows.find((x) => x.order_id === O1).first_order === true
  && r.rows.find((x) => x.order_id === O2).first_order === false, r.msg);

console.log("\n── customer facts ──");
r = await srv(`select public.ops_customer_facts('${C}', array['${ZA}']::uuid[]) as f`);
const f = r.ok ? r.rows[0].f : {};
ok("2 counted orders, ₹800, 1 cancelled", f.orders === 2 && f.spent === 800 && f.cancelled === 1, JSON.stringify(f));
ok("address lines for the server, deduplicated", Array.isArray(f.addressLines) && f.addressLines.length === 1);
r = await srv(`select public.ops_customer_facts('${C}', array['${ZB}']::uuid[]) as f`);
ok("in zone B the same customer has no orders", r.ok && r.rows[0].f.orders === 0);
ok("clients cannot call these", fails(await as("authenticated", M, `select * from public.ops_offer_rows(null)`), /permission denied/));

console.log("\n── review fixes: the offers list is filtered, counted and paged in SQL ──");
// 12 more codes in zone A at distinct update times, in every state.
const mk = (code, extra = "") => `insert into public.coupons (code, kind, value, restaurant_id, funded_by, ${extra.split("|")[0] || "active"}) values ('${code}','flat',5,'${R1}','vendor', ${extra.split("|")[1] || "true"});`;
await db.exec(`
  ${mk("OFF1", "active|false")}
  ${mk("EXP1", "expires_at|now() - interval '1 day'")}
  ${mk("SOON1", "starts_at|now() + interval '2 days'")}
  ${mk("USED1", "max_redemptions|1")}
  ${["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"].map((c) => mk("LIVE" + c)).join("\n")}
`);
const O4 = id(934);
await db.exec(`insert into public.orders (id, customer_id, restaurant_id, status, total, payment_status, created_at)
    values ('${O4}','${C}','${R1}','delivered',100,'paid', now() - interval '4 days');
  insert into public.coupon_redemptions (code, order_id, customer_id, discount) values ('USED1','${O4}','${C}',5);
  update public.coupons set updated_at = now() - (random() * interval '30 days') where code like 'LIVEA%';
  update public.coupons set updated_at = now() - interval '40 days' where code in ('LIVEA1','LIVEA2');`);
const pg = async (state, after = ["null", "null"], limit = 5, extra = "null, null, null") =>
  (await srv(`select public.ops_offer_page(array['${ZA}']::uuid[], ${state}, ${extra}, ${after[0]}, ${after[1]}, ${limit}) as p`));
let p = await pg("'all'");
ok("the page answers rows and the counts by state", p.ok && Array.isArray(p.rows[0].p.rows) && p.rows[0].p.counts.inactive >= 1, p.msg);
const c0 = p.ok ? p.rows[0].p.counts : {};
ok("...counts: one switched off, one expired, one scheduled, one used up", c0.inactive === 1 && c0.expired === 1 && c0.scheduled === 1 && c0.exhausted === 1, JSON.stringify(c0));
ok("...a page holds at most limit + 1 rows (so the caller can tell there is more)", p.ok && p.rows[0].p.rows.length === 6);
p = await pg("'expired'");
ok("a state filter keeps only that state", p.ok && p.rows[0].p.rows.length === 1 && p.rows[0].p.rows[0].code === "EXP1");
ok("...and the counts do not shrink to it", p.ok && p.rows[0].p.counts.inactive === 1 && p.rows[0].p.counts.scheduled === 1);
// Walk every page of the live codes; no row twice, none missed, in updated-at order.
const seen = [];
let after = ["null", "null"];
for (let i = 0; i < 20; i++) {
  const pageRes = await pg("'active'", after, 3);
  const rows = pageRes.rows[0].p.rows;
  seen.push(...rows.slice(0, 3).map((x) => x.code));
  if (rows.length <= 3) break;
  const last = rows[2];
  after = [`'${new Date(last.updated_at).toISOString()}'`, `'${last.code}'`];
}
const allLive = (await srv(`select code from public.ops_offer_rows(array['${ZA}']::uuid[]) where active and expires_at is null and starts_at is null and max_redemptions is null`)).rows.map((x) => x.code);
ok("paging three at a time visits every live code once", seen.length === allLive.length && new Set(seen).size === seen.length && allLive.every((c) => seen.includes(c)), { seen, allLive });
p = await pg("'all'", ["null", "null"], 5, `null, null, 'live'`);
ok("a text filter matches code and label", p.ok && p.rows[0].p.rows.every((x) => /live/i.test(x.code)) && p.rows[0].p.rows.length === 6);
p = await srv(`select public.ops_offer_page(array['${ZB}']::uuid[], 'all', null, null, null, null, null, 5) as p`);
ok("a scope sees only its own offers (zone B has none of these)", p.ok && !p.rows[0].p.rows.some((x) => x.code === "OFF1"));
ok("clients cannot call the page", fails(await as("authenticated", M, `select public.ops_offer_page(null, 'all', null, null, null, null, null, 5)`), /permission denied/));

done();
