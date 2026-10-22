// The rider migrations in sequence (Phase 8, Review Focus 3): 0081 -> 0087 applied in order on ONE
// in-process Postgres (PGlite) that holds the real baseline (every migration below 0081, with Supabase's
// platform objects stubbed — see rider-sequence-lib.mjs), then every per-migration proof's assertions run
// against that one database, then:
//   * idempotency — every rider migration is applied again, in order, on the now-populated database (this
//     database has no Manager or Partner migration after 0087; on one that does, the re-run rule is
//     "every migration from 0081 through the newest applied, all branches, in number order" — ruling
//     P8-R3 in docs/DATABASE.md — because 0141/0142/0152 narrow what 0081-0087 open), and
//     a catalog snapshot (tables, columns, constraints, indexes, policies, grants, functions with a hash of
//     their source, triggers, enums, views, buckets) must not change;
//   * rollback — on a second database, each migration's header rollback block is run in reverse order
//     (0087 -> 0081); after each one the catalog must equal the snapshot taken before that migration was
//     applied, and after the last one it must equal the baseline. Residues the headers document as
//     manual steps (or that Postgres cannot undo) are listed in KNOWN_RESIDUE and reported, not failed;
//   * docs/SECURITY_AUDIT.md §1's verification queries over the final database.
//
// Usage (PGlite is installed outside the repo; ruling R2):
//   NODE_PATH=F:/dev/tmp/pglite-p5/node_modules \
//     node --import file:///F:/dev/tmp/pglite-p5/register.mjs scripts/qa/sql/rider-migrations-sequence.mjs
//   or: NODE_OPTIONS=--import=file:///F:/dev/tmp/pglite-p5/register.mjs npm run test:rider-migrations
//   Add --verbose to print every passing assertion.
// Nothing here touches a real database.
import { PGlite } from "@electric-sql/pglite";
import {
  baseline, riderMigrations, readMigration, snapshot, diffSnapshots, describeDiff, rollbackBlock,
} from "./rider-sequence-lib.mjs";

const verbose = process.argv.includes("--verbose");
const quiet = !verbose;
let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };
const section = (t) => console.log(`\n══ ${t} ══`);

// The per-migration proofs, in migration order. Each exports proof({ db, ns, quiet }); 0081 also exports
// seed(), the rows that must exist before 0081 runs. ns is the fourth group of every id the proof uses.
const PROOFS = [
  ["0081", "./migration-0081.mjs"],
  ["0082", "./migration-0082.mjs"],
  ["0083", "./migration-0083.mjs"],
  ["0084", "./migration-0084.mjs"],
  ["0085", "./migration-0085.mjs"],
  ["0086", "./migration-0086.mjs"],
  ["0087", "./migration-0087.mjs"],
];

// Catalog differences a rollback block is documented to leave behind. Anything else fails.
const KNOWN_RESIDUE = [
  {
    after: "0081_rider_app_foundation.sql", part: "enums", key: "delivery_status",
    why: "Postgres cannot drop an enum value; 0081's rollback note keeps 'failed' (move such rows to cancelled first).",
  },
  {
    after: "0082_rider_jobs.sql", part: "functions", key: "guard_order_update()",
    why: "0082's rollback keeps its guard_order_update: the list also locks the Partner/Manager columns (re-declaring 0055's would unlock them).",
  },
  {
    after: "0087_support_notifications.sql", part: "constraints", key: "delivery_events.delivery_events_kind_check",
    why: "0087's rollback leaves the 'note' kind as a commented manual step (delete the note rows, then rebuild the check with 0082 §2's list).",
  },
];
const residueFor = (file, d) => KNOWN_RESIDUE.find((r) => r.after === file && r.part === d.part && r.key === d.key);

// A migration that fails inside its own `begin;` leaves the session in an aborted transaction.
const abort = async (d) => { try { await d.exec("rollback"); } catch { /* none open */ } };

const MIGRATIONS = riderMigrations();
const t0 = Date.now();

// ── 1. one database: baseline, 0081's seed, 0081 -> 0087 ─────────────────────────────────────────
section(`baseline (${MIGRATIONS.length} rider migrations: ${MIGRATIONS.map((f) => f.slice(0, 4)).join(", ")})`);
const db = new PGlite();
await baseline(db);
ok("the baseline (every migration below 0081, Supabase platform stubbed) applies", true);
const seed81 = await import("./migration-0081.mjs");
await seed81.seed(db, "0081");
for (const f of MIGRATIONS) {
  let applied = true;
  try { await db.exec(readMigration(f)); } catch (e) { applied = false; console.log(`    ${e.message}`); await abort(db); }
  ok(`${f} applies in order`, applied);
  if (!applied) { console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }
}
const applied = await snapshot(db);

