-- ============================================================
-- 0058 — Handover codes are readable only by the party they belong to
--        (2026-10-12 readiness audit, P1-1 phase 2)
-- ------------------------------------------------------------
-- The two handover codes decide who may mark an order collected and delivered:
--   pickup_otp    shown to the KITCHEN, typed by the rider at the counter
--   delivery_otp  shown to the CUSTOMER, typed by the rider at the door
-- Possession of the code is the proof, so a code readable by anyone else is no
-- proof. Through "orders — read" the owning vendor, every manager and (before
-- 0055) the assigned rider could read BOTH with their own JWT and the public
-- key, so a vendor and a rider could complete a delivery nobody made.
--
-- This migration takes the two columns out of the readable set and gives each
-- legitimate reader a narrow function instead:
--   public.my_delivery_otp(order)      the order's customer only
--   public.kitchen_pickup_otps(orders) the owning restaurant (and admin)
-- The rider's side is unchanged: driver-orders.ts reads the codes with the
-- service role to VERIFY what the rider typed, and never shows them to him.
--
-- How: column-level SELECT. A column REVOKE does nothing while the table-level
-- grant exists, so this revokes table SELECT and re-grants every column except
-- the two. Same pattern as `restaurants` (0022, CLAUDE.md rule 1) with the same
-- consequence: A COLUMN ADDED TO `orders` LATER IS INVISIBLE TO anon /
-- authenticated UNTIL IT IS GRANTED. The migration that adds it must say
-- `grant select (new_col) on public.orders to authenticated;`. Symptom when
-- forgotten: "permission denied for table orders" on a screen that selects it.
--
-- anon loses table SELECT entirely; it never had an RLS policy that returned a
-- row. Writes are untouched. service_role is untouched.
--
-- ORDER OF DEPLOY: ship the app first. The app reads through these functions
-- and falls back to the columns when a function does not exist yet, so it works
-- before AND after this migration. Applying this migration before the app is
-- deployed would blank the pickup code on the kitchen board.
--
-- Rollback:
--   grant select on public.orders to anon, authenticated;
--   drop function public.my_delivery_otp(uuid);
--   drop function public.kitchen_pickup_otps(uuid[]);
-- ============================================================

begin;

create or replace function public.my_delivery_otp(oid uuid)
returns text
language sql stable security definer set search_path = public as $$
  select o.delivery_otp
    from public.orders o
   where o.id = oid
     and o.customer_id = auth.uid();
$$;

create or replace function public.kitchen_pickup_otps(oids uuid[])
returns table (order_id uuid, pickup_otp text)
language sql stable security definer set search_path = public as $$
  select o.id, o.pickup_otp
    from public.orders o
   where o.id = any (oids)
     and (public.owns_restaurant(o.restaurant_id) or public.is_admin());
$$;

revoke all on function public.my_delivery_otp(uuid) from public, anon;
revoke all on function public.kitchen_pickup_otps(uuid[]) from public, anon;
grant execute on function public.my_delivery_otp(uuid) to authenticated, service_role;
grant execute on function public.kitchen_pickup_otps(uuid[]) to authenticated, service_role;

do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'orders'
     and column_name not in ('pickup_otp', 'delivery_otp');

  if cols is null then
    raise exception 'public.orders has no readable columns to grant';
  end if;

  revoke select on public.orders from anon, authenticated;
  execute format('grant select (%s) on public.orders to authenticated', cols);
end $$;

commit;
