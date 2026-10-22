// Shared pieces for scripts/qa/sql/rider-migrations-sequence.mjs: the Supabase platform stub, the real
// baseline (every migration numbered below 0081, applied in order), the rider migrations, a catalog
// snapshot, and the rollback blocks read from the migration headers.
//
// The baseline is the repository's own migrations, not a hand-written stub: Supabase's platform objects
// (roles, auth.*, storage.*) are stubbed, everything in `public` is what 0001–0080 really build. Three
// test-fixture relaxations are applied on top (see FIXTURES); nothing else differs from production.
import { readFileSync, readdirSync } from "node:fs";

const MIGRATIONS = new URL("../../../supabase/migrations/", import.meta.url);
export const readMigration = (file) => readFileSync(new URL(file, MIGRATIONS), "utf8");
const files = () => readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const number = (f) => Number(f.slice(0, 4));

// The rider range: 0081 up to (not including) the Manager app's 0141.
export const riderMigrations = () => files().filter((f) => number(f) >= 81 && number(f) <= 140);
export const baselineMigrations = () => files().filter((f) => number(f) < 81);

// Supabase's own objects, as far as these migrations touch them. auth.uid() / auth.jwt() read the
// test.uid / test.jwt settings, the convention every per-migration proof uses (`as(role, uid, sql)`).
export const SUPABASE_PLATFORM = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create role supabase_admin nologin; create role authenticator nologin;
  create schema auth; create schema storage; create schema extensions;
  create table auth.users (id uuid primary key, email text, phone text,
    raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', created_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  -- An unauthenticated statement from the migration owner stands for the server (service role):
  -- that is how every per-migration proof writes its fixtures.
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('test.jwt', true), ''),
                    case when current_user = 'postgres' then '{"role":"service_role"}' else '{}' end)::jsonb $$;
  create function auth.role() returns text language sql stable as $$ select auth.jwt() ->> 'role' $$;
  create table storage.buckets (id text primary key, name text not null, owner uuid, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
    name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
  grant select, insert, update, delete on storage.objects, storage.buckets to anon, authenticated, service_role;
  -- Supabase's default: every table, sequence and function created later in public is granted to the
  -- API roles. Each migration has to take that back itself.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

// Test fixtures only — they let the proofs' short INSERTs run on the real tables:
//   1. profiles.id no longer has to exist in auth.users (Supabase's table; the proofs insert profiles);
//   2. a restaurant row gets a name and slug by default;
//   3. an order row gets a fixture customer and shop by default.
// Constraints, triggers, policies and grants are untouched.
export const FIXTURE_CUSTOMER = "ffffffff-0000-0000-0000-00000000c0de";
export const FIXTURE_SHOP = "ffffffff-0000-0000-0000-00000000500b";
export const FIXTURE_OWNER = "ffffffff-0000-0000-0000-0000000000be";
export const FIXTURES = `
  alter table public.profiles drop constraint if exists profiles_id_fkey;
  alter table public.restaurants alter column name set default 'Test shop',
                                 alter column slug set default ('shop-' || gen_random_uuid()::text);
  insert into public.profiles (id, role, full_name) values
    ('${FIXTURE_CUSTOMER}', 'customer', 'Fixture customer'), ('${FIXTURE_OWNER}', 'restaurant', 'Fixture owner');
  insert into public.restaurants (id, owner_id) values ('${FIXTURE_SHOP}', '${FIXTURE_OWNER}');
  alter table public.orders alter column customer_id set default '${FIXTURE_CUSTOMER}',
                            alter column restaurant_id set default '${FIXTURE_SHOP}';
`;

// pgcrypto is not shipped with PGlite; gen_random_uuid() is core since Postgres 13.
const portable = (sql) => sql.replace(/create extension if not exists "?pgcrypto"?[^;]*;/gi, "");

export async function baseline(db, { fixtures = true } = {}) {
  await db.exec(SUPABASE_PLATFORM);
  for (const f of baselineMigrations()) {
    try { await db.exec(portable(readMigration(f))); }
    catch (e) { throw new Error(`baseline ${f} did not apply: ${e.message}`); }
  }
  if (fixtures) await db.exec(FIXTURES);
}

// ── catalog snapshot ────────────────────────────────────────────────────────────────────────────
// Everything a migration can change in `public` (plus the storage bucket rows): relations with RLS and
// ACLs, columns with ACLs, constraints, indexes, policies, functions with a hash of their source,
// triggers, enum labels, views. Values (rows, sequence positions) are not part of it.
const SNAPSHOT_QUERIES = {
  relations: `select c.relname as k, c.relkind::text || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity
                     || ' opts=' || coalesce(c.reloptions::text, '') || ' acl=' || coalesce(c.relacl::text, '') as v
                from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'S', 'p')`,
  columns: `select c.relname || '.' || a.attname as k,
                   format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull || ' identity=' || a.attidentity::text
                   || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' acl=' || coalesce(a.attacl::text, '') as v
              from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where n.nspname = 'public' and c.relkind in ('r', 'v', 'p') and a.attnum > 0 and not a.attisdropped`,
  constraints: `select c.relname || '.' || k.conname as k, pg_get_constraintdef(k.oid) as v
                  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public'`,
  indexes: `select tablename || '.' || indexname as k, indexdef as v from pg_indexes where schemaname = 'public'`,
  policies: `select schemaname || '.' || tablename || '.' || policyname as k,
                    permissive || ' ' || cmd || ' ' || roles::text || ' using=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '') as v
               from pg_policies where schemaname in ('public', 'storage')`,
  functions: `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as k,
                     pg_get_function_result(p.oid) || ' definer=' || p.prosecdef || ' volatile=' || p.provolatile::text
                     || ' config=' || coalesce(array_to_string(p.proconfig, ','), '') || ' acl=' || coalesce(p.proacl::text, '')
                     || ' src=' || md5(p.prosrc) as v
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
  triggers: `select c.relname || '.' || t.tgname as k, pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text as v
               from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
              where n.nspname in ('public', 'storage') and not t.tgisinternal`,
  enums: `select t.typname as k, string_agg(e.enumlabel, ',' order by e.enumsortorder) as v
            from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = 'public' group by t.typname`,
  views: `select viewname as k, md5(definition) as v from pg_views where schemaname = 'public'`,
  buckets: `select id as k, 'public=' || coalesce(public::text, '') || ' size=' || coalesce(file_size_limit::text, '')
                   || ' mime=' || coalesce(allowed_mime_types::text, '') as v from storage.buckets`,
};

export async function snapshot(db) {
  const out = {};
  for (const [part, sql] of Object.entries(SNAPSHOT_QUERIES)) {
    const rows = (await db.query(sql)).rows;
    out[part] = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  }
  return out;
}

// [{ part, key, before, after }] for every entry that differs.
export function diffSnapshots(a, b) {
  const diffs = [];
  for (const part of Object.keys(SNAPSHOT_QUERIES)) {
    const keys = new Set([...Object.keys(a[part] ?? {}), ...Object.keys(b[part] ?? {})]);
    for (const key of [...keys].sort()) {
      const before = a[part]?.[key], after = b[part]?.[key];
      if (before !== after) diffs.push({ part, key, before: before ?? null, after: after ?? null });
    }
  }
  return diffs;
}

export const describeDiff = (d) =>
  `${d.part} ${d.key}: ${d.before === null ? "(absent)" : d.before.slice(0, 160)} -> ${d.after === null ? "(absent)" : d.after.slice(0, 160)}`;

// ── rollback blocks ─────────────────────────────────────────────────────────────────────────────
// A header's rollback lines are "--   <sql>"; a line whose SQL is itself commented out ("--   -- …") is a
// manual step and is skipped, as in the per-migration proofs. A "re-run section(s) X [and Y] of
// <file>.sql …;" line is resolved by pasting those sections of that file.
export function extractSection(file, id) {
  const text = readMigration(file);
  // Keep the file's own line endings: they are part of a function's source (prosrc).
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const head = (l) => l.match(/^-- (\d+[a-z]?) (?:—|-{3,})/);
  const start = lines.findIndex((l) => head(l)?.[1] === String(id));
  if (start < 0) throw new Error(`section ${id} not found in ${file}`);
  let end = lines.findIndex((l, i) => i > start && (head(l) || /^commit;/.test(l)));
  if (end < 0) end = lines.length;
  // Drop the "-- ====" rule that opens the next section, if any.
  while (end > start && /^-- =+$/.test(lines[end - 1])) end--;
  return lines.slice(start, end).join(eol);
}

export function rollbackBlock(file) {
  const lines = readMigration(file).split(/\r?\n/);
  const from = lines.findIndex((l) => /^-- Rollback\b/.test(l));
  if (from < 0) return null;
  const raw = [];
  for (const l of lines.slice(from + 1)) {
    if (/^-- ====/.test(l) || /^-- \(/.test(l)) break;
    if (/^--   /.test(l) && !/^--\s+--/.test(l)) raw.push(l.slice(2));
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (!/^\s*re-run\b/i.test(raw[i])) { out.push(raw[i]); continue; }
    let directive = raw[i];
    while (!/;\s*$/.test(directive) && i + 1 < raw.length) directive += " " + raw[++i].trim();
    for (const m of directive.matchAll(/sections? ([\w\s,]+?) of (\d{4}_[\w]+\.sql)/g)) {
      const ids = m[1].split(/\s*(?:,|\band\b)\s*/).map((s) => s.trim()).filter(Boolean);
      for (const id of ids) out.push(extractSection(m[2], id));
    }
  }
  return out.join("\n");
}
