-- 0142 — Manager order interventions: the order short code, actors on the
-- event trails, ops notes, and one audited RPC per intervention (advance,
-- cancel, assign, reassign, correct, note) that makes the change and writes
-- its ops_audit_log entry in the same transaction.
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0142.mjs); run it on staging first.
-- Depends on 0061 (order_status_events), 0081 (rider_status, delivery_events,
-- guard_delivery_transition) and 0141 (zones, staff_zones, _ops_log).
-- Plan: docs/superpowers/plans/2026-10-21-manager-app-phase-3-orders-live.md.
--
-- Security changes (docs/SECURITY_AUDIT.md applies):
--   * New column `orders.short_code` (stored, generated from id), granted per
--     column to authenticated (0022 / 0058 rule). It is the first 8 characters
--     of the id, which every screen already prints, so it discloses nothing new.
--   * New table `order_ops_notes`: RLS on, readable by admins and by managers of
--     the order's zone; no write privilege for anon/authenticated. Written only
--     by ops_add_order_note().
--   * Every ops_* RPC is service_role only (revoked from public, anon,
--     authenticated). Each re-checks, in the database, that the actor is an
--     admin or a manager assigned to the order's zone (ops_require_staff), so
--     the RPC is never a way round the route's own check. A rider is checked
--     for eligibility in the database too (_ops_rider_ineligible).
--   * No RPC writes a money column of an order (total, discount, delivery_fee,
--     tax_amount, tip, payment_*). A delivered order with recorded cash or a
--     settlement line is `financially_closed` for status corrections.
--   * log_order_status_event() (0061) and log_delivery_event() (0081) are
--     re-declared with one change each: when auth.uid() is null (the server
--     writing as service_role) the actor is the one the RPC set with
--     _ops_set_actor(), so the event trail names the manager, not "system".
--     log_delivery_event() also carries the RPC's reason onto the
--     `reassigned` and `cancelled` rows.
--
-- Claude's calls (plan, Part S execution notes):
--   * guard_order_update() is NOT re-declared. The RPCs are called with the
--     service-role JWT, which every order guard (guard_order_update,
--     guard_order_status) already exempts; a correction flag would only add a
--     second way through the same door.
--   * The `reassigned` delivery event is written by 0081's trigger (which
--     already names the old rider), with the RPC's reason passed through a
--     transaction-local setting, instead of a manual insert that would make the
--     trigger log the reassignment twice.
--
-- Rollback:
--   drop function if exists public.ops_add_order_note(uuid, uuid, text, text);
--   drop function if exists public.ops_correct_order(uuid, uuid, text, text, uuid, text, text);
--   drop function if exists public.ops_reassign_delivery(uuid, uuid, uuid, text, boolean, text);
--   drop function if exists public.ops_assign_rider(uuid, uuid, uuid, text, text);
--   drop function if exists public.ops_cancel_order(uuid, uuid, text, text);
--   drop function if exists public.ops_advance_order(uuid, uuid, public.order_status, text, text);
--   drop function if exists public._ops_rider_ineligible(uuid, uuid, uuid);
--   drop function if exists public._ops_order_state(uuid);
--   drop function if exists public._ops_replayed(uuid, text);
--   drop function if exists public.ops_require_staff(uuid, uuid);
--   drop table if exists public.order_ops_notes;
--   -- re-run log_delivery_event() from 0081_rider_app_foundation.sql
--   -- re-run log_order_status_event() from 0061_vendor_app_foundation.sql
--   drop function if exists public._ops_set_actor(uuid, text);
--   drop index if exists public.orders_short_code_idx;
--   alter table public.orders drop column if exists short_code;

-- 1. The order code a person can type ------------------------------------------
alter table public.orders
  add column if not exists short_code text generated always as (upper(left(id::text, 8))) stored;

comment on column public.orders.short_code is
  'First 8 characters of the id, upper-cased: the code every screen prints (orderCode()). Searchable by prefix.';

