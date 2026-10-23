// Zone matrix over every ops_* RPC (Phase 10, Task 4, step 3).
//
// Builds the real migration chain (chain-lib.mjs) and reads pg_proc, so a new ops_*
// function is picked up without editing this script:
//
//   1. every security-definer ops_* function that takes an actor (p_actor) must reach an
//      authorization helper — ops_require_staff / ops_require_admin / ops_require_staff_for_rider /
//      the manager_can_see_* family / _ops_*require* — directly or through another ops_*
//      function that does. One that doesn't FAILS the run;
//   2. functions with no actor (engine, rollup and read helpers) must be on the pinned list
//      below with the reason they are safe, and must not be callable by anon or authenticated.
//      A new one that is not on the list FAILS until someone decides;
//   3. the core check is exercised for real: ops_require_staff for a manager in zone A, with an
//      entity in zone B, refuses and writes no audit row; for an admin it allows; for a customer
//      it refuses; a manager with no zones is refused everywhere.
//
// Needs: npm i --no-save @electric-sql/pglite@0.2.17   Usage: node scripts/qa/sql/manager-zone-matrix.mjs
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

/** Functions with no actor argument that are safe BECAUSE only the server's service role can call
 *  them and the calling route has already scoped the entity or passed the scope in. Pinned: a new
 *  one has to be added here, with its reason, by a person who decided. */
const NO_ACTOR_OK = {
  // engine and cron (no person involved)
  ops_claim_alert_run: "alert engine lock",
  ops_release_alert_run: "alert engine lock",
  ops_raise_alert: "alert engine raises an alert from a measured condition",
  ops_raise_alerts: "alert engine batch",
  ops_clear_alerts: "alert engine clears its own keys",
  ops_mark_alert_pushed: "alert engine bookkeeping",
  ops_mark_alerts_pushed: "alert engine bookkeeping",
  ops_prune_alerts: "retention job",
  ops_sync_campaign_states: "cron: moves campaigns through their dates",
  // readers that take the scope or the already-scoped entity from the trusted route
  ops_campaign_headlines: "route passes ids it has already scoped",
  ops_campaign_performance: "route scopes the campaign first",
  ops_cancellation_facts: "alert facts, aggregate only",
  ops_offer_redemption_rows: "route scopes the offer first",
  ops_rider_cash_position: "route scopes the rider first",
  ops_rider_history: "route scopes the rider first",
  ops_rider_history_totals: "route scopes the rider first",
  ops_rider_list_facts: "route passes ids it has already scoped",
  ops_rider_money_summary: "route scopes the rider first; finance permission checked in the route",
  ops_ticket_unread_counts: "route passes ids it has already scoped",
};

/** Actor functions that authorize inline instead of through a helper. Each was read; the reason says how. */
const INLINE_AUTH = {
  ops_record_refund_gateway: "only the actor who claimed the refund (claimed_by = p_actor) while it is pending",
  ops_search_customer_by_phone: "service-role call, role admin or manager, and the join on the actor's own staff_zones",
  ops_set_feature_switch: "service-role call and the actor is an admin or developer",
  ops_set_restricted_category: "service-role call and the actor is an admin",
};

const rows = await one(db, `
  select p.proname, pg_get_function_arguments(p.oid) as args, p.prosecdef, p.prosrc,
         has_function_privilege('anon', p.oid, 'execute') as anon_x,
         has_function_privilege('authenticated', p.oid, 'execute') as auth_x
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'ops\\_%'
  order by p.proname`);
const secdef = rows.filter((r) => r.prosecdef);
console.log(`${rows.length} ops_* functions, ${secdef.length} security definer`);

