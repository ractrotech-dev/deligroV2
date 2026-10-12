-- ============================================================
-- 0055 — Order and delivery integrity (2026-10-12 readiness audit, P1-1 / P1-2a)
-- ------------------------------------------------------------
-- Before this migration the proof-of-delivery and the order state machine lived
-- only in Next.js code. Anyone holding a rider, vendor or manager JWT and the
-- public anon key could skip them by talking to PostgREST directly:
--
--   * a rider could READ orders.delivery_otp (the code the customer reads out
--     at the door) and UPDATE orders / their own deliveries row, including
--     cod_collected_amount;
--   * the owning vendor and any manager could OVERWRITE pickup_otp / delivery_otp
--     with a value of their own choosing and then "verify" it;
--   * status was only checked in app code, so a vendor could set an order
--     straight to 'delivered' (unlocking reviews and settlement payout) or
--     re-open a cancelled one after its refund;
--   * items could be added to an order after its Razorpay order had been
--     created for the older, smaller total.
--
-- What this changes, and what it deliberately does not:
--
--   1. guard_order_update also locks pickup_otp, delivery_otp, external_id and
--      idempotency_key against non-admin writers. (A column the database does
--      not have is absent from both jsonb rows and compares equal, so this runs
--      before and after the migrations that add them.)
--   2. Riders lose their direct table rights: the rider branch is removed from
--      "orders — read" and "orders — update", and "deliveries — driver update"
--      is dropped. Every rider read and write in the app goes through the
--      service role (src/lib/data-access/driver-orders.ts creates no user-JWT
--      client; /api/driver/location touches profiles only), so no screen
--      changes. Riders keep "deliveries — read" on their own row.
--   3. guard_order_status: a BEFORE UPDATE trigger that allows only the
--      transitions the app itself performs for each non-privileged role:
--        vendor  placed->kitchen|cancelled, kitchen->ready|cancelled, ready->cancelled
--                (KITCHEN_TRANSITIONS in vendor-orders.ts)
--        manager placed->kitchen->ready->on_the_way->delivered
--                (NEXT in manager/actions.ts)
--      Admin, the service role and postgres are exempt, as in the sibling
--      guards. SECURITY INVOKER on purpose: a definer function runs as postgres
--      and would make the current_user exemption true for everyone.
--   4. guard_order_item_insert refuses new items once the order is no longer
--      payment_status = 'pending' or has any payments row, so the total a
--      customer pays can no longer be left behind by later edits.
--
-- NOT changed here (needs an app change; tracked in the audit report):
--   * pickup_otp / delivery_otp are still readable by the owning vendor, managers
--     and the customer through "orders — read". Moving them to their own table
--     with per-role getters is phase 2 of P1-1.
--   * Direct order INSERT still bypasses createOrder's business rules (P2-2).
--
-- Deploy order: apply on staging, run `npm run test:idor` and the driver, vendor
-- and manager flows, then production. No data is changed, nothing is dropped
-- except the two rider policy branches above, and the whole file is idempotent.
--
-- Rollback (if a legitimate flow is found to need a removed right):
--   drop trigger if exists orders_guard_status on public.orders;
--   drop function if exists public.guard_order_status();
--   re-create the policies from 0001_init.sql lines 232-253 and 272-274, and
--   re-declare guard_order_update / guard_order_item_insert from 0053.
-- ============================================================

begin;

-- 1 ----------------------------------------------------------
create or replace function public.guard_order_update()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  locked constant text[] := array[
    'id', 'customer_id', 'restaurant_id',
    'total', 'delivery_fee', 'tax_amount', 'tip',
    'address', 'created_at',
    'payment_method', 'payment_status',
    'accepted_at', 'ready_at', 'cancelled_at',
    'channel', 'placed_by',
    'coupon_code', 'discount',
    'discount_funded_by',
    'cancelled_by',
    -- 0055: the handover proof and the import / dedup keys.
    'pickup_otp', 'delivery_otp',
    'external_id', 'idempotency_key'
  ];
  col     text;
  old_row jsonb := to_jsonb(old);
  new_row jsonb := to_jsonb(new);
begin
  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
     or current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  foreach col in array locked loop
    if (old_row -> col) is distinct from (new_row -> col) then
      raise exception
        'only order status may be changed by this role (attempted: %)', col;
    end if;
  end loop;

  return new;
end;
$$;

-- 2 ----------------------------------------------------------
-- Riders: no direct table access to orders or to writing deliveries.
drop policy if exists "orders — read" on public.orders;
create policy "orders — read" on public.orders for select
  using (
    customer_id = auth.uid()                       -- customer: own
    or public.owns_restaurant(restaurant_id)       -- restaurant: its own orders
    or public.is_admin()                           -- admin: all (audited in app)
  );

drop policy if exists "orders — update" on public.orders;
create policy "orders — update" on public.orders for update
  using (public.owns_restaurant(restaurant_id) or public.is_admin())
  with check (public.owns_restaurant(restaurant_id) or public.is_admin());

drop policy if exists "deliveries — driver update" on public.deliveries;

-- 3 ----------------------------------------------------------
create or replace function public.guard_order_status()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  pair constant text := old.status::text || '>' || new.status::text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
     or current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  if public.owns_restaurant(old.restaurant_id)
     and pair in (
       'placed>kitchen', 'placed>cancelled',
       'kitchen>ready',  'kitchen>cancelled',
       'ready>cancelled'
     ) then
    return new;
  end if;

  if public.is_manager()
     and pair in (
       'placed>kitchen', 'kitchen>ready',
       'ready>on_the_way', 'on_the_way>delivered'
     ) then
    return new;
  end if;

  raise exception 'illegal order status change % for this role', pair
    using errcode = '42501';
end;
$$;

drop trigger if exists orders_guard_status on public.orders;
create trigger orders_guard_status
  before update on public.orders
  for each row
  when (old.status is distinct from new.status)
  execute function public.guard_order_status();

-- 4 ----------------------------------------------------------
create or replace function public.guard_order_item_insert()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  o record;
  m record;
begin
  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
     or current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  select customer_id, restaurant_id, status, payment_status into o
    from public.orders where id = new.order_id;
  if not found or o.customer_id is distinct from auth.uid() or o.status <> 'placed' then
    raise exception 'order_items: you can only add items to your own new order';
  end if;

  -- 0055: once payment has started the total is what the customer is being
  -- charged. A Razorpay order is created for orders.total at that moment, so an
  -- item added afterwards would raise the total while the customer pays the
  -- older, smaller figure.
  if o.payment_status is distinct from 'pending'
     or exists (select 1 from public.payments p where p.order_id = new.order_id) then
    raise exception 'order_items: payment has started for this order';
  end if;

  select name, price, discount_price, available into m
    from public.menu_items
   where id = new.menu_item_id and restaurant_id = o.restaurant_id;
  if not found then
    raise exception 'order_items: item is not on this restaurant''s menu';
  end if;
  if m.available is not true then
    raise exception 'order_items: item is sold out';
  end if;

  if new.qty is null or new.qty < 1 then
    raise exception 'order_items: qty must be at least 1';
  end if;

  -- Same rule as effectivePrice() in src/lib/utils/cart.ts.
  new.price := case
    when m.discount_price is null or m.discount_price < 0 or m.discount_price >= m.price
      then m.price
    else m.discount_price
  end;
  new.name := m.name;
  return new;
end;
$$;

commit;
