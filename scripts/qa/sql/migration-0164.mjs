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

done();
