-- ============================================================
-- 0181 — Fixes from the second security-audit pass (2026-10-28,
-- security-audit-2026-10-27.html, "Run 2"). Builds on 0180.
--
-- 1. Order rules, the rest of N-1 (docs/SECURITY_AUDIT.md). A customer's own
--    PostgREST insert could still:
--      a. finish an order during a platform pause, by inserting the empty
--         order while ordering was open and the items after ops paused it —
--         0180 checked the pause only on the orders INSERT. The pause is now
--         re-checked in recompute_order_total(), which runs after every
--         order_items insert;
--      b. send an order to an address outside the delivery area — the area
--         check lived only in createOrder(). force_order_total_pending() now
--         refuses it, with order_address_in_service_area(), a copy of
--         checkServiceArea() (src/lib/geo/service-area.ts): one circle of
--         platform_settings.delivery_radius_km around Bemetara, an unpinned
--         address always refused, a shop pinned outside the circle refused,
--         radius 0 = unlimited. Keep the two in step;
--      c. place a cash order above the shop's cod_max_order. The ceiling is
--         judged on the amount after the coupon, and the coupon is applied
--         after the items, so it cannot be refused at insert. It is refused
--         where the order becomes the kitchen's: leaving 'placed' for any
--         caller that is not admin or the service role
--         (guard_order_cod_ceiling). createOrder() already refuses these, so
--         only a hand-made order reaches it — and stays 'placed' for ops to
--         cancel.
--
-- 2. invoice_no / invoice_at (0063) were locked on UPDATE but not cleared on
--    INSERT, so a customer could pre-claim a shop's next invoice number and
--    make that shop's next on_the_way/delivered transition fail on
--    orders_invoice_no_unique, every time. clear_order_cancellation_on_insert()
--    now nulls them — and preparing_at and external_id, the other staff-only
--    columns with no insert reset — and pins created_at to now() (settlement
--    periods and ops sweeps window on it), for any non-service insert. Its trigger
--    (orders_clear_cancellation_insert) runs before orders_zz_assign_invoice,
--    so the counter still numbers the order as before.
--
-- 3. Developer alerts (0170). Every NEW error issue queued a push to every
--    developer, and anonymous POST /api/obs/client could open one per distinct
--    message — attacker text in a trusted push. Issues of kind 'client'
--    (browser reports, which anyone can send) no longer queue alerts; they
--    still show in the console. And no more than 30 non-fatal alerts are
--    queued in any hour, whatever their source; a fatal always alerts.
--
-- 4. Admin → Vendors → Reset/Set password now also ends the owner's existing
--    sessions (ops_revoke_vendor_sessions, admin only, service role only).
--
-- 5. lock_restaurant_privileged_fields() (0145) also locks the payout, statutory
--    and owner-contact columns (0017) against a shop owner's own UPDATE.
--
-- Depends on 0015, 0017, 0034, 0051, 0063, 0141, 0145, 0170, 0180. Idempotent: safe to re-run.
-- ============================================================

begin;

-- ---------- 1b. delivery area ----------
create or replace function public.order_address_in_service_area(p_restaurant uuid, p_address jsonb)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  -- PINNED_LOCATION, src/lib/location/pinned.ts.
  c_lat  constant float8 := 21.7157;
  c_lng  constant float8 := 81.5335;
  radius float8;
  a_lat  float8;
  a_lng  float8;
  s      record;
  dist   float8;