// ── 2. every proof's assertions on that database ──────────────────────────────────────────────────
// platform_settings is one shared row: each proof starts from the values the migrations left and its
// edits are undone afterwards, so no proof sees another's settings.
const settingsCols = (await db.query(`select column_name from information_schema.columns
  where table_schema = 'public' and table_name = 'platform_settings' and column_name <> 'id' order by 1`)).rows.map((r) => r.column_name);
const saveSettings = async () => (await db.query(`select ${settingsCols.map((c) => `"${c}"`).join(", ")} from public.platform_settings`)).rows[0];
const settingsAtStart = await saveSettings();
async function restoreSettings() {
  const sets = settingsCols.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
  await db.query(`update public.platform_settings set ${sets}`, settingsCols.map((c) => settingsAtStart[c]));
}

const perProof = [];
for (const [n, path] of PROOFS) {
  section(`proof ${n} on the shared database`);
  const mod = await import(path);
  let r;
  try { r = await mod.proof({ db, ns: n, quiet }); }
  catch (e) { r = { passed: 0, failed: 1 }; console.log(`  FAIL proof ${n} threw: ${e.stack ?? e.message}`); }
  // Leave the session as the migration owner, whatever the proof did last.
  await db.exec(`reset role; select set_config('test.uid', '', false), set_config('test.jwt', '', false);`);
  await restoreSettings();
  // Incentive rules are global: a rule left on would award the next proof's riders.
  await db.exec(`update public.rider_incentive_rules set active = false where active`);
  perProof.push([n, r.passed, r.failed]);
  ok(`proof ${n}: ${r.passed} assertions passed, ${r.failed} failed`, r.failed === 0);
}

// ── 3. SECURITY_AUDIT §1 verification queries over the final database ──────────────────────────────
section("docs/SECURITY_AUDIT.md §1 queries");
const riderTables = [
  "rider_status", "rider_shifts", "rider_profiles", "delivery_events", "delivery_exceptions",
  "rider_earnings", "rider_incentive_rules", "rider_incentive_awards", "rider_adjustments", "rider_payouts",
  "rider_ratings", "cash_deposits", "cash_disputes", "cash_reminders", "rider_documents",
  "rider_payout_accounts", "rider_payout_accounts_staged", "rider_profile_change_requests",
  "support_tickets", "support_messages", "user_notifications", "announcements",
];
// Deny-all on purpose (service role only): RLS on, no policy.
const NO_POLICY_BY_DESIGN = ["cash_reminders", "rider_payout_accounts", "rider_payout_accounts_staged"];
const rls = (await db.query(`select c.relname, c.relrowsecurity as rls_on, count(p.polname)::int as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_policy p on p.polrelid = c.oid
   where n.nspname = 'public' and c.relkind = 'r' group by 1, 2`)).rows;
for (const t of riderTables) {
  const row = rls.find((x) => x.relname === t);
  ok(`${t}: RLS on, ${NO_POLICY_BY_DESIGN.includes(t) ? "no policy (deny-all by design)" : "at least one policy"}`,
    row?.rls_on === true && (NO_POLICY_BY_DESIGN.includes(t) ? row.policies === 0 : row.policies > 0));
}
const sensitive = (await db.query(`select table_name, column_name, grantee from information_schema.column_privileges
   where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type = 'SELECT'
     and (column_name ~* 'bank|ifsc|pan_|gst|upi|password|secret|token|api_key|account_number|holder_name|licence_number'
          or column_name ~* 'owner_email|owner_mobile'
          or (table_name = 'rider_documents' and column_name = 'number')
          or (table_name = 'rider_profile_change_requests' and column_name = 'new_value'))`)).rows;
const sensitiveRider = sensitive.filter((x) => riderTables.includes(x.table_name));
ok("no sensitive column of a rider table is SELECTable by anon/authenticated", sensitiveRider.length === 0);
for (const x of sensitiveRider) console.log(`    ${x.table_name}.${x.column_name} -> ${x.grantee}`);
for (const x of sensitive.filter((y) => !riderTables.includes(y.table_name))) {
  console.log(`  note pre-existing (not a rider table): ${x.table_name}.${x.column_name} SELECT -> ${x.grantee}`);
}
// Functions created by the rider migrations: everything in public that the baseline did not have.
const baselineDb = new PGlite();
await baseline(baselineDb);
const before = (await snapshot(baselineDb)).functions;
await baselineDb.close();
const created = Object.keys(applied.functions).filter((k) => !(k in before));
const fnRows = (await db.query(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as k, p.prosecdef,
       coalesce(array_to_string(p.proconfig, ','), '') as cfg, has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
       pg_get_function_result(p.oid) as result
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)).rows
  .filter((x) => created.includes(x.k));
