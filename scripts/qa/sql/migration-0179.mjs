// Runs migration 0179 (guest catalog read fix) in PGlite on top of manager-base.mjs.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0179.mjs
// Reproduces the live bug — a guest (anon) reading restaurants hits 0145's
// "restaurants — manager read" policy, whose manager_can_see_zone() 0141 had
// revoked from anon — and proves 0179 fixes it without widening anything.
import { managerBase, readMigration, IDS } from "./manager-base.mjs";

const { db } = await managerBase();
const { A, M, MB, C, R1 } = IDS;
await db.exec(`
  alter table public.restaurants add column if not exists approved boolean not null default true;
  alter table public.restaurants enable row level security;
  create policy "restaurants — public read" on public.restaurants for select using (approved);
  create policy "restaurants — manager read" on public.restaurants for select using (public.manager_can_see_zone(zone_id));
  grant select on public.restaurants to anon, authenticated;
  update public.restaurants set approved = false where id = '${IDS.R2}';
`);

let passed = 0, failed = 0;
const ok = (n, c, extra) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}${!c && extra ? `\n         ${extra}` : ""}`); };
async function as(role, uid, sql) {
  await db.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false); select set_config('test.jwt','{}',false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec("reset role; select set_config('test.uid','',false);"); }
}

let r = await as("anon", null, "select id from public.restaurants");
ok("before 0179: a guest cannot read the shops (the live bug)", !r.ok && /permission denied for function manager_can_see_zone/.test(r.msg), r.msg);
await db.exec(readMigration("0179_guest_catalog_read_fix.sql"));
r = await as("anon", null, "select id from public.restaurants");
ok("after: a guest reads the approved shops", r.ok && r.rows.length === 1 && r.rows[0].id === R1, r.msg ?? JSON.stringify(r.rows));
ok("...and still not an unapproved one", r.ok && !r.rows.some((x) => x.id === IDS.R2));
ok("the function still says no for a guest", (await as("anon", null, `select public.manager_can_see_zone(null) as x`)).rows?.[0]?.x === false);
r = await as("authenticated", MB, "select id from public.restaurants");
ok("a zone-B manager still sees their unapproved zone-B shop", r.ok && r.rows.some((x) => x.id === IDS.R2), r.msg);
r = await as("authenticated", M, "select id from public.restaurants");
ok("a zone-A manager does not see it", r.ok && !r.rows.some((x) => x.id === IDS.R2));
ok("a customer reads approved shops", ((await as("authenticated", C, "select id from public.restaurants")).rows ?? []).length === 1);
ok("an admin sees both", ((await as("authenticated", A, "select id from public.restaurants")).rows ?? []).length === 2);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