begin
  -- No settings row: the app's default (settings-defaults.ts).
  select coalesce(max(ps.delivery_radius_km), 25)::float8 into radius from public.platform_settings ps;

  -- The address must be on the map, whatever the radius.
  if p_address is null
     or jsonb_typeof(p_address -> 'lat') is distinct from 'number'
     or jsonb_typeof(p_address -> 'lng') is distinct from 'number' then
    return false;
  end if;
  if radius <= 0 then
    return true;
  end if;

  a_lat := (p_address ->> 'lat')::float8;
  a_lng := (p_address ->> 'lng')::float8;
  -- Not a place on Earth (21.7 + 360 would measure ~0 km): unpinned, refused.
  if abs(a_lat) > 90 or abs(a_lng) > 180 then
    return false;
  end if;
  dist := 2 * 6371 * asin(least(1, sqrt(
    power(sin(radians(a_lat - c_lat) / 2), 2)
    + cos(radians(c_lat)) * cos(radians(a_lat)) * power(sin(radians(a_lng - c_lng) / 2), 2)
  )));
  if dist > radius then
    return false;
  end if;

  -- A shop pinned outside the circle cannot take town orders; an unpinned one
  -- is taken to be in town.
  select r.lat, r.lng into s from public.restaurants r where r.id = p_restaurant;
  if s.lat is not null and s.lng is not null then
    dist := 2 * 6371 * asin(least(1, sqrt(
      power(sin(radians(s.lat::float8 - c_lat) / 2), 2)
      + cos(radians(c_lat)) * cos(radians(s.lat::float8)) * power(sin(radians(s.lng::float8 - c_lng) / 2), 2)
    )));
    if dist > radius then
      return false;
    end if;
  end if;
  return true;
end;
$$;

revoke all on function public.order_address_in_service_area(uuid, jsonb) from public, anon;
grant execute on function public.order_address_in_service_area(uuid, jsonb) to authenticated, service_role;

-- 0180's insert pin, plus the delivery area.
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

  -- 0181: the delivery area, as checkServiceArea() decides it.
  if not public.order_address_in_service_area(new.restaurant_id, new.address) then
    raise exception 'orders: outside the delivery area';
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

-- ---------- 1a. the pause, re-checked where the order becomes real ----------
-- 0180's recompute_order_total(), plus the pause in the derived branch.
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
    -- 0181: an order started before a pause cannot be completed during it.
    if exists (select 1 from public.platform_settings where accepting_orders = false) then
      raise exception 'orders_paused';
    end if;

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

-- ---------- 1c. the COD ceiling, where the order leaves 'placed' ----------
-- Trust is the JWT, not current_user: start_preparing() and other definer
-- RPCs a vendor calls run as postgres but still act for the vendor.
create or replace function public.guard_order_cod_ceiling()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin') then
    return new;
  end if;
  if new.status <> 'cancelled' and coalesce(new.payment_method, 'cod') = 'cod' and exists (
    select 1 from public.restaurants r
     where r.id = new.restaurant_id and coalesce(r.cod_max_order, 0) > 0 and new.total > r.cod_max_order
  ) then
    raise exception 'orders: over the cash limit for this shop';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_guard_cod_ceiling on public.orders;
create trigger orders_guard_cod_ceiling
  before update on public.orders
  for each row
  when (old.status = 'placed' and new.status is distinct from old.status)
  execute function public.guard_order_cod_ceiling();

-- ---------- 2. staff-only columns are never set by a customer's insert ----------
-- 0180's insert reset, plus invoice_no/invoice_at (0063), preparing_at (0061)
-- and external_id (import dedup key). Each guarded on the column existing:
-- this runs on every checkout, and a database without the migration that
-- added a column must keep taking orders.
create or replace function public.clear_order_cancellation_on_insert()
returns trigger
language plpgsql set search_path = public as $$
declare
  row_cols jsonb := to_jsonb(new);
begin
  new.cancelled_by        := null;
  new.cancellation_reason := null;
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin')
     and current_user not in ('postgres', 'supabase_admin') then
    if row_cols ? 'ops_address_note' then new.ops_address_note := null; end if;
    if row_cols ? 'invoice_no' then
      new.invoice_no := null;
      new.invoice_at := null;
    end if;
    if row_cols ? 'preparing_at' then new.preparing_at := null; end if;
    if row_cols ? 'external_id' then new.external_id := null; end if;
    -- Locked on UPDATE since 0024; settlement periods and the ops sweeps
    -- window on it, so a customer cannot backdate or future-date it either.
    new.created_at := now();
  end if;
  return new;
end;
$$;

