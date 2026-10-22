-- ============================================================
-- 0084 — Rider ratings and default daily/weekly targets
-- STATUS: PENDING APPROVAL — not applied to any database. Staging first.
--         Needs only the base schema (profiles, orders, deliveries,
--         platform_settings); it does not depend on 0081-0083.
-- ------------------------------------------------------------
-- Phase 4 of the rider app (plan: docs/superpowers/plans/
-- 2026-10-21-rider-app-phase-4-dashboard-history-performance.md; design:
-- docs/superpowers/specs/2026-10-21-rider-app-design.md, "Performance and
-- ratings").
--
--   1. `rider_ratings` — a customer rates the rider who delivered their order:
--      1-5 stars and an optional comment (300 characters at most). One rating
--      per order (UNIQUE order_id). Only the order's customer, only after the
--      order is delivered, only for the rider on the delivery (the insert
--      policy). No update or delete for anyone signed in: a rating is final.
--   2. `my_rider_ratings` — the rider's view of their own ratings WITHOUT
--      customer_id. A rider never learns who rated them.
--   3. `platform_settings.rider_daily_target` / `rider_weekly_target` — the
--      default delivery targets shown on the rider's Performance screen.
--      0 = no default target (the largest active incentive rule's target for
--      that period is shown instead, and when there is none, nothing).
--
-- COORDINATION. The Manager app's migration 0150 (rider_tables_converge) builds
-- section 1-2 and the rider_ratings part of section 4 with IDENTICAL columns,
-- checks, indexes, policies, grants and view, every statement guarded, so
-- whichever lands first builds them and the other is a no-op. The two target
-- columns below exist only here. If you change anything in sections 1-2 or the
-- rider_ratings part of section 4, change it in 0150 as well.
--
-- Security (docs/SECURITY_AUDIT.md applies):
--   * RLS on, and SELECT is granted BY COLUMN: (id, order_id, driver_id,
--     rating, comment, created_at). customer_id is never readable by anon or
--     authenticated — not by the rider, not by the customer, not by an admin's
--     own session (a table-level grant would override a column revoke). The
--     server reads it, when it must, with the service role.
--   * Read policy: the customer sees their own ratings; admins see all. A rider
--     sees none of the table's rows — their ratings come through
--     `my_rider_ratings`, a SECURITY DEFINER-style view (security_invoker =
--     false: it runs as its owner) that filters on driver_id = auth.uid() and
--     omits customer_id.
--   * Insert policy: customer_id = auth.uid(), the order is theirs, the order is
--     `delivered`, and the delivery's driver is the rated driver. FINDING: the
--     policy's subquery runs with the CUSTOMER's rights, and a customer cannot
--     read `deliveries` (0001: driver, shop owner, admin only), so a customer's
--     own-session insert is refused today. That fails closed. The API route
--     (POST /api/orders/:id/rider-rating) therefore checks everything itself
--     — session user is the order's customer, order delivered, rider read from
--     the delivery — and inserts with the service role; the policy is the
--     backstop for any other client. Do not "fix" it with a broader policy.
--   * anon: no privileges. authenticated: no update, no delete — on the table
--     or through the view (the view's write privileges are revoked: a simple
--     view is auto-updatable as its owner).
--   * Target columns are granted to anon/authenticated by name (platform_settings
--     is column-granted since 0032, and the settings facade reads with the
--     caller's client) — a delivery count is not a secret.
--
-- Idempotent: safe to re-run, and safe in either order with 0150.
-- Re-run rule (ruling P8-R3): re-apply every migration from 0081 through the
-- newest one applied, all branches, in number order — never this file or the
-- rider files alone (Manager 0141, 0142 and 0152 narrow what they open).
--
-- Rollback:
--   drop view if exists public.my_rider_ratings;
--   drop table if exists public.rider_ratings;
--   alter table public.platform_settings drop constraint if exists platform_settings_rider_targets_range;
--   alter table public.platform_settings
--     drop column if exists rider_daily_target, drop column if exists rider_weekly_target;
-- ============================================================

begin;

-- ============================================================
-- 1 — rider_ratings
-- ============================================================
create table if not exists public.rider_ratings (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null unique,
  driver_id   uuid not null references public.profiles (id) on delete cascade,
  customer_id uuid not null references public.profiles (id) on delete cascade,
  rating      smallint not null check (rating between 1 and 5),
  comment     text check (comment is null or char_length(comment) <= 300),
  created_at  timestamptz not null default now()
);
create index if not exists rider_ratings_driver_idx on public.rider_ratings (driver_id, created_at desc);

-- The rider's view of their ratings: never who left them.
create or replace view public.my_rider_ratings
with (security_invoker = false) as
  select id, order_id, driver_id, rating, comment, created_at
    from public.rider_ratings
   where driver_id = auth.uid();

-- ============================================================
-- 2 — platform_settings: default targets
-- ============================================================
alter table public.platform_settings
  add column if not exists rider_daily_target  integer not null default 0,
  add column if not exists rider_weekly_target integer not null default 0;

do $$
begin
  alter table public.platform_settings
    add constraint platform_settings_rider_targets_range
    check (rider_daily_target between 0 and 1000 and rider_weekly_target between 0 and 5000);
exception
  when duplicate_object then null;
end $$;

comment on column public.platform_settings.rider_daily_target is
  'Default daily delivery target shown on the rider Performance screen. 0 = none: the largest active daily incentive rule target is shown instead.';
comment on column public.platform_settings.rider_weekly_target is
  'Default weekly (Monday-Sunday, IST) delivery target shown on the rider Performance screen. 0 = none: the largest active weekly incentive rule target is shown instead.';

grant select (rider_daily_target, rider_weekly_target) on public.platform_settings to anon, authenticated;

-- ============================================================
-- 3 — RLS and privileges
-- ============================================================
alter table public.rider_ratings enable row level security;

-- Ratings: the customer inserts once for their own delivered order with that
-- rider; riders read through my_rider_ratings only.
drop policy if exists "rider_ratings — customer insert" on public.rider_ratings;
create policy "rider_ratings — customer insert" on public.rider_ratings for insert
  with check (
    customer_id = auth.uid()
    and exists (
      select 1 from public.orders o
        join public.deliveries d on d.order_id = o.id
       where o.id = rider_ratings.order_id
         and o.customer_id = auth.uid()
         and o.status = 'delivered'
         and d.driver_id = rider_ratings.driver_id
    )
  );
drop policy if exists "rider_ratings — read" on public.rider_ratings;
create policy "rider_ratings — read" on public.rider_ratings for select
  using (customer_id = auth.uid() or public.is_admin());

-- Writes: service role only.
revoke all on public.rider_ratings from anon, authenticated;

-- Customers insert ratings and read their own; riders use the view.
-- Column grant, not table grant: nobody signed in can select customer_id (a
-- table-level grant would override a column revoke).
grant select (id, order_id, driver_id, rating, comment, created_at) on public.rider_ratings to authenticated;
grant insert on public.rider_ratings to authenticated;
-- The view is a plain single-table view, so Postgres would make it updatable —
-- as its owner, bypassing RLS — for whoever holds the privilege, and Supabase's
-- default privileges hand every new relation to `authenticated` in full. Take
-- it all back, then give SELECT only: a rider must not be able to edit or
-- delete their own ratings through it.
revoke all on public.my_rider_ratings from public, anon, authenticated;
grant select on public.my_rider_ratings to authenticated;

grant select, insert, update, delete on public.rider_ratings to service_role;

commit;