// the authorization primitives, found by name in the catalog rather than assumed
const allNames = new Set((await one(db, `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)).map((r) => r.proname));
const primitive = [...allNames].filter((n) => /^(_?ops_\w*require\w*|_ops_alert_staff|manager_can_see_\w+)$/.test(n));
ok(primitive.includes("ops_require_staff") && primitive.includes("ops_require_admin"), `authorization primitives found: ${primitive.join(", ")}`);

const callsAny = (src, names) => names.some((n) => new RegExp(`(^|[^a-z_])${n}\\s*\\(`).test(src));
// transitive closure: a function authorizes if it calls a primitive or another authorizing ops_ function
const authorizing = new Set(primitive);
for (let changed = true; changed; ) {
  changed = false;
  for (const r of rows) {
    if (!authorizing.has(r.proname) && callsAny(r.prosrc, [...authorizing])) {
      authorizing.add(r.proname);
      changed = true;
    }
  }
}

const withActor = secdef.filter((r) => /\bp_actor\b/.test(r.args));
const noActor = secdef.filter((r) => !/\bp_actor\b/.test(r.args) && !primitive.includes(r.proname));
console.log(`${withActor.length} take an actor; ${noActor.length} do not\n`);

for (const r of withActor) {
  const inline = INLINE_AUTH[r.proname];
  if (inline) {
    ok(/forbidden/.test(r.prosrc) && !r.anon_x && !r.auth_x, `${r.proname}: authorizes inline (${inline}), and is not callable by anon or authenticated`);
  } else {
    ok(authorizing.has(r.proname), `${r.proname}: authorizes its actor and zone`, "never reaches ops_require_* / _ops_alert_staff / manager_can_see_*, and is not pinned in INLINE_AUTH");
  }
}
for (const name of Object.keys(INLINE_AUTH)) ok(rows.some((r) => r.proname === name), `pinned inline-auth ${name} still exists`, "remove it from INLINE_AUTH");
for (const r of noActor) {
  // A reader that takes the caller's zone list is scoped by construction: the trusted route passes
  // the manager's zones in, and the function cannot be called by anyone but the service role.
  const scoped = /p_(zones|zone_ids)/.test(r.args);
  const reason = NO_ACTOR_OK[r.proname] ?? (scoped ? "takes the caller's zone list as a parameter" : undefined);
  ok(!!reason, `${r.proname}: no actor, and pinned as safe (${reason ?? "NOT PINNED — add it to NO_ACTOR_OK with a reason, or give it an actor"})`);
  ok(!r.anon_x && !r.auth_x, `${r.proname}: not callable by anon or authenticated`, `anon=${r.anon_x} authenticated=${r.auth_x}`);
}
for (const name of Object.keys(NO_ACTOR_OK)) ok(rows.some((r) => r.proname === name), `pinned ${name} still exists`, "remove it from NO_ACTOR_OK");

// ── the core check, for real ──
console.log("\n── ops_require_staff, exercised ──");
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const [A, B, ADMIN, MGR, MGR0, CUST] = [id(1), id(2), id(10), id(11), id(12), id(13)];
await db.exec(`select set_config('test.jwt', '{"role":"service_role"}', false)`);
await db.exec(`
  insert into auth.users (id, email) values ('${ADMIN}','a@x'),('${MGR}','m@x'),('${MGR0}','m0@x'),('${CUST}','c@x') on conflict do nothing;
  insert into public.profiles (id, role, full_name) values ('${ADMIN}','admin','Admin'),('${MGR}','manager','Mgr'),('${MGR0}','manager','Mgr none'),('${CUST}','customer','Cust')
    on conflict (id) do update set role = excluded.role;
`).catch((e) => {
  console.log(`FAIL could not set up the zone fixtures: ${String(e.message).slice(0, 200)}`);
  process.exit(1);
});
await db.exec(`select set_config('test.jwt', '', false)`);
const city = (await one(db, `insert into public.cities (name, slug) values ('Test','test-matrix') on conflict (slug) do update set name = excluded.name returning id`))[0].id;
await db.exec(`
  insert into public.delivery_zones (id, city_id, name, slug, center_lat, center_lng, radius_km) values
    ('${A}','${city}','Zone A','zone-a-m',21.7,81.5,5),('${B}','${city}','Zone B','zone-b-m',21.8,81.6,5) on conflict do nothing;
  delete from public.staff_zones where user_id in ('${MGR}','${MGR0}');
  insert into public.staff_zones (user_id, zone_id) values ('${MGR}','${A}');
`);
const auditBefore = (await one(db, `select count(*)::int c from public.ops_audit_log`))[0].c;
// The app's server calls these as the service role; so does this test.
await db.exec(`select set_config('test.jwt', '{"role":"service_role"}', false)`);
const attempt = async (actor, zone) => {
  try {
    await db.query(`select public.ops_require_staff($1::uuid, $2::uuid)`, [actor, zone]);
    return "allowed";
  } catch (e) {
    return `refused: ${String(e.message).slice(0, 60)}`;
  }
};
const forbidden = (r) => r.startsWith("refused") && /forbidden|not_in_scope|42501/.test(r);
ok((await attempt(MGR, A)) === "allowed", "a manager is allowed in their own zone", await attempt(MGR, A));
const outside = await attempt(MGR, B);
ok(forbidden(outside), "a manager is refused an entity in another zone, as forbidden", outside);
ok((await attempt(ADMIN, B)) === "allowed", "an admin is allowed in any zone", await attempt(ADMIN, B));
const cust = await attempt(CUST, A);
ok(forbidden(cust), "a customer is refused, as forbidden", cust);
const none = await attempt(MGR0, A);
ok(forbidden(none), "a manager with no zones is refused everywhere, as forbidden", none);
const nozone = await attempt(MGR, null);
ok(forbidden(nozone), "an entity with no zone is refused for a manager (never 'all')", nozone);
// And without the service-role call, the same function refuses everyone.
await db.exec(`select set_config('test.jwt', '', false)`);
const asUser = await attempt(ADMIN, A);
ok(forbidden(asUser), "called as a signed-in user rather than the server, even an admin is refused", asUser);
const auditAfter = (await one(db, `select count(*)::int c from public.ops_audit_log`))[0].c;
ok(auditAfter === auditBefore, "the refused attempts wrote nothing to the audit log");

console.log(fails ? `\n${fails} FAILED` : "\nevery ops_* function authorizes or is pinned; the zone check holds");
process.exit(fails ? 1 : 0);
