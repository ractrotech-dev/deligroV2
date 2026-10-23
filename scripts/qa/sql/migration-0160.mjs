// Runs migration 0160 (marketing requests decided once, campaigns, tracking) in
// PGlite on top of growth-base.mjs. Needs: npm i --no-save @electric-sql/pglite@0.2.17
// Usage: node scripts/qa/sql/migration-0160.mjs
import { growthBase, harness, readMigration, id, IDS } from "./growth-base.mjs";

const { db, ZA, ZB } = await growthBase();
const { A, M, MB, V, C, R1, R2 } = IDS;
const ITEM = id(501), ITEM_B = id(502);
const REQ = id(601), REQ_B = id(602), REQ_DISC = id(603), REQ_OTHER = id(604), REQ_BAN = id(605);

await db.exec(`
  insert into public.menu_items (id, restaurant_id, name, price) values ('${ITEM}','${R1}','Paneer Roll',120), ('${ITEM_B}','${R2}','Thali',150);
  insert into public.marketing_requests (id, restaurant_id, requested_by, kind, title, details) values
    ('${REQ}','${R1}','${V}','featured','Diwali top slot','Slot 2 for a week'),
    ('${REQ_B}','${R2}','${V}','banner','Saja banner',''),
    ('${REQ_DISC}','${R1}','${V}','discount_offer','₹50 off',''),
    ('${REQ_BAN}','${R1}','${V}','banner','Home banner','');
`);
await db.exec(readMigration("0160_marketing_campaigns.sql"));
const { ok, as, fails, srv, one, done } = harness(db);
const iso = (mins) => `'${new Date(Date.now() + mins * 60000).toISOString()}'`;
const audits = async (action) => (await one(`select count(*)::int as n from public.ops_audit_log where action = '${action}'`)).n;

console.log("\n── requests: zone and access ──");
ok("an existing request gets its shop's zone", (await one(`select zone_id from public.marketing_requests where id = '${REQ}'`)).zone_id === ZA);
await db.exec(`update public.marketing_requests set zone_id = '${ZB}' where id = '${REQ}'`);
ok("a writer cannot move a request to another zone", (await one(`select zone_id from public.marketing_requests where id = '${REQ}'`)).zone_id === ZA);
ok("a signed-in vendor cannot insert a request directly", fails(await as("authenticated", V,
  `insert into public.marketing_requests (restaurant_id, requested_by, kind, title, details) values ('${R1}','${V}','banner','x x x','')`),
  /permission denied/));
const seen = async (uid) => (await as("authenticated", uid, `select id from public.marketing_requests order by title`)).rows.map((r) => r.id);
ok("the zone-A manager sees zone-A requests only", (await seen(M)).length === 3 && !(await seen(M)).includes(REQ_B));
ok("the zone-B manager sees only the zone-B request", JSON.stringify(await seen(MB)) === JSON.stringify([REQ_B]));
ok("a customer sees none", (await seen(C)).length === 0);

console.log("\n── ops_create_marketing_request ──");
let r = await srv(`select public.ops_create_marketing_request('${M}','${R1}','other','Leaflets at the station','Print run',null,null,500,'{}',null,'mr1') as s`);
ok("a manager records a request on the vendor's behalf", r.ok && r.rows[0].s.status === "pending", r.msg);
const OTHER = r.ok ? r.rows[0].s.request_id : null;
ok("...source 'ops', audited", (await one(`select source from public.marketing_requests where id = '${OTHER}'`)).source === "ops"
  && (await audits("marketing.request_create")) === 1);
r = await srv(`select public.ops_create_marketing_request('${M}','${R1}','other','Leaflets at the station','Print run',null,null,500,'{}',null,'mr1') as s`);
ok("replaying returns the same request", r.ok && r.rows[0].s.request_id === OTHER && r.rows[0].s.replayed === true, r.msg);
ok("a dish from another shop → out_of_scope", fails(await srv(
  `select public.ops_create_marketing_request('${M}','${R1}','sponsored_product','Push rolls','',null,null,null,array['${ITEM_B}']::uuid[],null,'mr2')`), /out_of_scope/));
ok("a zone-B manager cannot record for a zone-A shop", fails(await srv(
  `select public.ops_create_marketing_request('${MB}','${R1}','other','Leaflets','',null,null,null,'{}',null,'mr3')`), /forbidden/));