create index if not exists orders_short_code_idx on public.orders (short_code text_pattern_ops);
create index if not exists orders_zone_created_idx on public.orders (zone_id, created_at desc, id desc);
create index if not exists orders_zone_status_idx on public.orders (zone_id, status);
create index if not exists deliveries_driver_status_idx on public.deliveries (driver_id, status);

grant select (short_code) on public.orders to authenticated;

-- 2. Who did it, when the server did it ----------------------------------------
-- Transaction-local: the setting dies with the RPC's transaction, so it cannot
-- leak onto a later request on the same pooled connection.
create or replace function public._ops_set_actor(p_actor uuid, p_reason text default null)
returns void
language sql volatile security definer set search_path = public as $$
  select set_config('deligro.actor_id', coalesce(p_actor::text, ''), true),
         set_config('deligro.ops_reason', coalesce(p_reason, ''), true);
$$;
revoke execute on function public._ops_set_actor(uuid, text) from public, anon, authenticated, service_role;

-- 0061's logger; only the actor changes.
create or replace function public.log_order_status_event()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  actor constant uuid := coalesce(auth.uid(), nullif(current_setting('deligro.actor_id', true), '')::uuid);
begin
  if tg_op = 'INSERT' then
    insert into public.order_status_events (order_id, restaurant_id, kind, from_status, to_status, actor_id)
    values (new.id, new.restaurant_id, 'status', null, new.status, actor);
  elsif new.status is distinct from old.status then
    insert into public.order_status_events (order_id, restaurant_id, kind, from_status, to_status, actor_id, reason)
    values (
      new.id, new.restaurant_id, 'status', old.status, new.status, actor,
      case when new.status = 'cancelled' then new.cancellation_reason
           else nullif(current_setting('deligro.ops_reason', true), '') end
    );
  end if;
  return null;
end;
$$;
revoke all on function public.log_order_status_event() from public;

-- 0081's logger; the actor falls back to the RPC's, and the RPC's reason rides
-- on the reassigned and cancelled rows. Everything else is 0081's, unchanged.
create or replace function public.log_delivery_event()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o         public.deliveries%rowtype;
  marker    constant text := current_setting('deligro.delivery_action', true);
  actor     constant uuid := coalesce(auth.uid(), nullif(current_setting('deligro.actor_id', true), '')::uuid);
  ops_why   constant text := nullif(current_setting('deligro.ops_reason', true), '');
  action    uuid;
begin
  if tg_op = 'UPDATE' then
    o := old;
  end if;

  if new.last_action_id is not null
     and (tg_op = 'INSERT'
          or new.last_action_id is distinct from o.last_action_id
          or marker = new.id::text || ':' || new.last_action_id::text) then
    action := new.last_action_id;
  end if;
  if marker <> '' then
    perform set_config('deligro.delivery_action', '', true);
  end if;

  insert into public.delivery_events
    (delivery_id, order_id, driver_id, kind, method, reason, actor_id, lat, lng, client_action_id)
  select new.id, new.order_id, e.driver, e.kind, e.method, e.reason, actor,
         new.driver_lat, new.driver_lng,
         case when row_number() over (order by e.ord) = 1 then action end
    from (values
      (1,  'offered',        new.offered_driver_id, null::text,          null::text,
           new.offered_driver_id is not null
           and new.offered_driver_id is distinct from o.offered_driver_id),
      (2,  'accepted',       new.driver_id,         null,                null,
           new.status = 'assigned' and coalesce(o.status::text, 'unassigned') = 'unassigned'),
      (3,  'reassigned',     o.driver_id,           null,                ops_why,
           o.driver_id is not null and new.driver_id is not null
           and new.driver_id is distinct from o.driver_id),
      (4,  'arrived_pickup', new.driver_id,         null,                null,
           new.arrived_pickup_at is not null and o.arrived_pickup_at is null),
      (5,  'picked_up',      new.driver_id,         new.pickup_method,   null,
           new.status = 'picked_up' and new.status is distinct from o.status),
      (6,  'departed',       new.driver_id,         null,                null,
           new.departed_pickup_at is not null and o.departed_pickup_at is null),
      (7,  'arrived_drop',   new.driver_id,         null,                null,
           new.arrived_drop_at is not null and o.arrived_drop_at is null),
      (8,  'delivered',      new.driver_id,         new.delivery_method, null,
           new.status = 'delivered' and new.status is distinct from o.status),
      (9,  'failed',         new.driver_id,         null,                new.failure_reason,
           new.status = 'failed' and new.status is distinct from o.status),
      (10, 'cancelled',      new.driver_id,         null,                ops_why,
           new.status = 'cancelled' and new.status is distinct from o.status),
      (11, 'corrected',      new.driver_id,         null,                new.correction_reason,
           new.correction_reason is distinct from o.correction_reason)
    ) as e(ord, kind, driver, method, reason, fire)
   where e.fire
   order by e.ord;

  return null;
