-- ============================================================
-- 0056 — Review, refund, coupon and vendor-field policy gaps
--        (2026-10-12 readiness audit, P1-3 / P2-3 / P2-4 / P2-5)
-- ------------------------------------------------------------
-- Everything here closes a path where a signed-in user could write something
-- through PostgREST that the app itself never writes. No data is changed or
-- deleted. Idempotent. Apply after 0055.
--
--   1. reviews: the insert policy never tied reviews.restaurant_id to the order
--      being reviewed, so one delivered order could vote against ANY shop (the
--      rating trigger then moves that shop's average). Table-level UPDATE was
--      also never revoked (0033 revoked SELECT only), so the column grant did
--      not narrow it: an author could rewrite restaurant_id, order_id or
--      created_at (re-opening the edit window). review_replies: same, and a
--      vendor could move their reply under a competitor's review.
--   2. refunds: a customer's own insert may only be a plain customer request.
--      origin, requested_by, decided_by, provider_refund_id and settled_at are
--      forced server-side, so a row cannot pose as admin-, vendor- or
--      system-originated or squat on a gateway refund id. And at most one
--      APPROVED refund per order (the existing index covers only 'pending').
--   3. restaurants: a vendor can no longer write rating, rating_count,
--      rating_sum, promoted, sort_position or owner_phone_verified on their own
--      shop. The lock trigger becomes SECURITY INVOKER with the current_user
--      exemption, because the review-rating trigger (SECURITY DEFINER) updates
--      those same columns inside a customer's request and must keep working.
--   4. coupons: advisory lock per code across count-then-insert in
--      apply_coupon_to_order (body copied verbatim from 0041 plus one line).
--   5. profiles.wallet_balance: not self-writable, and never negative. Latent
--      today (nothing reads or writes the wallet), a money bug the day it ships.
--
-- Rollback: re-declare the functions from 0033 / 0034 / 0041 / 0053 and drop
--   triggers refunds_force_provenance; drop index refunds_one_approved_per_order;
--   the policy and grant changes in section 1 are reverted by the 0033 text.
-- ============================================================

begin;

-- 1 ----------------------------------------------------------
drop policy if exists "reviews — owner insert" on public.reviews;
create policy "reviews — owner insert" on public.reviews for insert
  with check (
    user_id = auth.uid()
    and status = 'published'
    and exists (
      select 1 from public.orders o
       where o.id = order_id
         and o.customer_id = auth.uid()
         and o.status = 'delivered'
         and o.restaurant_id = reviews.restaurant_id
    )
    and public.review_window_open(order_id)
  );

revoke update on public.reviews from authenticated;
grant update (
  rating, comment, food_quality, packaging, delivery_experience,
  value_for_money, photos, edited_at
) on public.reviews to authenticated;

revoke update on public.review_replies from authenticated;
grant update (reply_text, edited_at) on public.review_replies to authenticated;

-- 2 ----------------------------------------------------------
create or replace function public.refunds_force_provenance()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
     or current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  new.status             := 'pending';
  new.origin             := 'customer';
  new.requested_by       := auth.uid();
  new.decided_by         := null;
  new.provider_refund_id := null;
  new.settled_at         := null;
  return new;
end;
$$;

drop trigger if exists refunds_force_provenance on public.refunds;
create trigger refunds_force_provenance
  before insert on public.refunds
  for each row execute function public.refunds_force_provenance();

-- Created only if the data already satisfies it, so a duplicate left by the
-- double-approve race (audit P2-4) does not make this whole migration fail.
-- Resolve any listed order by hand, then re-run.
do $$
begin
  if exists (
    select 1 from public.refunds where status = 'approved'
     group by order_id having count(*) > 1
  ) then
    raise notice 'refunds_one_approved_per_order NOT created: some orders already have more than one approved refund';
  else
    create unique index if not exists refunds_one_approved_per_order
      on public.refunds (order_id) where status = 'approved';
  end if;
end $$;

-- 3 ----------------------------------------------------------
create or replace function public.lock_restaurant_privileged_fields()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
     or current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  if new.approved       is distinct from old.approved
  or new.status         is distinct from old.status
  or new.owner_id       is distinct from old.owner_id
  or new.commission_pct is distinct from old.commission_pct then
    raise exception 'approval, ownership and commission are admin-only';
  end if;

  if new.accept_cod              is distinct from old.accept_cod
  or new.accept_online           is distinct from old.accept_online
  or new.cod_max_order           is distinct from old.cod_max_order
  or new.other_charges_per_order is distinct from old.other_charges_per_order
  or new.settlement_cycle        is distinct from old.settlement_cycle then
    raise exception 'payment rules and settlement terms are admin-only';
  end if;

  -- 0056: ranking and reputation are not the shop's to set.
  if new.rating               is distinct from old.rating
  or new.rating_count         is distinct from old.rating_count
  or new.rating_sum           is distinct from old.rating_sum
  or new.promoted             is distinct from old.promoted
  or new.sort_position        is distinct from old.sort_position
  or new.owner_phone_verified is distinct from old.owner_phone_verified then
    raise exception 'ranking, rating and verification are admin-only';
  end if;

  return new;
end;
$$;

-- 4 ----------------------------------------------------------
create or replace function public.apply_coupon_to_order(oid uuid, coupon text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o          public.orders%rowtype;
  c          public.coupons%rowtype;
  normalized text := upper(trim(coalesce(coupon, '')));
  subtotal   integer;
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

  -- The caller must own the order. Service-role callers (the phone desk, a
  -- future support tool) are trusted to name the order themselves.
  if o.customer_id is distinct from auth.uid()
     and coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin')
     and not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'order_not_found');
  end if;

  -- Only while the order is still being placed. A coupon applied after the
  -- kitchen has accepted it changes a bill somebody has already agreed to.
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

  -- 0056: serialise redemptions of one code. price_coupon() COUNTS prior
  -- redemptions and the insert below happens afterwards, so two concurrent
  -- orders could both read "0 used" and both redeem a one-per-customer or
  -- limited-quantity code. The lock is per code, transaction-scoped (released
  -- when this call returns) and held only across count-then-insert.
  perform pg_advisory_xact_lock(hashtextextended('coupon:' || normalized, 0));

  -- The order's own items are the authority on what the basket was worth —
  -- not a subtotal the client claimed when it asked for a preview. Likewise
  -- `o.restaurant_id`, not a restaurant the client named.
  select coalesce(sum(oi.qty * oi.price), 0) into subtotal
    from public.order_items oi where oi.order_id = oid;

  priced := public.price_coupon(c, subtotal, o.restaurant_id, o.customer_id);
  if not (priced ->> 'ok')::boolean then
    return priced;
  end if;
  amount := (priced ->> 'discount')::integer;

  begin
    insert into public.coupon_redemptions (code, order_id, customer_id, discount)
    values (normalized, oid, o.customer_id, amount);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already_applied');
  end;

  update public.orders
     set coupon_code        = normalized,
         discount           = amount,
         discount_funded_by = c.funded_by
   where id = oid;

  perform public.recompute_order_total(oid);

  return jsonb_build_object(
    'ok', true, 'discount', amount, 'code', normalized,
    'fundedBy', c.funded_by);
end;
$$;

revoke all on function public.apply_coupon_to_order(uuid, text) from public, anon;
grant execute on function public.apply_coupon_to_order(uuid, text)
  to authenticated, service_role;

-- 5 ----------------------------------------------------------
create or replace function public.guard_profile_phone()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if not (
       public.is_admin()
       or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
       or current_user in ('postgres', 'supabase_admin')
     ) then
    if new.phone is distinct from old.phone then
      raise exception 'profiles.phone can only be changed through a verified OTP';
    end if;
    -- 0056: the wallet moves only through server code.
    if new.wallet_balance is distinct from old.wallet_balance then
      raise exception 'profiles.wallet_balance can only be changed by the server';
    end if;
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_wallet_balance_nonneg') then
    -- NOT VALID: enforced for every new write without scanning (or failing on)
    -- rows that already exist.
    alter table public.profiles
      add constraint profiles_wallet_balance_nonneg check (wallet_balance >= 0) not valid;
  end if;
end $$;

commit;