console.log("\n── decide ──");
ok("reject without remarks → reason_required", fails(await srv(
  `select public.ops_decide_marketing_request('${M}','${REQ_BAN}','reject','pending',null,null,null,'d0')`), /reason_required/));
const feat = (slot, start, end, extra = "") => `jsonb_build_object('title','Diwali top','startsAt',${start},'endsAt',${end},
  'fundedBy','vendor','slotPosition',${slot},'budget',3000${extra})`;
r = await srv(`select public.ops_decide_marketing_request('${M}','${REQ}','approve','pending','Looks good',${feat(2, iso(60), iso(60 * 24 * 7))},null,'d1') as s`);
ok("approving a featured request creates its campaign", r.ok && r.rows[0].s.status === "approved" && r.rows[0].s.campaign_id, r.msg);
const CAMP = r.ok ? r.rows[0].s.campaign_id : null;
ok("...two audit rows: request_approve + (decide writes the campaign inside it)", (await audits("marketing.request_approve")) === 1);
ok("...the request's timeline has the approval", (await one(`select count(*)::int as n from public.marketing_request_updates where request_id = '${REQ}' and status = 'approved'`)).n === 1);
ok("...the campaign is in zone A, for the shop, slot 2", await (async () => {
  const c = await one(`select zone_id, restaurant_id, slot_position, kind, request_id from public.campaigns where id = '${CAMP}'`);
  return c.zone_id === ZA && c.restaurant_id === R1 && c.slot_position === 2 && c.kind === "featured_store" && c.request_id === REQ;
})());
r = await srv(`select public.ops_decide_marketing_request('${M}','${REQ}','approve','pending','Looks good',${feat(2, iso(60), iso(60 * 24 * 7))},null,'d1') as s`);
ok("replaying the decision changes nothing", r.ok && r.rows[0].s.replayed === true && (await one(`select count(*)::int as n from public.campaigns`)).n === 1, r.msg);
ok("deciding again with a new id → stale", fails(await srv(
  `select public.ops_decide_marketing_request('${M}','${REQ}','approve','pending',null,${feat(3, iso(60), iso(120))},null,'d2')`), /stale/));

console.log("\n── campaigns ──");
const deligro = (slot, start, end) => `jsonb_build_object('kind','featured_store','title','Our pick','zoneId','${ZA}',
  'vendorIds',jsonb_build_array('${R1}'),'startsAt',${start},'endsAt',${end},'fundedBy','deligro','slotPosition',${slot})`;
ok("an overlapping campaign on slot 2 → slot_taken", fails(await srv(
  `select public.ops_create_campaign('${M}',${deligro(2, iso(120), iso(240))},'c1')`), /slot_taken/));
r = await srv(`select public.ops_create_campaign('${M}',${deligro(2, iso(60 * 24 * 8), iso(60 * 24 * 9))},'c2') as s`);
ok("the same slot after the first ends is fine", r.ok, r.msg);
ok("the same slot in zone B is a different slot", (await srv(`select public.ops_create_campaign('${MB}',
  jsonb_build_object('kind','featured_store','title','Saja pick','zoneId','${ZB}','vendorIds',jsonb_build_array('${R2}'),
  'startsAt',${iso(120)},'endsAt',${iso(240)},'fundedBy','deligro','slotPosition',2),'c3')`)).ok);
ok("vendor-funded without a request → consent_required", fails(await srv(`select public.ops_create_campaign('${M}',
  jsonb_build_object('kind','sponsored_product','title','Push rolls','zoneId','${ZA}','vendorIds',jsonb_build_array('${R1}'),
  'itemIds',jsonb_build_array('${ITEM}'),'startsAt',${iso(60)},'endsAt',${iso(120)},'fundedBy','vendor'),'c4')`), /consent_required/));
ok("a vendor outside the campaign's zone → out_of_scope", fails(await srv(`select public.ops_create_campaign('${M}',
  jsonb_build_object('kind','sponsored_product','title','Push thali','zoneId','${ZA}','vendorIds',jsonb_build_array('${R2}'),
  'itemIds',jsonb_build_array('${ITEM_B}'),'startsAt',${iso(60)},'endsAt',${iso(120)},'fundedBy','deligro'),'c5')`), /out_of_scope/));