-- ---------- 3. developer alerts ----------
-- 0170's trigger: browser-reported issues no longer push, and an hourly cap.
create or replace function public.obs_issue_alert_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  reason text;
begin
  if tg_op = 'INSERT' then
    if new.level in ('error','fatal') then reason := 'new'; end if;
  elsif new.status = 'regressed' and old.status is distinct from 'regressed' then
    reason := 'regressed';
  end if;
  if reason is null then
    return new;
  end if;

  -- 0181: anyone can send a browser report (POST /api/obs/client needs no
  -- session), so a 'client' issue's title is not trusted push content.
  if new.kind = 'client' then
    return new;
  end if;
  -- 0181: a burst of new issues is one incident, not thirty phones buzzing.
  -- A fatal always gets through, so a burst cannot hide an outage.
  if new.level <> 'fatal'
     and (select count(*) from public.obs_issue_alerts where created_at > now() - interval '1 hour') >= 30 then
    return new;
  end if;

  insert into public.obs_issue_alerts (fingerprint, short_id, title, reason, env, level)
  values (new.fingerprint, new.short_id, new.title, reason, new.env, new.level);
  return new;
end;
$$;

revoke all on function public.obs_issue_alert_trg() from public, anon, authenticated;

-- ---------- 4. a vendor password reset ends the old sessions ----------
-- Admin → Vendors → Reset / Set password changed the credential but left every
-- existing session of the shop owner signed in (run 3 of the audit) — the
-- departed employee's phone kept the shop. The same shape as 0162's
-- ops_revoke_customer_sessions: admin only, service role only, the owner
-- resolved from the shop rather than taken from the caller.
create or replace function public.ops_revoke_vendor_sessions(p_actor uuid, p_restaurant uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  owner uuid;
  n integer;
begin
  perform public.ops_require_admin(p_actor);
  select r.owner_id into owner from public.restaurants r where r.id = p_restaurant;
  if owner is null then
    return 0;
  end if;
  delete from auth.sessions where user_id = owner;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.ops_revoke_vendor_sessions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ops_revoke_vendor_sessions(uuid, uuid) to service_role;

-- ---------- 5. payout, statutory and owner details are admin-only ----------
-- A shop owner holds UPDATE on their own row, and 0145's lock never listed the
-- 0017 payout columns: an owner could PATCH their UPI/bank details (which the
-- next settlement snapshots), GSTIN/PAN/FSSAI (printed on tax invoices) or the
-- owner phone (the new-order SMS fallback) straight through PostgREST, with no
-- review and no audit row. No vendor screen writes them; admin and onboarding
-- write them with the admin JWT or the service role, which stay exempt.
create or replace function public.lock_restaurant_privileged_fields()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
     or current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  if new.approved          is distinct from old.approved
  or new.status            is distinct from old.status
  or new.owner_id          is distinct from old.owner_id
  or new.commission_pct    is distinct from old.commission_pct
  or new.zone_id           is distinct from old.zone_id
  or new.status_reason     is distinct from old.status_reason
  or new.status_changed_by is distinct from old.status_changed_by
  or new.status_changed_at is distinct from old.status_changed_at then
    raise exception 'approval, ownership, commission and zone are admin-only';
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

  -- 0181: where the money goes, the shop's legal identifiers, and who the owner is.
  if new.upi_id              is distinct from old.upi_id
  or new.bank_account_name   is distinct from old.bank_account_name
  or new.bank_account_number is distinct from old.bank_account_number
  or new.bank_ifsc           is distinct from old.bank_ifsc
  or new.bank_name           is distinct from old.bank_name
  or new.gst_number          is distinct from old.gst_number
  or new.pan_number          is distinct from old.pan_number
  or new.fssai_number        is distinct from old.fssai_number
  or new.owner_name          is distinct from old.owner_name
  or new.owner_mobile        is distinct from old.owner_mobile
  or new.owner_email         is distinct from old.owner_email then
    raise exception 'payout, statutory and owner details are admin-only';
  end if;

  return new;
end;
$$;

commit;
