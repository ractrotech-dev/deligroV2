-- Post-apply check for the migration chain (Phase 10, Task 2).
--
-- Run in the Supabase SQL editor after applying migrations — and again after ANY
-- out-of-order apply (a sibling branch's migration deployed after 0141+).
-- Returns one row per check; every `ok` must be true. If one is false, re-apply
-- every migration from 0141 to the newest, in number order (they are re-runnable),
-- then run this again. Mirrors the end-state assertions of
-- scripts/qa/sql/all-migrations.mjs, which proves the same on a clean database.
--
-- Read-only: no statement here changes anything.

with
guard as (
  select coalesce(string_agg(pg_get_functiondef(p.oid), E'\n'), '') as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'guard_order_update'
),
restlock as (
  select coalesce(string_agg(pg_get_functiondef(p.oid), E'\n'), '') as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'lock_restaurant_privileged_fields'
),
checks(name, ok, detail) as (
  select 'guard_order_update locks zone_id', (select def from guard) like '%zone_id%', '0141 re-applied after 0061/0063 restores it'
  union all select 'guard_order_update locks preparing_at', (select def from guard) like '%preparing_at%', '0061 / 0141'
  union all select 'guard_order_update locks invoice_no', (select def from guard) like '%invoice_no%', '0063 / 0141'
  union all select 'guard_order_update locks delivery_instructions', (select def from guard) like '%delivery_instructions%', '0082 / 0141'
  union all select 'restaurants: zone_id is admin-only', (select def from restlock) like '%zone_id%', '0141'
  union all select 'ops_audit_log cannot be updated or deleted',
    (select count(*) = 2 from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname = 'ops_audit_log' and t.tgenabled = 'O'
        and t.tgname in ('ops_audit_log_immutable', 'ops_audit_log_no_truncate')), '0141: update/delete and truncate triggers, both enabled'
  union all select 'no table is readable by every manager without a zone check',
    not exists (select 1 from pg_policies where schemaname = 'public' and qual ~ '^\(?public\.is_manager\(\)\)?$'), '0141 replaced 0023'
  union all select 'managers have no direct write policy on orders or deliveries',
    not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('orders', 'deliveries')
                  and cmd in ('UPDATE', 'ALL', 'INSERT', 'DELETE') and policyname ilike '%manager%'), 'Phase 3 fix'
  union all select 'feature keys with two dots are accepted',
    exists (select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
             where t.relname = 'role_feature_flags' and c.contype = 'c'
               and pg_get_constraintdef(c.oid) ~ '\{1,2\}'), '0141 relaxes 0052''s key check'
  union all select 'release-track columns are readable before sign-in',
    not exists (select 1 from information_schema.columns c
                 where c.table_schema = 'public' and c.table_name = 'platform_settings' and c.column_name ~ '^(manager|vendor|rider|customer)_apk_'
                   and not has_column_privilege('anon', 'public.platform_settings', c.column_name, 'select')), '0045 / 0061 / 0141'
  union all select 'no ops_* security-definer function is callable by anon or authenticated',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname like 'ops\_%' and p.prosecdef
                   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
    'each is service-role only; the app calls them through its own routes'
  union all select 'record_rider_payout is not callable by signed-in users (payouts go through two-person requests)',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'record_rider_payout' and has_function_privilege('authenticated', p.oid, 'execute')),
    '0083 grants it; 0152 revokes it — 0083 applied after 0152 hands it back'
  union all select 'every public table has row level security on',
    not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity), 'a table without RLS is readable by every signed-in user'
)
select name, ok, detail from checks order by ok, name;
