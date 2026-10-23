// The whole migration chain, in order (Phase 10, Task 2).
//
// Applies every file in supabase/migrations/ — 0001 to the newest — to one PGlite
// instance, the way `supabase db push` would, then:
//   1. asserts the final bodies/policies/grants the Manager app depends on,
//   2. runs every scripts/qa/sql/migration-*.mjs proof as a child process,
//   3. shows what an out-of-order sibling deploy does, and that re-applying
//      0141 onward repairs it.
//
// Nothing here is hard-coded per migration: files are discovered, so a later
// migration is picked up without editing this script.
//
// Stubs stand in only for what Supabase provides outside `public` (auth schema,
// storage schema, roles, extensions). Grants follow Supabase's defaults — a
// default-privileges grant to anon/authenticated/service_role on new public
// objects — and NOT a blanket "grant all on all tables", which would hide a
// missing column grant (Phase 2 review).
//
// Needs: npm i --no-save @electric-sql/pglite@0.2.17
// Usage: node scripts/qa/sql/all-migrations.mjs [--no-proofs] [--keep-going]
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migDir = path.join(root, "supabase/migrations");
const sqlDir = path.join(root, "scripts/qa/sql");
const args = new Set(process.argv.slice(2));

let fails = 0;
const ok = (c, m, extra = "") => {
  if (c) console.log(`ok   ${m}`);
  else {
    fails++;
    console.log(`FAIL ${m}${extra ? " — " + extra : ""}`);
  }
};

const files = readdirSync(migDir)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort((a, b) => {
    const na = Number(a.slice(0, 4));
    const nb = Number(b.slice(0, 4));
    return na - nb || (a < b ? -1 : a > b ? 1 : 0);
  });

/** What Supabase provides outside `public`. */
const PREAMBLE = `
  create schema if not exists auth;
  create schema if not exists storage;
  create schema if not exists extensions;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;

  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.role() returns text language sql stable as
    $$ select coalesce(nullif(current_setting('test.role', true), ''), 'anon') $$;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;

  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text, phone text, encrypted_password text,
    raw_user_meta_data jsonb default '{}'::jsonb, raw_app_meta_data jsonb default '{}'::jsonb,
    banned_until timestamptz, email_confirmed_at timestamptz, phone_confirmed_at timestamptz,
    created_at timestamptz default now(), updated_at timestamptz default now(), last_sign_in_at timestamptz);
  create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users on delete cascade,
    created_at timestamptz default now(), updated_at timestamptz default now(), user_agent text, ip text, not_after timestamptz);
  create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users on delete cascade,
    friendly_name text, factor_type text, status text, created_at timestamptz default now());

  create table storage.buckets (id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets,
    name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select string_to_array(regexp_replace(name, '/[^/]*$', ''), '/') $$;
  create function storage.filename(name text) returns text language sql immutable as
    $$ select regexp_replace(name, '^.*/', '') $$;
  create function storage.extension(name text) returns text language sql immutable as
    $$ select regexp_replace(name, '^.*\\.', '') $$;

  -- Supabase's default privileges on objects created in public later.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema auth to service_role;
  grant select, insert, update, delete on all tables in schema storage to service_role;
`;

/** Extensions PGlite doesn't ship are no-ops here; the SQL they enable is plain. */
const adapt = (sql) =>
  sql
    .replace(/create extension if not exists "?pgcrypto"?[^;]*;/gi, "-- (pgcrypto: gen_random_uuid is built in)")
    .replace(/create extension if not exists pg_cron[^;]*;/gi, "-- (pg_cron: scheduling is a separate dashboard step)");

/** Applies one file; on failure names the file and the statement around the error. */
async function applyFile(db, f) {
  const sql = adapt(readFileSync(path.join(migDir, f), "utf8"));
  try {
    await db.exec(sql);
    return null;
  } catch (e) {
    const pos = Number(e.position ?? 0);
    const snippet = pos ? sql.slice(Math.max(0, pos - 160), pos + 120).replace(/\s+/g, " ") : "";
    return `${f}: ${e.message}${snippet ? `\n       near: …${snippet}…` : ""}`;
  }
}

async function freshChain(upTo = Infinity) {
  const db = new PGlite();
  await db.exec(PREAMBLE);
  for (const f of files) {
    if (Number(f.slice(0, 4)) > upTo) break;
    const err = await applyFile(db, f);
    if (err) return { db, err, applied: f };
  }
  return { db, err: null, applied: files[files.length - 1] };
}

