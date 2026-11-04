/**
 * QA — the edit tokens of offers and campaigns, in PGlite against the real
 * migrations. A token is read the way the app reads it: the row as PostgREST
 * sends it (Postgres's own JSON), through the contract's serialiser, through
 * JSON, and back to the audited RPC. An edit made with that value must succeed;
 * a value from before someone else's edit must still be refused.
 *
 * Also proves the campaign edits the app makes for funding and offer codes.
 *
 * Needs: npm i --no-save @electric-sql/pglite@0.2.17
 * Usage: npx tsx --conditions=react-server scripts/qa/manager-edit-tokens.ts
 */
import { exactTimestamp } from "../../src/lib/ops/exact-timestamp";
import { serializeOffer, type OfferRow } from "../../src/lib/ops/offer-contract";
import { nextCursor, serializeCampaignDetail, type CampaignRow, type Names } from "../../src/lib/ops/marketing-contract";
import { decodeCursor } from "../../src/lib/ops/order-query";
// @ts-expect-error a plain .mjs test helper with no types
import { growthBase, harness, readMigration, id, IDS } from "./sql/growth-base.mjs";

async function main() {
const now = new Date();
const { db, ZA } = await growthBase();
const { M, R1, V } = IDS as { M: string; R1: string; V: string };
await db.exec(`create or replace function public.ops_js_round(x double precision) returns bigint language sql immutable as $$ select floor(x + 0.5)::bigint $$;`);
for (const f of ["0160_marketing_campaigns.sql", "0161_offers_eligibility_changes.sql", "0162_manager_customers.sql",
  "0163_campaign_performance.sql", "0164_offer_customer_reads.sql"]) await db.exec(readMigration(f));
const { ok, fails, srv, one, done } = harness(db) as {
  ok: (name: string, pass: unknown, extra?: string) => void;
  fails: (r: unknown, re: RegExp) => boolean;
  srv: (sql: string) => Promise<{ ok: boolean; rows: Record<string, unknown>[]; msg?: string }>;
  one: (sql: string) => Promise<Record<string, unknown>>;
  done: () => void;
};

console.log("\n── exactTimestamp ──");
ok("PostgREST's form keeps every digit", exactTimestamp("2026-11-03T10:11:12.123456+00:00") === "2026-11-03T10:11:12.123456Z");
ok("Postgres's text form too", exactTimestamp("2026-11-03 10:11:12.123456+00") === "2026-11-03T10:11:12.123456Z");
ok("another offset becomes UTC, digits intact", exactTimestamp("2026-11-03T15:41:12.123456+05:30") === "2026-11-03T10:11:12.123456Z");
ok("no sub-millisecond part reads as toISOString does", exactTimestamp("2026-10-20T08:00:00+00:00") === "2026-10-20T08:00:00.000Z");
ok("...and so does an ISO value already in that form", exactTimestamp("2026-10-20T08:00:00.000Z") === "2026-10-20T08:00:00.000Z");
ok("trailing zeros go, the instant stays", exactTimestamp("2026-11-03T10:11:12.1234+00:00") === "2026-11-03T10:11:12.1234Z"
  && exactTimestamp("2026-11-03T10:11:12.12+00:00") === "2026-11-03T10:11:12.120Z");
ok("the contract's checks can read it", !Number.isNaN(Date.parse("2026-11-03T10:11:12.123456Z")));

// Exactly what PostgREST does to a row: Postgres's own JSON, then JSON.parse.
const asPostgrest = async <T>(sql: string): Promise<T> => {
  const r = await db.query(`select to_json(x)::text as j from (${sql}) x`) as { rows: { j: string }[] };
  return JSON.parse(r.rows[0].j) as T;
};
const toJsonAndBack = (v: string) => JSON.parse(JSON.stringify({ v })).v as string;
const sub = (v: string) => v.replace(/\.(\d{3})\d*Z$/, ".$1Z");

console.log("\n── an offer's edit token ──");
await db.exec(`insert into public.coupons (code, kind, value, min_order, restaurant_id, funded_by, expires_at) values
  ('SPICE10','percent',10,0,'${R1}','platform', now() + interval '30 days');
  alter table public.coupons disable trigger touch_coupon;
  update public.coupons set updated_at = '2026-11-03 10:11:12.123456+00' where code = 'SPICE10';
  alter table public.coupons enable trigger touch_coupon;`);
const offerNames = { shop: () => "Spice Hub", zone: () => "Zone", person: () => "Vik", item: () => "Roll" };
const readOfferToken = async () => {
  const row = await asPostgrest<OfferRow>(`select * from public.ops_offer_rows(array['${ZA}']::uuid[], array['SPICE10'])`);
  return toJsonAndBack(serializeOffer(row, offerNames, now).updatedAt);
};
const editOffer = (token: string, value: number, cid: string) => srv(`select public.ops_upsert_offer('${M}','SPICE10',
  jsonb_build_object('value',${value}), '${token}', 'Budget changed', '${cid}') as s`);

const offerToken = await readOfferToken();
ok("the contract keeps the microseconds", offerToken === "2026-11-03T10:11:12.123456Z", offerToken);
ok("a token cut to milliseconds is what used to be sent, and is refused", fails(await editOffer(sub(offerToken), 11, "offer-cut-1"), /stale/));
let r = await editOffer(offerToken, 12, "offer-good-1");
ok("an edit with the value read from the contract succeeds", r.ok, r.msg);
ok("...and changed the offer", Number((await one(`select value from public.coupons where code = 'SPICE10'`)).value) === 12);
ok("the same token again is really old now: refused", fails(await editOffer(offerToken, 13, "offer-old-1"), /stale/));
ok("...and changed nothing", Number((await one(`select value from public.coupons where code = 'SPICE10'`)).value) === 12);
const offerFresh = await readOfferToken();
ok("the token read after the edit is a new one", offerFresh !== offerToken);
r = await editOffer(offerFresh, 14, "offer-good-2");
ok("reloading and trying again works", r.ok, r.msg);

console.log("\n── a campaign's edit token, funding and offer code ──");
const at = (mins: number) => `'${new Date(Date.now() + mins * 60_000).toISOString()}'`;
// Shared funding needs the vendor's consent: an approved request of the same kind.
const REQ = id(801);
await db.exec(`insert into public.marketing_requests (id, restaurant_id, requested_by, kind, title, details, status) values
  ('${REQ}','${R1}','${V}','festival_campaign','Diwali feast','','approved');`);
r = await srv(`select public.ops_create_campaign('${M}', jsonb_build_object('kind','seasonal','title','Diwali feast','zoneId','${ZA}',
  'vendorIds',jsonb_build_array('${R1}'),'startsAt',${at(120)},'endsAt',${at(600)},'fundedBy','shared','vendorSharePct',40,'requestId','${REQ}',
  'banner',jsonb_build_object('headline','Diwali feast','ctaLabel','Order','targetType','restaurant','targetValue','spice-hub')),'camp-1') as s`);
ok("a shared-funding seasonal campaign is created", r.ok, r.msg);
const CAMP = r.ok ? (r.rows[0].s as { campaign_id: string }).campaign_id : id(9);
await db.exec(`update public.campaigns set updated_at = '2026-11-03 10:11:12.654321+00' where id = '${CAMP}';`);
const names = { shop: () => "Spice Hub", zone: () => ({ id: ZA, name: "Zone" }), person: () => ({ name: "Vik", role: "manager" }),
  item: () => "Roll" } as unknown as Names;
const readCampaignToken = async () => {
  const row = await asPostgrest<CampaignRow>(`select * from public.campaigns where id = '${CAMP}'`);
  return toJsonAndBack(serializeCampaignDetail(row, [R1], [], null, names, now,
    { impressions: 0, clicks: 0, attributedOrders: 0, attributedSales: 0 }).updatedAt);
};
const editCampaign = (token: string, changes: string, cid: string) =>
  srv(`select public.ops_update_campaign('${M}','${CAMP}','${token}', ${changes}, null, '${cid}') as s`);

const campToken = await readCampaignToken();
ok("the contract keeps the microseconds", campToken === "2026-11-03T10:11:12.654321Z", campToken);
ok("a token cut to milliseconds is refused", fails(await editCampaign(sub(campToken), `jsonb_build_object('title','Diwali feast two')`, "camp-cut"), /stale/));
r = await editCampaign(campToken, `jsonb_build_object('title','Diwali feast two')`, "camp-good");
ok("an edit with the value read from the contract succeeds", r.ok, r.msg);
ok("the same token again is really old now: refused", fails(await editCampaign(campToken, `jsonb_build_object('title','Diwali feast x')`, "camp-old"), /stale/));

let token = await readCampaignToken();
ok("leaving shared funding without clearing the share is what the app used to send: refused",
  fails(await editCampaign(token, `jsonb_build_object('fundedBy','deligro')`, "camp-fund-bad"), /bad_request/));
r = await editCampaign(token, `jsonb_build_object('fundedBy','deligro','vendorSharePct',null)`, "camp-fund-ok");
ok("leaving shared funding with the share cleared succeeds", r.ok, r.msg);
let row = await one(`select funded_by, vendor_share_pct from public.campaigns where id = '${CAMP}'`);
ok("...and both changed", row.funded_by === "deligro" && row.vendor_share_pct === null);

await db.exec(`insert into public.coupons (code, kind, value, restaurant_id, funded_by, expires_at) values
  ('FEAST20','flat',20,'${R1}','platform', now() + interval '30 days');`);
token = await readCampaignToken();
r = await editCampaign(token, `jsonb_build_object('offerCode','FEAST20')`, "camp-code-on");
ok("naming an offer code succeeds", r.ok, r.msg);
ok("...and links it", (await one(`select offer_code from public.campaigns where id = '${CAMP}'`)).offer_code === "FEAST20");
token = await readCampaignToken();
r = await editCampaign(token, `jsonb_build_object('offerCode',null)`, "camp-code-off");
ok("clearing the offer code with an explicit null succeeds", r.ok, r.msg);
row = await one(`select offer_code from public.campaigns where id = '${CAMP}'`);
ok("...and unlinks it", row.offer_code === null);

console.log("\n── keyset cursors keep the microseconds too ──");
const rows = [{ created_at: "2026-11-03T10:11:12.654321+00:00", id: id(1) }, { created_at: "2026-11-03T10:11:12.5+00:00", id: id(2) }];
const cursor = decodeCursor(nextCursor(rows, 1)!);
ok("a campaign or request page's cursor", cursor?.createdAt === "2026-11-03T10:11:12.654321Z", JSON.stringify(cursor));

done();
}

main().catch((e) => { console.error(e); process.exit(1); });
