-- Read-only RLS / grant verification for the LIVE Supabase project.
-- Paste into Supabase -> SQL editor and run each block. Nothing here writes.
-- Source: docs/SECURITY_AUDIT.md section 1, plus a migration-applied check.

-- 1. Tables in public with RLS off, or on with zero policies.
--    Expected: every row has rls_on = true. policies = 0 is fine ONLY for the
--    service-role-only tables (obs_*, rate_limits, vendor_login_credentials,
--    payments writes, coupon_redemptions writes, etc.).
select c.relname,
       c.relrowsecurity as rls_on,
       c.relforcerowsecurity as rls_forced,
       count(p.polname) as policies
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_policy p on p.polrelid = c.oid
 where n.nspname = 'public' and c.relkind in ('r', 'p')
 group by 1, 2, 3
 order by rls_on asc, policies asc, c.relname asc;

-- 2. Sensitive columns that anon/authenticated can SELECT.
--    Expected: ZERO rows.
select table_name, column_name, grantee
  from information_schema.column_privileges
 where table_schema = 'public'
   and grantee in ('anon', 'authenticated')
   and privilege_type = 'SELECT'
   and (column_name ~* 'bank|ifsc|pan_|gst|upi|password|secret|token|api_key'
        or column_name ~* 'owner_email|owner_mobile|commission');

-- 3. SECURITY DEFINER functions that anon can execute.
--    Expected: only deliberate public ones (menu_item_popularity, preview_coupon
--    style lookups). Anything that writes is a finding.
select p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef
   and has_function_privilege('anon', p.oid, 'execute')
 order by p.proname asc;

-- 4. Table-level privileges held by anon (writes especially).
--    Expected: SELECT on a few catalogue tables; no INSERT/UPDATE/DELETE.
select table_name, string_agg(privilege_type, ', ' order by privilege_type) as privs
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee = 'anon'
 group by 1
 order by table_name asc;

-- 5. Policies that are wide open (using true) -- review each against its table.
select schemaname, tablename, policyname, cmd, roles
  from pg_policies
 where schemaname = 'public'
   and (qual = 'true' or with_check = 'true')
 order by tablename asc, policyname asc;

-- 6. Which of the migrations that matter for security actually exist live?
--    (Memory note: 0039/0042/0048/0051 were unapplied on 2026-09-25.)
select 'vendor_login_credentials table (0039)' as check_name,
       to_regclass('public.vendor_login_credentials') is not null as present
union all select 'deliveries.offered_driver_id (0042)',
       exists (select 1 from information_schema.columns
                where table_name='deliveries' and column_name='offered_driver_id')
union all select 'settlement_corrections table (0048)',
       to_regclass('public.settlement_corrections') is not null
union all select 'orders.cancelled_by (0051)',
       exists (select 1 from information_schema.columns
                where table_name='orders' and column_name='cancelled_by')
union all select 'role_feature_flags table (0052)',
       to_regclass('public.role_feature_flags') is not null
union all select 'profiles_guard_phone trigger (0053)',
       exists (select 1 from pg_trigger where tgname = 'profiles_guard_phone')
union all select 'orders_guard_update trigger (0024/0030/0051)',
       exists (select 1 from pg_trigger where tgname = 'orders_guard_update');

-- 7. Every user trigger on orders and whether it is enabled ('O' = enabled).
--    Expected: orders_clear_cancellation_insert, orders_force_total_pending,
--    orders_guard_update, zz_orders_stamp_lifecycle -- all 'O'.
select tgname, tgenabled
  from pg_trigger
 where tgrelid = 'public.orders'::regclass and not tgisinternal
 order by tgname;
