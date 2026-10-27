-- ============================================================
-- 0180 — Fixes from the 2026-10-27 security audit
-- (security-audit-2026-10-27.html). Three database floors that sat lower than
-- the app check above them, each reachable straight through PostgREST with a
-- customer's or vendor's own session.
--
-- 1. Order charges and order rules (closes most of N-1, docs/SECURITY_AUDIT.md).
--    A customer's own INSERT on `orders` could carry delivery_fee = 0 and
--    tax_amount = 0, and recompute_order_total() summed whatever was there.
--    The same direct insert skipped the platform pause, the minimum order and
--    the shop's "no cash" switch, which lived only in createOrder().
--      - force_order_total_pending() now also zeroes delivery_fee/tax_amount,
--        clamps tip to 0..50 (TIP_OPTIONS in src/lib/pricing.ts) and refuses
--        while platform_settings.accepting_orders is off.
--      - recompute_order_total() now DERIVES delivery_fee and tax_amount from
--        platform_settings and the item subtotal for any caller that is not
--        admin or the service role, and refuses a subtotal below min_order or
--        a COD order on a shop with accept_cod = false. It already runs after
--        every order_items insert (statement trigger, 0053), so it sees the
--        whole basket. Admin and service-role callers (phone orders, legacy
--        import, refunds) keep the stored fee and tax, as before.
--    The arithmetic mirrors computeChargesWith() in src/lib/pricing.ts and must
--    stay identical to it: fee unless subtotal >= a non-zero free threshold;
--    tax = Math.round(subtotal * tax_rate), done in float8 as floor(x + 0.5),
--    which is what JS computes (Postgres round() on float8 rounds half to
--    even, and on numeric differs from JS float for some rates).
--    Still open, until order creation moves behind place_order(): the COD
--    ceiling (cod_max_order is checked against the post-coupon amount, and the
--    coupon is applied after the items) and the delivery-area check (a second
--    geo implementation). See N-1.
--
-- 2. Coupons. "coupons — vendor delete" and the USING side of "coupons —
--    vendor update" checked only shop ownership, so a vendor could delete a
--    platform-funded code an admin or manager scoped to their shop, or PATCH it
--    to funded_by = 'vendor' (which passed WITH CHECK) and then edit it. Both
--    now also require funded_by = 'vendor', the rule /api/vendor/offers/[code]
--    already applied.
--
-- 3. orders.ops_address_note (0142) is "written only by ops_correct_order()",
--    but was never added to guard_order_update()'s locked list, and nothing
--    cleared it on insert: a vendor could PATCH it on their shop's orders and a
--    customer could set it on their own insert, and the rider app shows it as
--    "Note from Deligro". Locked on update; cleared on any non-service insert.
--
-- Depends on 0015, 0041, 0051, 0053, 0141, 0142. Re-declares functions last
-- declared there, with their bodies carried over unchanged except as noted.
-- Idempotent: safe to re-run.
-- ============================================================

begin;

-- ---------- 1a. the insert pin ----------
create or replace function public.force_order_total_pending()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
     or current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  -- 0180: the platform pause is the database's call too, not only the app's.
  if exists (select 1 from public.platform_settings where accepting_orders = false) then
    raise exception 'orders_paused';
  end if;

  new.total              := 0;
  new.discount           := 0;
  new.coupon_code        := null;
  new.discount_funded_by := null;
  -- 0180: charges are derived by recompute_order_total() once the items exist.
  new.delivery_fee       := 0;
  new.tax_amount         := 0;
  -- 0180: the largest tip the checkout offers (TIP_OPTIONS, src/lib/pricing.ts).
  new.tip                := least(greatest(coalesce(new.tip, 0), 0), 50);
  -- 0053: a customer's own insert is always a fresh order from the app.
  new.status             := 'placed';
  new.channel            := 'app';
  new.placed_by          := null;
  new.accepted_at        := null;
  new.ready_at           := null;
  new.cancelled_at       := null;
  return new;
end;
$$;

