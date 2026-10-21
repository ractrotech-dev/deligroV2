-- ============================================================
-- 0155 — Manager finance reads: settlements, settlement lines, corrections,
--        refunds and payments, each limited to the manager's zones
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL. Not applied to any database from this branch.
-- Order: after 0154 (and 0061 → 0063 → 0081 → 0082 → 0083 → 0141 → … ).
--
-- Phase 6 (§7 Finance, §13 Reports). Until now only admins (and, since 0061,
-- the shop itself) could read the money tables. This adds permissive SELECT
-- policies for managers, scoped through the zone of the shop or order the row
-- belongs to:
--
--   * vendor_settlements, settlement_corrections — the restaurant's zone
--   * vendor_settlement_orders                   — its settlement's restaurant
--   * refunds, payments                          — the order's zone
--
-- READ ONLY. No manager INSERT/UPDATE/DELETE policy is added on any of these:
-- every money write goes through the audited ops_* RPCs (0152, 0156), which
-- run as the service role. RLS is the second wall behind the API's zone
-- filter; both must agree.
--
-- The column-level grants these tables already carry are unchanged — nothing
-- here widens what a signed-in role can read beyond rows.
--
-- Also: the indexes the finance screens and the twelve reports filter on.
--
-- Rollback:
--   drop policy if exists "vendor_settlements — manager read" on public.vendor_settlements;
--   drop policy if exists "vendor_settlement_orders — manager read" on public.vendor_settlement_orders;
--   drop policy if exists "settlement_corrections — manager read" on public.settlement_corrections;
--   drop policy if exists "refunds — manager read" on public.refunds;
--   drop policy if exists "payments — manager read" on public.payments;
--   drop function if exists public.manager_can_see_restaurant(uuid);
--   drop index if exists public.orders_zone_created_at_idx, public.refunds_order_idx,
--     public.refunds_status_created_idx, public.payments_status_created_idx,
--     public.vendor_settlements_restaurant_status_paid_idx, public.cod_handovers_zone_date_idx,
--     public.deliveries_driver_cod_idx, public.payment_requests_status_requested_idx;
-- ============================================================

begin;

-- Admin, or a manager holding the restaurant's zone. Null zone = nobody but
-- admins (fail closed), exactly as manager_can_see_zone.
create or replace function public.manager_can_see_restaurant(p_restaurant uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or exists (select 1 from public.restaurants r
                  where r.id = p_restaurant and public.manager_can_see_zone(r.zone_id));
$$;
revoke execute on function public.manager_can_see_restaurant(uuid) from public, anon;
grant execute on function public.manager_can_see_restaurant(uuid) to authenticated, service_role;

drop policy if exists "vendor_settlements — manager read" on public.vendor_settlements;
create policy "vendor_settlements — manager read" on public.vendor_settlements for select
  using (public.is_manager() and public.manager_can_see_restaurant(restaurant_id));

drop policy if exists "vendor_settlement_orders — manager read" on public.vendor_settlement_orders;
create policy "vendor_settlement_orders — manager read" on public.vendor_settlement_orders for select
  using (public.is_manager() and exists (
    select 1 from public.vendor_settlements s
     where s.id = settlement_id and public.manager_can_see_restaurant(s.restaurant_id)));

drop policy if exists "settlement_corrections — manager read" on public.settlement_corrections;
create policy "settlement_corrections — manager read" on public.settlement_corrections for select
  using (public.is_manager() and public.manager_can_see_restaurant(restaurant_id));

drop policy if exists "refunds — manager read" on public.refunds;
create policy "refunds — manager read" on public.refunds for select
  using (public.is_manager() and exists (
    select 1 from public.orders o where o.id = order_id and public.manager_can_see_zone(o.zone_id)));

drop policy if exists "payments — manager read" on public.payments;
create policy "payments — manager read" on public.payments for select
  using (public.is_manager() and exists (
    select 1 from public.orders o where o.id = order_id and public.manager_can_see_zone(o.zone_id)));

-- What the finance screens and reports filter and join on.
create index if not exists orders_zone_created_at_idx on public.orders (zone_id, created_at);
create index if not exists refunds_order_idx on public.refunds (order_id);
create index if not exists refunds_status_created_idx on public.refunds (status, created_at);
create index if not exists payments_status_created_idx on public.payments (status, created_at);
create index if not exists vendor_settlements_restaurant_status_paid_idx
  on public.vendor_settlements (restaurant_id, status, paid_at);
create index if not exists cod_handovers_zone_date_idx on public.cod_handovers (zone_id, handover_date);
create index if not exists deliveries_driver_cod_idx on public.deliveries (driver_id, cod_collected_at);
create index if not exists payment_requests_status_requested_idx on public.payment_requests (status, requested_at);

commit;