end;
$$;
revoke all on function public.log_delivery_event() from public;

-- 3. Ops notes on an order -------------------------------------------------------
create table if not exists public.order_ops_notes (
  id         bigint generated always as identity primary key,
  order_id   uuid not null references public.orders (id) on delete cascade,
  author_id  uuid not null references public.profiles (id),
  body       text not null check (char_length(body) between 3 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists order_ops_notes_order_idx on public.order_ops_notes (order_id, created_at);

comment on table public.order_ops_notes is
  'Internal notes ops staff leave on an order. Never shown to the customer, vendor or rider. Written only by ops_add_order_note().';

alter table public.order_ops_notes enable row level security;
drop policy if exists "order_ops_notes — staff read" on public.order_ops_notes;
create policy "order_ops_notes — staff read" on public.order_ops_notes for select
  using (public.is_admin() or public.manager_can_see_order(order_id));
revoke all on public.order_ops_notes from anon, authenticated;
grant select on public.order_ops_notes to authenticated;

-- 4. Authorisation and shared helpers -------------------------------------------
-- The server calls every ops_* RPC as service_role after managerApiContext();
-- this re-checks the actor against the order's zone so the RPC never widens it.
create or replace function public.ops_require_staff(p_actor uuid, p_zone uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  role_name text;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select p.role::text into role_name from public.profiles p where p.id = p_actor;
  if role_name = 'admin' then
    return role_name;
  end if;
  if role_name = 'manager'
     and p_zone is not null
     and exists (select 1 from public.staff_zones sz where sz.user_id = p_actor and sz.zone_id = p_zone) then
    return role_name;
  end if;
  raise exception 'forbidden' using errcode = '42501';
end;
$$;
revoke execute on function public.ops_require_staff(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ops_require_staff(uuid, uuid) to service_role;

-- Has this actor already done this client action? Someone else's id is a
-- conflict, never a replay.
create or replace function public._ops_replayed(p_actor uuid, p_client_action_id text)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  owner_id uuid;
begin
  if p_client_action_id is null then
    return false;
  end if;
  select actor_id into owner_id from public.ops_audit_log where client_action_id = p_client_action_id;
  if owner_id is null then
    return false;
  end if;
  if owner_id <> p_actor then
    raise exception 'client_action_id_conflict' using errcode = '23505';
  end if;
  return true;
end;
$$;
revoke execute on function public._ops_replayed(uuid, text) from public, anon, authenticated, service_role;

create or replace function public._ops_order_state(p_order uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'order_id', o.id,
    'status', o.status,
    'delivery_status', (select d.status from public.deliveries d where d.order_id = o.id)
  )
  from public.orders o where o.id = p_order;
$$;
revoke execute on function public._ops_order_state(uuid) from public, anon, authenticated, service_role;

-- Why a rider may not take this order, or null. The order of the checks is the
-- order the picker explains them in (live-rules.ts riderEligibility).
create or replace function public._ops_rider_ineligible(p_rider uuid, p_zone uuid, p_current uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  st     public.rider_status%rowtype;
  acct   text;
begin
  if not exists (select 1 from public.profiles p where p.id = p_rider and p.role::text = 'driver') then
    return 'offline';
  end if;
  select * into st from public.rider_status where driver_id = p_rider;
  if st.driver_id is null or not st.is_online then
    return 'offline';
  end if;
  if st.break_until is not null and st.break_until > now() then
    return 'on_break';
  end if;
  if st.last_fix_at is null or st.last_fix_at <= now() - interval '5 minutes' then
    return 'stale_fix';
  end if;
  -- Phase 5 adds profiles.account_status; until then nobody is suspended.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles' and column_name = 'account_status') then
    execute 'select account_status::text from public.profiles where id = $1' into acct using p_rider;
    if acct in ('suspended', 'restricted') then
      return 'suspended';
    end if;
  end if;
  if p_zone is null
     or not exists (select 1 from public.staff_zones sz where sz.user_id = p_rider and sz.zone_id = p_zone) then
    return 'out_of_zone';
  end if;
  if p_current is not null and p_current = p_rider then
    return 'current_rider';
  end if;
  return null;
end;
$$;
revoke execute on function public._ops_rider_ineligible(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- 5. The interventions -------------------------------------------------------------
-- Common shape: lock the order, re-check the zone, honour a replayed client
-- action id, change, log with before/after, return the current state.

create or replace function public.ops_advance_order(
  p_actor uuid, p_order uuid, p_expected public.order_status, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o      public.orders%rowtype;
  target public.order_status;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, o.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_order_state(p_order);
  end if;

  if o.status in ('delivered', 'cancelled') then
    raise exception 'terminal' using errcode = '22023';
  end if;
  if o.status <> p_expected then
    raise exception 'stale' using errcode = '40001';
  end if;
  target := case o.status
              when 'placed' then 'kitchen'
              when 'kitchen' then 'ready'
              when 'ready' then 'on_the_way'
              when 'on_the_way' then 'delivered'
            end;

  perform public._ops_set_actor(p_actor, nullif(trim(coalesce(p_reason, '')), ''));
  update public.orders set status = target where id = p_order;
  perform public._ops_log(p_actor, 'order.advance', 'order', p_order::text, o.zone_id, p_reason,
                          jsonb_build_object('status', o.status), jsonb_build_object('status', target),
                          p_client_action_id);
  return public._ops_order_state(p_order);
end;
$$;

create or replace function public.ops_cancel_order(
  p_actor uuid, p_order uuid, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o         public.orders%rowtype;
  role_name text;
  why       constant text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  role_name := public.ops_require_staff(p_actor, o.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_order_state(p_order);
  end if;
  if why is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if o.status in ('delivered', 'cancelled') then
    raise exception 'terminal' using errcode = '22023';
  end if;

  perform public._ops_set_actor(p_actor, why);
  update public.orders
     set status = 'cancelled', cancelled_by = role_name, cancellation_reason = left(why, 200)
   where id = p_order;
  update public.deliveries
     set status = 'cancelled'
   where order_id = p_order and status in ('unassigned', 'assigned', 'picked_up');
  perform public._ops_log(p_actor, 'order.cancel', 'order', p_order::text, o.zone_id, why,
                          jsonb_build_object('status', o.status), jsonb_build_object('status', 'cancelled'),
                          p_client_action_id);
  return public._ops_order_state(p_order);
end;
$$;

create or replace function public.ops_assign_rider(
  p_actor uuid, p_order uuid, p_rider uuid, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o    public.orders%rowtype;
  d    public.deliveries%rowtype;
  why  text;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, o.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_order_state(p_order);
  end if;
  if o.status in ('delivered', 'cancelled') then
    raise exception 'terminal' using errcode = '22023';
  end if;

  select * into d from public.deliveries where order_id = p_order for update;
  if d.id is not null and d.status <> 'unassigned' then
    raise exception 'already_assigned' using errcode = '23505';
  end if;
  why := public._ops_rider_ineligible(p_rider, o.zone_id, null);
  if why is not null then
    raise exception 'rider_ineligible' using errcode = '22023', detail = why;
  end if;

  perform public._ops_set_actor(p_actor, nullif(trim(coalesce(p_reason, '')), ''));
  if d.id is null then
    insert into public.deliveries (order_id, driver_id, status, assigned_at, driver_location_source)
    values (p_order, p_rider, 'assigned', now(), 'none');
  else
    update public.deliveries
       set driver_id = p_rider, status = 'assigned', assigned_at = now(), driver_location_source = 'none'
     where id = d.id;
  end if;
  perform public._ops_log(p_actor, 'delivery.assign', 'order', p_order::text, o.zone_id, p_reason,
                          jsonb_build_object('riderId', d.driver_id, 'deliveryStatus', d.status),
                          jsonb_build_object('riderId', p_rider, 'deliveryStatus', 'assigned'),
                          p_client_action_id);
  return public._ops_order_state(p_order);
end;
$$;

create or replace function public.ops_reassign_delivery(
  p_actor uuid, p_order uuid, p_rider uuid, p_reason text, p_after_pickup boolean, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o    public.orders%rowtype;
  d    public.deliveries%rowtype;
  why  constant text := nullif(trim(coalesce(p_reason, '')), '');
  bad  text;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, o.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_order_state(p_order);
  end if;
  if why is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into d from public.deliveries where order_id = p_order for update;
  if o.status in ('delivered', 'cancelled') or d.status in ('delivered', 'failed', 'cancelled') then
    raise exception 'terminal' using errcode = '22023';
  end if;
  if d.id is null or d.status = 'unassigned' or d.driver_id is null then
    raise exception 'invalid_transition' using errcode = '22023', detail = 'no rider to reassign; assign instead';
  end if;
  if d.status = 'picked_up' and not coalesce(p_after_pickup, false) then
    raise exception 'picked_up' using errcode = '22023';
  end if;
  bad := public._ops_rider_ineligible(p_rider, o.zone_id, d.driver_id);
  if bad is not null then
    raise exception 'rider_ineligible' using errcode = '22023', detail = bad;
  end if;

  -- 0081's trigger writes the `reassigned` row naming the old rider; the
  -- reason reaches it through _ops_set_actor.
  perform public._ops_set_actor(p_actor, why);
  update public.deliveries set driver_id = p_rider, assigned_at = now() where id = d.id;
  perform public._ops_log(p_actor, 'delivery.reassign', 'order', p_order::text, o.zone_id, why,
                          jsonb_build_object('riderId', d.driver_id, 'deliveryStatus', d.status),
                          jsonb_build_object('riderId', p_rider, 'deliveryStatus', d.status,
                                             'afterPickup', d.status = 'picked_up'),
                          p_client_action_id);
  return public._ops_order_state(p_order);
end;
$$;

create or replace function public.ops_correct_order(
  p_actor uuid, p_order uuid, p_kind text, p_to_status text, p_item uuid, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o        public.orders%rowtype;
  d        public.deliveries%rowtype;
  it       public.order_items%rowtype;
  why      constant text := nullif(trim(coalesce(p_reason, '')), '');
  closed   boolean;
  to_o     public.order_status;
  to_d     public.delivery_status;
  stamp    text;
  refund   uuid;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, o.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_order_state(p_order);
  end if;
  if why is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into d from public.deliveries where order_id = p_order for update;
  closed := o.status = 'delivered'
            and (d.cod_collected_at is not null
                 or exists (select 1 from public.vendor_settlement_orders so where so.order_id = p_order));

  if p_kind = 'status' then
    begin
      to_o := p_to_status::public.order_status;
    exception when others then
      raise exception 'invalid_transition' using errcode = '22023', detail = 'unknown status';
    end;
    if to_o = 'cancelled' or o.status = 'cancelled' or to_o = o.status then
      raise exception 'invalid_transition' using errcode = '22023', detail = 'use cancel, or nothing to change';
    end if;
    if closed then
      raise exception 'financially_closed' using errcode = '22023';
    end if;
    perform public._ops_set_actor(p_actor, why);
    update public.orders set status = to_o where id = p_order;
    perform public._ops_log(p_actor, 'order.correct.status', 'order', p_order::text, o.zone_id, why,
                            jsonb_build_object('status', o.status), jsonb_build_object('status', to_o),
                            p_client_action_id);

  elsif p_kind = 'delivery_status' then
    if d.id is null then
      raise exception 'invalid_transition' using errcode = '22023', detail = 'no delivery';
    end if;
    begin
      to_d := p_to_status::public.delivery_status;
    exception when others then
      raise exception 'invalid_transition' using errcode = '22023', detail = 'unknown delivery status';
    end;
    if to_d = d.status then
      raise exception 'invalid_transition' using errcode = '22023', detail = 'nothing to change';
    end if;
    if closed or d.cod_collected_at is not null then
      raise exception 'financially_closed' using errcode = '22023';
    end if;
    -- A correction is an update that changes correction_reason (0081); the
    -- same sentence twice would not count, so the second carries its time.
    stamp := case when why is distinct from d.correction_reason then why
                  else why || ' (' || to_char(now(), 'YYYY-MM-DD HH24:MI:SS') || ')' end;
    perform public._ops_set_actor(p_actor, why);
    update public.deliveries
       set status = to_d,
           correction_reason = stamp,
           failure_reason = case when to_d = 'failed' then coalesce(failure_reason, why) else failure_reason end
     where id = d.id;
    perform public._ops_log(p_actor, 'order.correct.delivery_status', 'order', p_order::text, o.zone_id, why,
                            jsonb_build_object('deliveryStatus', d.status), jsonb_build_object('deliveryStatus', to_d),
                            p_client_action_id);

  elsif p_kind = 'item_unavailable' then
    select * into it from public.order_items where id = p_item and order_id = p_order;
    if it.id is null then
      raise exception 'invalid_transition' using errcode = '22023', detail = 'item not on this order';
    end if;
    if o.status = 'cancelled' then
      raise exception 'terminal' using errcode = '22023';
    end if;
    if exists (select 1 from public.refunds r where r.order_id = p_order and r.status = 'pending') then
      raise exception 'invalid_transition' using errcode = '22023', detail = 'a refund is already pending on this order';
    end if;
    perform public._ops_set_actor(p_actor, why);
    insert into public.refunds (order_id, amount, reason, status, origin, requested_by)
    values (p_order, it.qty * it.price, why, 'pending', 'manager', p_actor)
    returning id into refund;
    perform public._ops_log(p_actor, 'order.correct.item_unavailable', 'order', p_order::text, o.zone_id, why,
                            jsonb_build_object('itemId', it.id, 'name', it.name, 'qty', it.qty, 'price', it.price),
                            jsonb_build_object('refundId', refund, 'amount', it.qty * it.price),
                            p_client_action_id);
  else
    raise exception 'invalid_transition' using errcode = '22023', detail = 'unknown correction kind';
  end if;

  return public._ops_order_state(p_order);
end;
$$;

create or replace function public.ops_add_order_note(
  p_actor uuid, p_order uuid, p_note text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o     public.orders%rowtype;
  body  constant text := trim(coalesce(p_note, ''));
  nid   bigint;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, o.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_order_state(p_order);
  end if;
  if char_length(body) < 3 or char_length(body) > 1000 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  insert into public.order_ops_notes (order_id, author_id, body) values (p_order, p_actor, body)
  returning id into nid;
  perform public._ops_log(p_actor, 'order.note', 'order', p_order::text, o.zone_id, null,
                          null, jsonb_build_object('noteId', nid, 'body', body), p_client_action_id);
  return public._ops_order_state(p_order);
end;
$$;

revoke execute on function public.ops_advance_order(uuid, uuid, public.order_status, text, text) from public, anon, authenticated;
revoke execute on function public.ops_cancel_order(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ops_assign_rider(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ops_reassign_delivery(uuid, uuid, uuid, text, boolean, text) from public, anon, authenticated;
revoke execute on function public.ops_correct_order(uuid, uuid, text, text, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ops_add_order_note(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.ops_advance_order(uuid, uuid, public.order_status, text, text) to service_role;
grant execute on function public.ops_cancel_order(uuid, uuid, text, text) to service_role;
grant execute on function public.ops_assign_rider(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.ops_reassign_delivery(uuid, uuid, uuid, text, boolean, text) to service_role;
grant execute on function public.ops_correct_order(uuid, uuid, text, text, uuid, text, text) to service_role;
grant execute on function public.ops_add_order_note(uuid, uuid, text, text) to service_role;