ok(`the rider migrations create ${fnRows.length} functions; every one pins search_path`,
  fnRows.length > 0 && fnRows.every((x) => /search_path=/.test(x.cfg)));
for (const x of fnRows.filter((y) => !/search_path=/.test(y.cfg))) console.log(`    no search_path: ${x.k}`);
const definerAnon = fnRows.filter((x) => x.prosecdef && x.anon_exec);
ok("no SECURITY DEFINER function of the rider migrations is executable by anon", definerAnon.length === 0);
for (const x of definerAnon) console.log(`    anon may execute ${x.k}`);
const triggerAuth = fnRows.filter((x) => x.result === "trigger" && (x.anon_exec || x.auth_exec));
ok("no trigger function of the rider migrations keeps EXECUTE for anon/authenticated (0054)", triggerAuth.length === 0);
for (const x of triggerAuth) console.log(`    EXECUTE still granted: ${x.k}`);

// ── 4. idempotency on the populated database ──────────────────────────────────────────────────────
section("idempotency: every rider migration again, in order, on the populated database");
for (const f of MIGRATIONS) {
  let again = true;
  try { await db.exec(readMigration(f)); } catch (e) { again = false; console.log(`    ${e.message}`); await abort(db); }
  ok(`${f} re-applies`, again);
}
const reapplied = await snapshot(db);
const drift = diffSnapshots(applied, reapplied);
ok(`the catalog is unchanged by the re-run (${Object.values(applied).reduce((s, p) => s + Object.keys(p).length, 0)} objects compared)`, drift.length === 0);
for (const d of drift) console.log(`    ${describeDiff(d)}`);
await db.close();

// ── 5. rollback blocks, newest first, on a second database ─────────────────────────────────────────
section("rollback: each header block in reverse order (0087 -> 0081)");
const rb = new PGlite();
await baseline(rb);
const steps = [await snapshot(rb)];
for (const f of MIGRATIONS) { await rb.exec(readMigration(f)); steps.push(await snapshot(rb)); }
for (let i = MIGRATIONS.length - 1; i >= 0; i--) {
  const f = MIGRATIONS[i];
  const block = rollbackBlock(f);
  if (!block) { ok(`${f} has a rollback block`, false); continue; }
  let rolled = true;
  try { await rb.exec(block); } catch (e) { rolled = false; console.log(`    ${e.message}`); await abort(rb); }
  ok(`${f}: the rollback block runs`, rolled);
  if (!rolled) break;
  const diffs = diffSnapshots(steps[i], await snapshot(rb));
  const unexpected = diffs.filter((d) => !residueFor(f, d) && !KNOWN_RESIDUE.some((r) => r.part === d.part && r.key === d.key
    && MIGRATIONS.indexOf(r.after) > i));
  ok(`${f}: the catalog is back to its state before ${f.slice(0, 4)}${diffs.length > unexpected.length ? " (documented residue aside)" : ""}`,
    unexpected.length === 0);
  for (const d of unexpected) console.log(`    ${describeDiff(d)}`);
  for (const d of diffs.filter((x) => residueFor(f, x))) console.log(`  note residue: ${d.part} ${d.key} — ${residueFor(f, d).why}`);
  if (f.startsWith("0082")) {
    const src = (await rb.query(`select prosrc from pg_proc where proname = 'guard_order_update'`)).rows[0]?.prosrc ?? "";
    ok("...and after 0082's rollback guard_order_update still locks the sibling columns (preparing_at, invoice_no, invoice_at, zone_id)",
      ["preparing_at", "invoice_no", "invoice_at", "zone_id"].every((c) => src.includes(`'${c}'`)));
  }
}
const final = diffSnapshots(steps[0], await snapshot(rb));
const finalUnexpected = final.filter((d) => !KNOWN_RESIDUE.some((r) => r.part === d.part && r.key === d.key));
ok("after all seven the catalog equals the baseline (documented residue aside)", finalUnexpected.length === 0);
for (const d of finalUnexpected) console.log(`    ${describeDiff(d)}`);
let again = true;
try { for (const f of MIGRATIONS) await rb.exec(readMigration(f)); } catch (e) { again = false; console.log(`    ${e.message}`); }
ok("...and 0081 -> 0087 apply again after the rollback", again);
await rb.close();

section("summary");
for (const [n, p, f] of perProof) console.log(`  proof ${n}: ${p} passed, ${f} failed`);
console.log(`\n${passed} passed, ${failed} failed  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