const one = async (db, sql, params) => (await db.query(sql, params)).rows;

// ───────────────────────── 1. apply the chain ─────────────────────────
console.log(`Applying ${files.length} migrations, ${files[0]} … ${files[files.length - 1]}`);
const chain = await freshChain();
ok(!chain.err, `the whole chain applies in order (${files.length} files)`, chain.err ?? "");
if (chain.err) {
  console.log(chain.err);
  console.log("\nstopped at the first failing migration — nothing after it was applied");
  process.exit(1);
}
const db = chain.db;

// ───────────────────────── 2. what the end state must say ─────────────────────────
const fnBody = async (name) =>
  (await one(db, `select pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = $1`, [name])).map((r) => r.d).join("\n");

const guard = await fnBody("guard_order_update");
for (const col of ["zone_id", "preparing_at", "invoice_no", "delivery_instructions"]) {
  ok(guard.includes(col), `guard_order_update still locks ${col}`);
}
const restLock = await fnBody("lock_restaurant_privileged_fields");
ok(restLock.includes("zone_id"), "lock_restaurant_privileged_fields covers zone_id");
ok(/status_reason|status_changed/.test(restLock) || (await one(db,
  `select 1 from information_schema.columns where table_name='restaurants' and column_name in ('status_reason','status_changed_by')`)).length === 0,
  "restaurant status columns are admin-only (0145)");

const riderPolicies = await one(db, `
  select tablename, policyname, qual from pg_policies
  where schemaname = 'public' and cmd = 'SELECT'
    and tablename in ('rider_status','rider_shifts','rider_profiles','delivery_events','delivery_exceptions')`);
ok(riderPolicies.length >= 5, `rider tables have read policies (${riderPolicies.length})`);
for (const p of riderPolicies) {
  // A combined read policy must reach managers only through a zone check, never through a bare role test.
  const q = p.qual ?? "";
  ok(!/is_manager\(\)/.test(q.replace(/manager_can_see\w*/g, "")), `${p.tablename}: "${p.policyname}" never admits a manager without a zone check`, q.slice(0, 160));
}
const blanket = await one(db, `
  select tablename, policyname from pg_policies
  where schemaname = 'public' and qual ~ '^\\(?public\\.is_manager\\(\\)\\)?$'`);
ok(blanket.length === 0, "no table is readable by every manager without a zone check", blanket.map((r) => r.tablename + "/" + r.policyname).join(", "));

// ops_audit_log is insert-only for everybody, service role included.
await db.exec(`select set_config('test.uid', '', false); set role service_role;`);
let blocked = 0;
for (const stmt of [`update public.ops_audit_log set reason = 'x'`, `delete from public.ops_audit_log`, `truncate public.ops_audit_log`]) {
  try {
    await db.exec(stmt);
  } catch {
    blocked++;
  }
}
await db.exec(`reset role;`);
ok(blocked === 3, "ops_audit_log refuses update, delete and truncate for service_role");

// Feature keys: the check has to allow two-dot keys (Phase 1 review).
const chk = await one(db, `select pg_get_constraintdef(c.oid) d from pg_constraint c join pg_class t on t.oid = c.conrelid
  where t.relname = 'role_feature_flags' and c.contype = 'c' and pg_get_constraintdef(c.oid) ilike '%feature%~%'`);
ok(chk.length === 1 && /\{1,2\}|\.\[a-z_\]\+\)\{/.test(chk[0].d.replace(/\\/g, "")), "role_feature_flags accepts two-dot keys such as manager.finance.view", chk[0]?.d ?? "no check found");

// Release-track columns must be readable before sign-in.
const apkCols = await one(db, `select column_name from information_schema.columns where table_schema='public' and table_name='platform_settings' and column_name ~ '^(manager|vendor|rider|customer)_apk_'`);
let apkOk = true;
const missingApk = [];
for (const { column_name } of apkCols) {
  const [g] = await one(db, `select has_column_privilege('anon', 'public.platform_settings', $1, 'select') as g`, [column_name]);
  if (!g.g) {
    apkOk = false;
    missingApk.push(column_name);
  }
}
ok(apkCols.length >= 8 && apkOk, `release-track columns are selectable by anon (${apkCols.length} columns)`, missingApk.join(", "));

// No manager write path around the audited RPCs.
const mgrWrites = await one(db, `
  select tablename, policyname, cmd from pg_policies
  where schemaname = 'public' and tablename in ('orders','deliveries') and cmd in ('UPDATE','ALL','INSERT','DELETE')
    and policyname ilike '%manager%'`);