ok("a zone-B manager cannot create in zone A", fails(await srv(`select public.ops_create_campaign('${MB}',${deligro(5, iso(60), iso(120))},'c6')`), /forbidden/));
ok("an end before the start → bad_request", fails(await srv(`select public.ops_create_campaign('${M}',${deligro(6, iso(120), iso(60))},'c7')`), /bad_request/));

const bannerIn = (start, end) => `jsonb_build_object('kind','banner','title','Diwali banner','zoneId','${ZA}',
  'vendorIds',jsonb_build_array('${R1}'),'startsAt',${start},'endsAt',${end},'fundedBy','vendor','requestId','${REQ_BAN}',
  'banner',jsonb_build_object('headline','Diwali feast','ctaLabel','Order','targetType','restaurant','targetValue','spice-hub'))`;
ok("a banner campaign for an unapproved request → consent_required", fails(await srv(
  `select public.ops_create_campaign('${M}',${bannerIn(iso(60), iso(600))},'b0')`), /consent_required/));
await db.exec(`update public.marketing_requests set status = 'approved' where id = '${REQ_BAN}'`);
r = await srv(`select public.ops_create_campaign('${M}',${bannerIn(iso(60), iso(600))},'b1') as s`);
ok("with the request approved, the banner campaign is created", r.ok, r.msg);
const BCAMP = r.ok ? r.rows[0].s.campaign_id : null;
const ban = r.ok ? await one(`select b.* from public.banners b join public.campaigns c on c.banner_id = b.id where c.id = '${BCAMP}'`) : {};
ok("...it owns an active sponsored banner for the window, zone-targeted", ban.status === "active" && ban.kind === "sponsored"
  && ban.sponsor_name === "Spice Hub" && Array.isArray(ban.target_zones) && ban.target_zones[0] === "bemetara" && ban.starts_at !== null);
ok("...and the request now points at it", (await one(`select campaign_id from public.marketing_requests where id = '${REQ_BAN}'`)).campaign_id === BCAMP);

console.log("\n── update, cancel, end ──");
const upd = (await one(`select updated_at from public.campaigns where id = '${BCAMP}'`)).updated_at;
r = await srv(`select public.ops_update_campaign('${M}','${BCAMP}','${upd.toISOString()}',
  jsonb_build_object('banner', jsonb_build_object('headline','Diwali feast — 2 days left')),null,'u1') as s`);
ok("editing the banner's headline before start", r.ok && (await one(`select headline from public.banners where id = '${ban.id}'`)).headline === "Diwali feast — 2 days left", r.msg);
ok("an old updated_at → stale", fails(await srv(`select public.ops_update_campaign('${M}','${BCAMP}','${upd.toISOString()}',
  jsonb_build_object('budget', 10),null,'u2')`), /stale/));
ok("changing kind → locked_field", fails(await srv(`select public.ops_update_campaign('${M}','${BCAMP}',
  (select updated_at from public.campaigns where id = '${BCAMP}'), jsonb_build_object('kind','seasonal'),null,'u3')`), /locked_field/));
r = await srv(`select public.ops_campaign_action('${M}','${BCAMP}','cancel','Vendor withdrew','x1') as s`);
ok("cancelling before start", r.ok && r.rows[0].s.status === "cancelled", r.msg);
ok("...archives its banner in the same transaction", (await one(`select status from public.banners where id = '${ban.id}'`)).status === "archived");
ok("...and sends its request to rejected with 'Cancelled:'", await (async () => {
  const m = await one(`select status, admin_remarks from public.marketing_requests where id = '${REQ_BAN}'`);
  return m.status === "rejected" && /^Cancelled: /.test(m.admin_remarks);
})());
ok("ending a campaign that hasn't started → invalid_transition", fails(await srv(
  `select public.ops_campaign_action('${M}','${CAMP}','end_now','Too early','x2')`), /invalid_transition/));

// A running campaign: started an hour ago.
await db.exec(`update public.campaigns set starts_at = now() - interval '1 hour' where id = '${CAMP}'`);
ok("after start, changing startsAt → locked_field", fails(await srv(`select public.ops_update_campaign('${M}','${CAMP}',
  (select updated_at from public.campaigns where id = '${CAMP}'), jsonb_build_object('startsAt', ${iso(30)}),'Moving it','u4')`), /locked_field/));
