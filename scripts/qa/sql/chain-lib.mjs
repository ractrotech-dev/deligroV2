// Shared by the whole-chain scripts: builds a clean PGlite database by applying the real
// supabase/migrations/ files in order, behind Supabase-style stubs (see all-migrations.mjs).
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const migDir = path.join(root, "supabase/migrations");
export const sqlDir = path.join(root, "scripts/qa/sql");

export const files = readdirSync(migDir)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort((a, b) => {
    const na = Number(a.slice(0, 4));
    const nb = Number(b.slice(0, 4));
    return na - nb || (a < b ? -1 : a > b ? 1 : 0);
  });

/** What Supabase provides outside `public`. */
export const PREAMBLE = `
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
export const adapt = (sql) =>
  sql
    .replace(/create extension if not exists "?pgcrypto"?[^;]*;/gi, "-- (pgcrypto: gen_random_uuid is built in)")
    .replace(/create extension if not exists pg_cron[^;]*;/gi, "-- (pg_cron: scheduling is a separate dashboard step)");

/** Applies one file; on failure names the file and the statement around the error. */
export async function applyFile(db, f) {
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

export async function freshChain(upTo = Infinity) {
  const db = new PGlite();
  await db.exec(PREAMBLE);
  for (const f of files) {
    if (Number(f.slice(0, 4)) > upTo) break;
    const err = await applyFile(db, f);
    if (err) return { db, err, applied: f };
  }
  return { db, err: null, applied: files[files.length - 1] };
}


export const one = async (db, sql, params) => (await db.query(sql, params)).rows;