-- ---------- 1b. the total, with charges derived ----------
create or replace function public.recompute_order_total(oid uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  trusted   boolean := public.is_admin()
                       or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin');
  ord       record;
  s         record;
  subtotal  integer;
  fee       integer;
  tax       integer;
begin
  if not (
    trusted
    or exists (
      select 1 from public.orders
       where id = oid and customer_id = auth.uid() and status = 'placed'
    )
  ) then
    raise exception 'recompute_order_total: not allowed for this order';
  end if;

  select coalesce(sum(oi.qty * oi.price), 0)::integer into subtotal
    from public.order_items oi where oi.order_id = oid;

  if not trusted then
    select o2.restaurant_id, o2.payment_method into ord from public.orders o2 where o2.id = oid;

    -- No settings row: the same defaults the app falls back to (settings-defaults.ts).
    select coalesce(max(ps.delivery_fee), 29)            as delivery_fee,
           coalesce(max(ps.tax_rate), 0.05)              as tax_rate,
           coalesce(max(ps.free_delivery_threshold), 0)  as free_threshold,
           coalesce(max(ps.min_order), 0)                as min_order
      into s
      from public.platform_settings ps;

    if s.min_order > 0 and subtotal < s.min_order then
      raise exception 'orders: below the minimum order';
    end if;

    if ord.payment_method = 'cod' and exists (
      select 1 from public.restaurants r where r.id = ord.restaurant_id and r.accept_cod = false
    ) then
      raise exception 'orders: this shop does not take cash';
    end if;

    -- computeChargesWith(), src/lib/pricing.ts.
    fee := case
      when subtotal > 0 and not (s.free_threshold > 0 and subtotal >= s.free_threshold)
        then s.delivery_fee
      else 0
    end;
    tax := floor(subtotal::float8 * s.tax_rate::float8 + 0.5)::integer;

    update public.orders
       set delivery_fee = fee, tax_amount = tax
     where id = oid;
  end if;

  update public.orders o
     set total = greatest(0, subtotal + o.delivery_fee + o.tax_amount + o.tip - o.discount)
   where o.id = oid;
end;
$$;

-- ---------- 2. coupons: a vendor manages only the codes it funds ----------
drop policy if exists "coupons — vendor update" on public.coupons;
create policy "coupons — vendor update" on public.coupons for update
  using (
    funded_by = 'vendor'
    and restaurant_id in (
      select id from public.restaurants where owner_id = auth.uid()
    )
  )
  with check (
    funded_by = 'vendor'
    and restaurant_id in (
      select id from public.restaurants where owner_id = auth.uid()
    )
  );

drop policy if exists "coupons — vendor delete" on public.coupons;
create policy "coupons — vendor delete" on public.coupons for delete
  using (
    funded_by = 'vendor'
    and restaurant_id in (
      select id from public.restaurants where owner_id = auth.uid()
    )
  );

-- ---------- 3. ops_address_note: written only by ops_correct_order() ----------
-- 0141's guard with ops_address_note added to the locked list.
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
    'external_id', 'idempotency_key',
    -- 0061: stamped only by start_preparing().
    'preparing_at',
    -- 0063: stamped only by assign_invoice_no().
    'invoice_no', 'invoice_at',
    -- 0082: the customer's note to the rider.
    'delivery_instructions',
    -- 0141: derived from the restaurant at insert.
    'zone_id',
    -- 0180: the ops note to the rider (0142), set only by ops_correct_order().
    'ops_address_note'
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

-- 0051's insert reset, plus the ops note: no insert path sets it legitimately
-- (ops_correct_order() writes it by UPDATE), so a customer's insert stores null.
-- Guarded on the column existing: this trigger runs on every checkout, and a
-- database without 0142 must keep taking orders.
create or replace function public.clear_order_cancellation_on_insert()
returns trigger
language plpgsql set search_path = public as $$
begin
  new.cancelled_by        := null;
  new.cancellation_reason := null;
  if to_jsonb(new) ? 'ops_address_note'
     and coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin')
     and current_user not in ('postgres', 'supabase_admin') then
    new.ops_address_note := null;
  end if;
  return new;
end;
$$;

commit;