ok("after start, an edit without a reason → reason_required", fails(await srv(`select public.ops_update_campaign('${M}','${CAMP}',
  (select updated_at from public.campaigns where id = '${CAMP}'), jsonb_build_object('budget', 4000),null,'u5')`), /reason_required/));
ok("after start, the budget with a reason is fine", (await srv(`select public.ops_update_campaign('${M}','${CAMP}',
  (select updated_at from public.campaigns where id = '${CAMP}'), jsonb_build_object('budget', 4000),'Vendor topped up','u6')`)).ok);

console.log("\n── scheduler ──");
r = await srv(`select public.ops_sync_campaign_states(now()) as s`);
ok("the sync moves a started campaign to in_progress", r.ok && (await one(`select status from public.campaigns where id = '${CAMP}'`)).status === "in_progress", r.msg);
ok("...and its request too, with a system timeline row", (await one(`select status from public.marketing_requests where id = '${REQ}'`)).status === "in_progress"
  && (await one(`select count(*)::int as n from public.marketing_request_updates where request_id = '${REQ}' and actor_role = 'system'`)).n === 1);
r = await srv(`select public.ops_sync_campaign_states(now() + interval '8 days') as s`);
ok("at the end it completes, and the request completes", (await one(`select status from public.campaigns where id = '${CAMP}'`)).status === "completed"
  && (await one(`select status from public.marketing_requests where id = '${REQ}'`)).status === "completed");
ok("a signed-in user cannot run the scheduler", fails(await as("authenticated", M, `select public.ops_sync_campaign_states(now())`), /permission denied/));

console.log("\n── other requests, events, discount stub ──");
ok("an 'other' request moves approved → in_progress by hand", await (async () => {
  await db.exec(`update public.marketing_requests set status = 'approved' where id = '${OTHER}'`);
  return (await srv(`select public.ops_progress_marketing_request('${M}','${OTHER}','in_progress','Printing','p1')`)).ok;
})());
ok("a request with a campaign cannot be moved by hand", fails(await srv(
  `select public.ops_progress_marketing_request('${M}','${REQ}','completed',null,'p3')`), /invalid_transition/));
await db.exec(`insert into public.marketing_requests (id, restaurant_id, requested_by, kind, title, details) values ('${REQ_OTHER}','${R1}','${V}','banner','Later banner','')`);
r = await srv(`select public.ops_decide_marketing_request('${A}','${REQ_OTHER}','approve','pending','OK, schedule later',null,null,'d8') as s`);
ok("approve now, schedule later: a banner request approved without a campaign", r.ok && r.rows[0].s.status === "approved" && r.rows[0].s.campaign_id === null, r.msg);
ok("...it cannot jump straight to completed", fails(await srv(
  `select public.ops_progress_marketing_request('${A}','${REQ_OTHER}','completed',null,'p4a')`), /invalid_transition/));
ok("...and moves along by hand", (await srv(`select public.ops_progress_marketing_request('${A}','${REQ_OTHER}','in_progress','Designing','p4')`)).ok);
ok("a signed-in user cannot write campaign events", fails(await as("authenticated", C,
  `insert into public.campaign_events (campaign_id, kind) values ('${CAMP}','click')`), /permission denied/));
ok("the zone-B manager sees no zone-A campaign", (await as("authenticated", MB, `select id from public.campaigns where zone_id = '${ZA}'`)).rows.length === 0);
ok("approving a discount offer before 0161 → offers_not_ready", fails(await srv(
  `select public.ops_decide_marketing_request('${M}','${REQ_DISC}','approve','pending',null,null,'{"code":"X50"}'::jsonb,'d9')`), /offers_not_ready/));
ok("banner_events carries customer_id", (await one(`select count(*)::int as n from information_schema.columns
  where table_name = 'banner_events' and column_name = 'customer_id'`)).n === 1);

console.log("\n── review fixes: campaign edits cannot cross zones or skip consent ──");
const REQ_P = id(610), REQ_SP = id(611), REQ_BUD = id(612);
await db.exec(`insert into public.marketing_requests (id, restaurant_id, requested_by, kind, title, details, status, budget) values
  ('${REQ_P}','${R1}','${V}','banner','Pending banner','','pending',null),
  ('${REQ_SP}','${R1}','${V}','sponsored_product','Push rolls','','approved',null),
  ('${REQ_BUD}','${R1}','${V}','banner','Budgeted banner','','approved',1000)`);
