-- ============================================================
-- 0201 — Customer switches hold for a session talking straight to the database.
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL. Not applied to any database from this branch.
-- Order: after 0200. Depends on 0006, 0011, 0033 (addresses, favorites, reviews),
-- 0013 (orders.tip), 0161 (apply_coupon_to_order), 0191 (the customer's cancel).
--
-- The customer app ships the public Supabase key and a customer's own login, so
-- anything RLS allows that customer can be done without going through /api/*. The
-- API routes refuse a switched-off feature first, with a clear message; this file
-- makes the database refuse the same things:
--
--   * favorites: restrictive policies on read and write. Off reads as empty, so an
--     old app that reads the table directly just shows no favourites.
--   * addresses: restrictive policies on write only. Reads stay, so an old app that
--     ignores the switch can still deliver to an address it already has.
--   * reviews: a customer can't add or edit their own review. Shops replying and
--     staff moderating are other people's writes and are not touched.
--   * orders: no insert with a tip while tips are off.
--   * apply_coupon_to_order: refuses while promo codes are off ('feature_off').
--   * customer_cancel_order: refuses while cancelling is off ('feature_off'), and
--     customer_cancel_seconds_left answers 0, so a screen offers no Cancel button.
--
-- Everything else a customer switch covers already goes through the service role
-- or an API route: delivery instructions (0082), rider ratings (0084). A customer
-- can still change their own name directly under the profiles policy; that is
-- their own display name, and blocking self-updates on profiles would also hit the
-- other roles, so `customer.profile_edit` is held at /api/profile.
--
-- Bodies copied from 0161 and 0191 with the one check added.
--
-- Security review (docs/SECURITY_AUDIT.md): policies only remove access. Each is
-- `as restrictive ... to authenticated`, so it narrows the existing policies, which
-- are unchanged. service_role and an admin are not affected. The switch is read
-- once per statement (the subquery around customer_feature_on).
--
-- Rollback:
--   drop policy if exists "favorites — switch read" on public.favorites;
--   drop policy if exists "favorites — switch insert" on public.favorites;
--   drop policy if exists "favorites — switch update" on public.favorites;
--   drop policy if exists "favorites — switch delete" on public.favorites;
--   drop policy if exists "addresses — switch insert" on public.addresses;
--   drop policy if exists "addresses — switch update" on public.addresses;
--   drop policy if exists "addresses — switch delete" on public.addresses;
--   drop policy if exists "reviews — switch insert" on public.reviews;
--   drop policy if exists "reviews — switch update" on public.reviews;
--   drop policy if exists "orders — switch tip" on public.orders;
--   -- then re-run apply_coupon_to_order from 0161 and the two cancel functions from 0191.
--
-- Idempotent: safe to re-run.
-- ============================================================

begin;

-- 1. Favourites ------------------------------------------------------------------
drop policy if exists "favorites — switch read" on public.favorites;
create policy "favorites — switch read" on public.favorites
  as restrictive for select to authenticated
  using ((select public.customer_feature_on('customer.favorites')));
drop policy if exists "favorites — switch insert" on public.favorites;
create policy "favorites — switch insert" on public.favorites
  as restrictive for insert to authenticated
  with check ((select public.customer_feature_on('customer.favorites')));
drop policy if exists "favorites — switch update" on public.favorites;
create policy "favorites — switch update" on public.favorites
  as restrictive for update to authenticated
  using ((select public.customer_feature_on('customer.favorites')));
drop policy if exists "favorites — switch delete" on public.favorites;
create policy "favorites — switch delete" on public.favorites
  as restrictive for delete to authenticated
  using ((select public.customer_feature_on('customer.favorites')));

-- 2. Saved addresses -------------------------------------------------------------
drop policy if exists "addresses — switch insert" on public.addresses;
create policy "addresses — switch insert" on public.addresses
  as restrictive for insert to authenticated
  with check ((select public.customer_feature_on('customer.saved_addresses')));
drop policy if exists "addresses — switch update" on public.addresses;
create policy "addresses — switch update" on public.addresses
  as restrictive for update to authenticated
  using ((select public.customer_feature_on('customer.saved_addresses')));
drop policy if exists "addresses — switch delete" on public.addresses;
create policy "addresses — switch delete" on public.addresses
  as restrictive for delete to authenticated
  using ((select public.customer_feature_on('customer.saved_addresses')));

-- 3. Reviews: the author's own writes only ---------------------------------------
drop policy if exists "reviews — switch insert" on public.reviews;
create policy "reviews — switch insert" on public.reviews
  as restrictive for insert to authenticated
  with check (user_id is distinct from auth.uid() or (select public.customer_feature_on('customer.reviews')));
drop policy if exists "reviews — switch update" on public.reviews;
create policy "reviews — switch update" on public.reviews
  as restrictive for update to authenticated
  using (user_id is distinct from auth.uid() or (select public.customer_feature_on('customer.reviews')));

-- 4. Tips ------------------------------------------------------------------------
drop policy if exists "orders — switch tip" on public.orders;
create policy "orders — switch tip" on public.orders
  as restrictive for insert to authenticated
  with check (coalesce(tip, 0) = 0 or (select public.customer_feature_on('customer.tips')));

-- 5. Promo codes: 0161's body, plus the switch ------------------------------------
create or replace function public.apply_coupon_to_order(oid uuid, coupon text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o          public.orders%rowtype;
  c          public.coupons%rowtype;
  normalized text := upper(trim(coalesce(coupon, '')));
  subtotal   integer;
  eligible   integer;
  priced     jsonb;
  amount     integer;
begin
  if normalized = '' then
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;

  select * into o from public.orders where id = oid;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'order_not_found');
  end if;

  if o.customer_id is distinct from auth.uid()
     and coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin')
     and not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'order_not_found');
  end if;

  -- 0201: Admin → App features. True for the service role and for an admin.
  if not public.customer_feature_on('customer.promo_codes') then
    return jsonb_build_object('ok', false, 'error', 'feature_off');
  end if;

  if o.status <> 'placed' then
    return jsonb_build_object('ok', false, 'error', 'order_not_open');
  end if;
  if o.coupon_code is not null then
    return jsonb_build_object('ok', false, 'error', 'already_applied');
  end if;

  select * into c from public.coupons where code = normalized;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  -- 0056: serialise redemptions of one code (count-then-insert).
  perform pg_advisory_xact_lock(hashtextextended('coupon:' || normalized, 0));

  select coalesce(sum(oi.qty * oi.price), 0) into subtotal from public.order_items oi where oi.order_id = oid;
  select coalesce(sum(oi.qty * oi.price), 0) into eligible
    from public.order_items oi
    join public.coupon_items ci on ci.menu_item_id = oi.menu_item_id and ci.code = normalized
   where oi.order_id = oid;

  priced := public.price_coupon(c, subtotal, o.restaurant_id, o.customer_id, o.zone_id, eligible);
  if not (priced ->> 'ok')::boolean then
    return priced;
  end if;
  amount := (priced ->> 'discount')::integer;

  begin
    insert into public.coupon_redemptions (code, order_id, customer_id, discount) values (normalized, oid, o.customer_id, amount);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already_applied');
  end;

  update public.orders set coupon_code = normalized, discount = amount, discount_funded_by = c.funded_by where id = oid;
  perform public.recompute_order_total(oid);

  return jsonb_build_object('ok', true, 'discount', amount, 'code', normalized, 'fundedBy', c.funded_by);
end;
$$;
revoke all on function public.apply_coupon_to_order(uuid, text) from public, anon;
grant execute on function public.apply_coupon_to_order(uuid, text) to authenticated, service_role;

-- 6. Cancelling: 0191's bodies, plus the switch -----------------------------------
create or replace function public.customer_cancel_seconds_left(p_order uuid)
returns integer
language plpgsql stable security definer set search_path = public as $$
declare
  o public.orders%rowtype;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null or o.customer_id is distinct from auth.uid() or o.status <> 'placed' or o.created_at > now() then
    return 0;
  end if;
  -- 0201: off means no button, on every app version.
  if not public.customer_feature_on('customer.cancel') then
    return 0;
  end if;
  return greatest(0, floor(public._customer_cancel_seconds() - extract(epoch from now() - o.created_at)))::integer;
end;
$$;
revoke all on function public.customer_cancel_seconds_left(uuid) from public, anon;
grant execute on function public.customer_cancel_seconds_left(uuid) to authenticated;

create or replace function public.customer_cancel_order(p_order uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o   public.orders%rowtype;
  uid constant uuid := auth.uid();
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into o from public.orders where id = p_order for update;
  if o.id is null or o.customer_id is distinct from uid then
    raise exception 'not_found' using errcode = '22023';
  end if;
  -- A second tap, or a retry after a lost answer: already done, nothing to repeat.
  if o.status = 'cancelled' and o.cancelled_by = 'customer' then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;
  -- 0201: Admin → App features.
  if not public.customer_feature_on('customer.cancel') then
    raise exception 'feature_off' using errcode = '42501';
  end if;
  if o.status <> 'placed'
     or o.created_at > now()
     or now() - o.created_at > make_interval(secs => public._customer_cancel_seconds()) then
    raise exception 'too_late' using errcode = '22023';
  end if;

  update public.orders
     set status = 'cancelled', cancelled_by = 'customer'
   where id = p_order;
  return jsonb_build_object('ok', true, 'replayed', false);
end;
$$;
revoke all on function public.customer_cancel_order(uuid) from public, anon;
grant execute on function public.customer_cancel_order(uuid) to authenticated;

commit;
