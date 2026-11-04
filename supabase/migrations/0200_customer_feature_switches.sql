-- ============================================================
-- 0200 — Feature switches for customers.
-- ------------------------------------------------------------
-- STATUS: APPLIED 2026-11-05 to the Supabase project ending akxv, with 0190-0201 as one transaction.
-- Order: after 0196. Requires 0052 (role_feature_flags), 0141 (ops_set_feature_switch),
-- 0184 (the role check this replaces) and is_admin().
--
-- Admin → App features gains a Customers section: what customers can use, for
-- everyone or for one customer (src/lib/features/catalog.ts, role "customer").
-- A customer's override is an ordinary `subject_kind = 'profile'` row. Guests
-- have no row and follow the role-wide one.
--
-- Two changes:
--   1. role_feature_flags.role accepts 'customer'. Without this the app runs
--      exactly as before (every customer feature at its default) and saving a
--      customer switch fails with a message.
--   2. customer_feature_on(feature): the same answer as src/lib/features/resolve.ts
--      for the person calling, so RLS and SQL functions can read a switch
--      (0201 uses it). This person's row, else the role-wide row, else the default.
--
-- Security review (docs/SECURITY_AUDIT.md): the table stays service_role-only.
-- customer_feature_on is SECURITY DEFINER and callable by `authenticated` because
-- RLS policies run as the caller. It answers about the caller alone (auth.uid(),
-- no user argument) and only for `customer.*` keys, so it shows nobody else's
-- switches. An admin is never switched off, as in src/lib/features/guards.server.ts.
-- With no user (service role, cron) it answers true: those paths have their own
-- checks, and the policies in 0201 are `to authenticated` anyway.
--
-- Rollback:
--   -- first roll back 0201
--   drop function if exists public.customer_feature_on(text, boolean);
--   delete from public.role_feature_flags where role = 'customer';
--   alter table public.role_feature_flags drop constraint if exists role_feature_flags_role_check;
--   alter table public.role_feature_flags add constraint role_feature_flags_role_check
--     check (role in ('vendor', 'manager', 'driver', 'admin'));
--
-- Idempotent: safe to re-run.
-- ============================================================

begin;

alter table public.role_feature_flags drop constraint if exists role_feature_flags_role_check;
alter table public.role_feature_flags
  add constraint role_feature_flags_role_check
  check (role in ('customer', 'vendor', 'manager', 'driver', 'admin'));

comment on table public.role_feature_flags is
  'Admin switches for customer/vendor/manager/driver features (role-wide or per shop/person) and admin-console screens (role-wide). service_role only — see migrations 0052, 0184, 0200.';

create or replace function public.customer_feature_on(p_feature text, p_default boolean default true)
returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_feature not like 'customer.%' then false
    when auth.uid() is null then true
    when public.is_admin() then true
    else coalesce(
      (select f.enabled from public.role_feature_flags f
        where f.feature = p_feature and f.subject_kind = 'profile' and f.subject_id = auth.uid() limit 1),
      (select f.enabled from public.role_feature_flags f
        where f.feature = p_feature and f.subject_kind = 'role' and f.subject_id is null limit 1),
      p_default)
  end;
$$;
revoke all on function public.customer_feature_on(text, boolean) from public, anon;
grant execute on function public.customer_feature_on(text, boolean) to authenticated, service_role;

commit;