const reqRow = async (rid) => one(`select status, campaign_id, decided_by from public.marketing_requests where id = '${rid}'`);
const bnr = (reqId, funded, budget, title = "Review banner") => `jsonb_build_object('kind','banner','title','${title}','zoneId','${ZA}',
  'vendorIds',jsonb_build_array('${R1}'),'startsAt',${iso(60)},'endsAt',${iso(600)},'fundedBy','${funded}',
  ${reqId ? `'requestId','${reqId}',` : ""}${budget === null ? "" : `'budget',${budget},`}
  'banner',jsonb_build_object('headline','Feast','ctaLabel','Order','targetType','restaurant','targetValue','spice-hub'))`;

r = await srv(`select public.ops_create_campaign('${M}',${deligro(7, iso(60 * 24 * 20), iso(60 * 24 * 21))},'rv0') as s`);
const XC = r.ok ? r.rows[0].s.campaign_id : null;
const tok = async () => (await one(`select updated_at from public.campaigns where id = '${XC}'`)).updated_at.toISOString();
ok("(setup) a deligro campaign to try edits on", r.ok, r.msg);
ok("moving a campaign to another zone (with that zone's shop) → locked_field", fails(await srv(`select public.ops_update_campaign('${M}','${XC}','${await tok()}',
  jsonb_build_object('zoneId','${ZB}','vendorIds',jsonb_build_array('${R2}')),null,'rv1')`), /locked_field/));
ok("...and the campaign stays in zone A", (await one(`select zone_id from public.campaigns where id = '${XC}'`)).zone_id === ZA);
ok("switching a campaign to vendor-funded with no request → consent_required", fails(await srv(`select public.ops_update_campaign('${M}','${XC}','${await tok()}',
  jsonb_build_object('fundedBy','vendor'),null,'rv2')`), /consent_required/));
ok("an unknown key → locked_field", fails(await srv(`select public.ops_update_campaign('${M}','${XC}','${await tok()}',
  jsonb_build_object('createdBy','${A}'),null,'rv3')`), /locked_field/));

console.log("\n── review fixes: a request links one campaign, in its own zone ──");
ok("a zone-A manager linking a zone-B request → out_of_scope", fails(await srv(
  `select public.ops_create_campaign('${M}',${bnr(REQ_B, "deligro", null)},'rv4')`), /out_of_scope/));
ok("...and the zone-B request is untouched", await (async () => { const q = await reqRow(REQ_B); return q.status === "pending" && q.campaign_id === null; })());
ok("a pending request cannot be linked", fails(await srv(`select public.ops_create_campaign('${M}',${bnr(REQ_P, "deligro", null)},'rv5')`), /bad_request/));
ok("...and stays pending", (await reqRow(REQ_P)).status === "pending");
ok("a request that already has a campaign cannot be linked again", fails(await srv(
  `select public.ops_create_campaign('${M}',${deligro(8, iso(60 * 24 * 30), iso(60 * 24 * 31)).replace("'fundedBy','deligro'", `'requestId','${REQ}','fundedBy','deligro'`)},'rv6')`), /bad_request/));
ok("a request of a different kind cannot be linked", fails(await srv(`select public.ops_create_campaign('${M}',${bnr(REQ_SP, "deligro", null)},'rv7')`), /bad_request/));
ok("the decision's author survives later links", (await reqRow(REQ)).decided_by === M);

console.log("\n── review fixes: a vendor pays no more than it asked to ──");
ok("a vendor-funded campaign over the request's budget → consent_required", fails(await srv(
  `select public.ops_create_campaign('${M}',${bnr(REQ_BUD, "vendor", 5000)},'rv8')`), /consent_required/));
ok("...with no budget at all (unbounded) → consent_required", fails(await srv(
  `select public.ops_create_campaign('${M}',${bnr(REQ_BUD, "vendor", null)},'rv9')`), /consent_required/));
r = await srv(`select public.ops_create_campaign('${M}',${bnr(REQ_BUD, "vendor", 1000)},'rv10') as s`);
ok("within the request's budget it is created", r.ok, r.msg);
ok("the consent is used up: a second campaign from the same request → consent_required", fails(await srv(
  `select public.ops_create_campaign('${M}',${bnr(REQ_BUD, "vendor", 500, "Second banner")},'rv11')`), /consent_required/));

done();