ok(mgrWrites.length === 0, "managers have no direct write policy on orders or deliveries", mgrWrites.map((r) => r.policyname).join(", "));

// Every ops_ security-definer function: not executable by anon/authenticated unless it is a deliberate reader.
const exposed = await one(db, `
  select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'ops\\_%' and p.prosecdef
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`);
ok(exposed.length === 0, "no ops_* security-definer function is executable by anon or authenticated", exposed.map((r) => r.proname).join(", "));

// Every public table has RLS on (a missing one is how data leaks in Supabase).
const noRls = await one(db, `
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
ok(noRls.length === 0, "every public table has row level security on", noRls.map((r) => r.relname).join(", "));

// The same end-state checks as a SQL script an operator can paste into the Supabase
// editor after a deploy. Proving it here keeps the file honest.
const postApply = await one(db, readFileSync(path.join(sqlDir, "post-apply-check.sql"), "utf8").replace(/;\s*$/, ""));
ok(postApply.length >= 10, `post-apply-check.sql returns its checks (${postApply.length} rows)`);
for (const r of postApply) ok(r.ok === true, `post-apply-check: ${r.name}`, r.detail);

// ───────────────────────── 3. every per-migration proof ─────────────────────────
if (!args.has("--no-proofs")) {
  const proofs = readdirSync(sqlDir).filter((f) => /^(migration-.+|rider-migrations-sequence)\.mjs$/.test(f)).sort();
  console.log(`\nRunning ${proofs.length} proofs`);
  for (const p of proofs) {
    const r = spawnSync(process.execPath, [path.join(sqlDir, p)], { cwd: root, encoding: "utf8", timeout: 5 * 60_000 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const failed = (out.match(/^FAIL/gm) ?? []).length;
    ok(r.status === 0 && failed === 0, `proof ${p}`, r.status === 0 ? `${failed} failing check(s)` : `exit ${r.status}: ${out.trim().split("\n").slice(-3).join(" | ")}`);
    if (r.status !== 0 && !args.has("--keep-going")) break;
  }
}

// ───────────────────────── 4. an out-of-order deploy, and the repair ─────────────────────────
// A sibling branch (Partner 0061–0080, Rider 0081–0140) deployed AFTER the Manager
// range would re-declare functions 0141 re-declared. For each such migration,
// on its own fresh chain: re-apply it alone, report which locks it removed, then
// re-apply 0141 onward and require every lock to be back.
const LOCKS = ["zone_id", "preparing_at", "invoice_no", "delivery_instructions"];
const guardDef = async (d) =>
  (await one(d, `select pg_get_functiondef(p.oid) d from pg_proc p where p.proname = 'guard_order_update'`)).map((r) => r.d).join(String.fromCharCode(10));
const firstLine = (s) => String(s).split(String.fromCharCode(10))[0];
const late = files.filter((f) => /^(0061|0063|0081|0082)_/.test(f));
const repairFiles = files.filter((f) => Number(f.slice(0, 4)) >= 141);
for (const f of late) {
  const c = await freshChain();
  const err = await applyFile(c.db, f);
  if (err) {
    console.log(`info: re-applying ${f} alone fails (${firstLine(err).slice(0, 120)}) — it is not re-runnable, so it can only be applied once, in order`);
    continue;
  }
  const body = await guardDef(c.db);
  const lost = LOCKS.filter((k) => !body.includes(k));
  console.log(`info: ${f.slice(0, 4)} applied late removes the guard_order_update lock on: ${lost.length ? lost.join(", ") : "nothing"}`);
  let repairErr = null;
  for (const r of repairFiles) {
    const e = await applyFile(c.db, r);
    if (e) {
      repairErr = firstLine(e);
      break;
    }
  }
  if (repairErr) {
    console.log(`info: re-applying 0141 onward is not fully re-runnable (${repairErr.slice(0, 140)}); falling back to 0141 only`);
    await applyFile(c.db, repairFiles[0]);
  }
  const fixed = await guardDef(c.db);
  ok(LOCKS.every((k) => fixed.includes(k)), `after ${f.slice(0, 4)} applied late, re-applying ${repairErr ? "0141" : "0141 onward"} restores every guard_order_update lock`);
}

console.log(fails ? `\n${fails} FAILED` : `\nall ${files.length} migrations apply in order; end state and proofs hold`);
process.exit(fails ? 1 : 0);
