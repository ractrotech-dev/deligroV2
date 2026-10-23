-- 0060 — performance: two small partial indexes and a restaurant-scoped
-- popularity read.
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated only in an
-- in-process Postgres (scripts/qa/sql/migration-0060.mjs) on synthetic data;
-- run it on staging and check pg_stat_user_indexes before production.
-- Evidence and measurements: docs/performance-audit.md, section "Database".
--
-- No table, column, policy, grant or row is changed. Two indexes are added and
-- one SECURITY DEFINER function body is replaced with the same signature,
-- grants and result for every order item the 0053/0055 guard admits.
--
-- Rollback:
--   drop index if exists public.profiles_staff_role_idx;
--   drop index if exists public.deliveries_cod_collected_at_idx;
--   -- and re-run the function body from 0010_menu_popularity.sql.

-- 1. Staff lookups by role ------------------------------------------------
-- profiles.role = 'driver' runs on every rider dispatch (rider-dispatch.ts),
-- every 4 s on the manager board (manager-orders.ts listRiders) and on the cash
-- ledger; role in ('admin','manager') on order alerts (order-events.ts). The
-- only index covering role is 0057's customer-only partial, so each of these is
-- a sequential scan of every customer profile. Staff rows are a tiny fraction of
-- profiles, so this partial index is small and costs nothing on customer
-- sign-ups (a customer row never enters it).
create index if not exists profiles_staff_role_idx
  on public.profiles (role)
  where role <> 'customer';

-- 2. Cash ledger "collected today" -----------------------------------------
-- codDaySummary (cod-handovers.ts) filters deliveries on a cod_collected_at
-- range and cod_collected_amount is not null; nothing indexes cod_collected_at,
-- so the admin cash ledger scans every delivery ever made. Only COD deliveries
-- that were actually collected enter this index.
create index if not exists deliveries_cod_collected_at_idx
  on public.deliveries (cod_collected_at)
  where cod_collected_amount is not null;

-- 3. Menu popularity, scoped to the restaurant's own orders -----------------
-- Runs on every /restaurant/[slug] view and on checkout re-pricing
-- (/api/restaurants/[slug]/menu-prices). The 0010 body filters only on
-- menu_items.restaurant_id, so the planner walks order_items by menu item —
-- every order that item has ever been in — and applies the 30-day window last.
-- Adding o.restaurant_id lets it start from
-- orders_restaurant_status_created_idx (0057) and read only this restaurant's
-- recent orders.
--
-- Same result: guard_order_item_insert (0053, 0055) refuses an order item whose
-- menu item is not on the order's restaurant's menu, so for every row it has
-- admitted, mi.restaurant_id = p_restaurant_id already implies
-- o.restaurant_id = p_restaurant_id. A row inserted before 0053 that broke that
-- rule (an item counted under the wrong shop) would no longer be counted.
create or replace function public.menu_item_popularity(
  p_restaurant_id uuid,
  p_days int default 30
)
returns table (menu_item_id uuid, units bigint)
language sql
stable
security definer
set search_path = public
as $$
  select oi.menu_item_id, sum(oi.qty)::bigint as units
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  join public.menu_items mi on mi.id = oi.menu_item_id
  where o.restaurant_id = p_restaurant_id
    and mi.restaurant_id = p_restaurant_id
    and o.status <> 'cancelled'
    and o.created_at >= now() - make_interval(days => greatest(p_days, 1))
  group by oi.menu_item_id
  order by units desc, oi.menu_item_id;
$$;

-- create or replace keeps existing grants; restated so this file reads alone.
revoke all on function public.menu_item_popularity(uuid, int) from public;
grant execute on function public.menu_item_popularity(uuid, int) to anon, authenticated;
