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
--   * Managers lose their direct write path on `orders` and `deliveries`:
--     0141's "orders — manager update" and "deliveries — manager manage"
--     policies are dropped, so a manager's own JWT can no longer PATCH a status
--     or a delivery around the audited RPCs. Every manager write is an ops_*
--     RPC called by the server (web portal included, since Phase 3).
--   * Refunds are no longer "one approved per order" (0056's unique index is
--     dropped): an item refund and a later cancellation are two refunds of one
--     order. The invariant that index protected — never refund more than the
--     customer paid — is now `guard_refund_total`: approved plus this refund
--     never exceeds the order total, checked under a lock on the order row.
--     Refunds are queued by one function, `_ops_queue_refund` (paid orders only,
--     one open refund per order that is topped up, never over the total).
--   * New column `orders.ops_address_note` (granted per column): a delivery
--     note ops add for the rider. Written only by ops_correct_order().
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
--   drop function if exists public.ops_order_queue_facts(uuid[], boolean);
--   drop function if exists public.ops_add_order_note(uuid, uuid, text, text);
--   drop function if exists public.ops_correct_order(uuid, uuid, text, text, uuid, text, text, text);
--   drop function if exists public.ops_reassign_delivery(uuid, uuid, uuid, text, boolean, text, boolean);
--   drop function if exists public.ops_assign_rider(uuid, uuid, uuid, text, text, boolean);
--   drop function if exists public.ops_cancel_order(uuid, uuid, text, text);
--   drop function if exists public.ops_advance_order(uuid, uuid, public.order_status, text, text);
--   drop function if exists public._ops_rider_ineligible(uuid, uuid, uuid);
--   drop function if exists public._ops_order_state(uuid, boolean);
--   drop function if exists public.queue_order_refund(uuid, integer, text, text, uuid);
--   drop function if exists public._ops_queue_refund(uuid, integer, text, text, uuid);
--   drop trigger if exists guard_refund_total on public.refunds;
--   drop function if exists public.guard_refund_total();
--   -- re-create 0056's refunds_one_approved_per_order only if no order has two approved refunds
--   -- re-create 0141's "orders — manager update" and "deliveries — manager manage" policies
--   alter table public.orders drop column if exists ops_address_note;
--   drop index if exists public.delivery_events_order_created_idx;
--   drop index if exists public.orders_zone_created_id_idx;
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
-- Not 0141's `orders_zone_created_idx` (zone_id, created_at): the keyset page
-- orders by (created_at, id), and a reused name would be skipped by `if not exists`.
create index if not exists orders_zone_created_id_idx on public.orders (zone_id, created_at desc, id desc);
-- The order detail's timeline reads delivery events by order (0081 indexes delivery and rider only).
create index if not exists delivery_events_order_created_idx on public.delivery_events (order_id, created_at);
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

-- 3b. A delivery note for the rider (§3.16 "delivery address note") -------------
alter table public.orders
  add column if not exists ops_address_note text;
do $$
begin
  alter table public.orders
    add constraint orders_ops_address_note_len check (ops_address_note is null or char_length(ops_address_note) between 3 and 300);
exception
  when duplicate_object then null;
end $$;
comment on column public.orders.ops_address_note is
  'A note ops add about the drop address (gate code, landmark the customer gave by phone). Shown to the rider. Written only by ops_correct_order().';
grant select (ops_address_note) on public.orders to authenticated;

-- 3c. No direct manager writes -----------------------------------------------------
-- Every manager write is an audited ops_* RPC; the JWT path around them goes.
drop policy if exists "orders — manager update" on public.orders;
drop policy if exists "deliveries — manager manage" on public.deliveries;

-- 3d. Refunds: partial refunds, never more than was paid ---------------------------
-- 0056's index allowed one approved refund per order, which made an item refund
-- followed by a cancellation impossible to pay out. The rule that matters is the
-- money: approved refunds plus this one never exceed the order total.
drop index if exists public.refunds_one_approved_per_order;

create or replace function public.guard_refund_total()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  order_total integer;
  approved    integer;
begin
  if new.status::text not in ('pending', 'approved') then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.status = old.status and new.amount = old.amount then
    return new;
  end if;
  -- The order row is the lock two concurrent approvals queue behind.
  select o.total into order_total from public.orders o where o.id = new.order_id for update;
  select coalesce(sum(r.amount), 0)::int into approved
    from public.refunds r
   where r.order_id = new.order_id and r.status = 'approved' and r.id <> new.id;
  if approved + new.amount > coalesce(order_total, 0) then
    raise exception 'refund_exceeds_total' using errcode = '23514',
      detail = format('approved %s + this refund %s exceeds the order total %s', approved, new.amount, coalesce(order_total, 0));
  end if;
  return new;
end;
$$;
revoke all on function public.guard_refund_total() from public;

drop trigger if exists guard_refund_total on public.refunds;
create trigger guard_refund_total
  before insert or update of status, amount on public.refunds
  for each row execute function public.guard_refund_total();

-- Queue (or top up) the refund of a paid order. `p_amount` null = everything not
-- yet refunded or queued. Paid orders only (queueRefundForOrder's rule): an
-- uncollected COD order or an unpaid checkout has nothing to give back. One open
-- refund per order (0026's index): a second request adds to it. Returns the
-- open refund's id and what THIS call added (0 when nothing).
create or replace function public._ops_queue_refund(
  p_order uuid, p_amount integer, p_reason text, p_origin text, p_requested_by uuid
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o        public.orders%rowtype;
  approved integer;
  open_id  uuid;
  open_amt integer;
  room     integer;
  delta    integer;
  why      constant text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null or coalesce(o.payment_status::text, '') <> 'paid' then
    return jsonb_build_object('refund_id', null, 'amount', 0, 'paid', false);
  end if;
  select coalesce(sum(amount), 0)::int into approved
    from public.refunds where order_id = p_order and status = 'approved';
  select id, amount into open_id, open_amt
    from public.refunds where order_id = p_order and status = 'pending' for update;
  room  := greatest(0, coalesce(o.total, 0) - approved - coalesce(open_amt, 0));
  delta := least(coalesce(p_amount, room), room);
  if delta <= 0 then
    return jsonb_build_object('refund_id', open_id, 'amount', 0, 'paid', true);
  end if;
  if open_id is not null then
    update public.refunds
       set amount = amount + delta,
           reason = left(concat_ws('; ', nullif(reason, ''), why), 500)
     where id = open_id;
  else
    insert into public.refunds (order_id, amount, reason, status, origin, requested_by)
    values (p_order, delta, left(why, 500), 'pending', p_origin, p_requested_by)
    returning id into open_id;
  end if;
  return jsonb_build_object('refund_id', open_id, 'amount', delta, 'paid', true);
end;
$$;
revoke execute on function public._ops_queue_refund(uuid, integer, text, text, uuid) from public, anon, authenticated, service_role;

-- The server's entry to the same rule (queueRefundForOrder): service role only.
create or replace function public.queue_order_refund(
  p_order uuid, p_amount integer, p_reason text, p_origin text, p_requested_by uuid
)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return public._ops_queue_refund(p_order, p_amount, p_reason, p_origin, p_requested_by);
end;
$$;
revoke execute on function public.queue_order_refund(uuid, integer, text, text, uuid) from public, anon, authenticated;
grant execute on function public.queue_order_refund(uuid, integer, text, text, uuid) to service_role;

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

-- `replayed` tells the server whether THIS call did the work: side effects
-- (pushes, dispatch, cash) run only when it is false, so two concurrent sends of
-- one client action — serialised by the order row lock — fire them once.
drop function if exists public._ops_order_state(uuid);
create or replace function public._ops_order_state(p_order uuid, p_replayed boolean default false)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'order_id', o.id,
    'status', o.status,
    'delivery_status', (select d.status from public.deliveries d where d.order_id = o.id),
    'replayed', coalesce(p_replayed, false)
  )
  from public.orders o where o.id = p_order;
$$;
revoke execute on function public._ops_order_state(uuid, boolean) from public, anon, authenticated, service_role;

-- Why a rider may not take this order, or null. The order of the checks is the
-- order the picker explains them in (src/lib/dispatch/eligibility.ts
-- riderIneligibility — the one rule dispatch, the picker and this share). A fix
-- is fresh within 5 minutes either side of now (a phone clock running ahead
-- must not make a position never age out — availability.ts fixIsFresh).
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
  if st.last_fix_at is null
     or st.last_fix_at <= now() - interval '5 minutes'
     or st.last_fix_at >= now() + interval '5 minutes' then
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
-- action id (returning `replayed: true` so the server fires no side effects),
-- change, log with before/after, return the current state. A reason is required
-- for every status change a manager makes (design §6.10).

-- A correction is an update that changes correction_reason (0081); the same
-- sentence twice would not count, so a repeat carries its time.
create or replace function public._ops_correction_stamp(p_prev text, p_why text)
returns text
language sql stable set search_path = public as $$
  select case when p_why is distinct from p_prev then p_why
              else p_why || ' (' || to_char(now(), 'YYYY-MM-DD HH24:MI:SS') || ')' end;
$$;
revoke execute on function public._ops_correction_stamp(text, text) from public, anon, authenticated, service_role;

-- A failed or cancelled delivery of a live order becomes a new leg for this
-- rider: every stamp of the old attempt cleared, recorded as a correction (the
-- one change 0081's guard lets reset a set stamp). History stays in
-- delivery_events.
create or replace function public._ops_new_leg(p_delivery uuid, p_rider uuid, p_why text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  d public.deliveries%rowtype;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  update public.deliveries
     set driver_id = p_rider, status = 'assigned', assigned_at = now(),
         picked_up_at = null, delivered_at = null, failed_at = null, failure_reason = null,
         arrived_pickup_at = null, departed_pickup_at = null, arrived_drop_at = null,
         driver_lat = null, driver_lng = null, driver_location_at = null, driver_location_source = 'none',
         offered_driver_id = null,
         correction_reason = public._ops_correction_stamp(d.correction_reason, 'New delivery attempt: ' || p_why)
   where id = p_delivery;
end;
$$;
revoke execute on function public._ops_new_leg(uuid, uuid, text) from public, anon, authenticated, service_role;

create or replace function public.ops_advance_order(
  p_actor uuid, p_order uuid, p_expected public.order_status, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o      public.orders%rowtype;
  target public.order_status;
  why    constant text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, o.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_order_state(p_order, true);
  end if;
  if why is null then
    raise exception 'reason_required' using errcode = '22023';
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

  perform public._ops_set_actor(p_actor, why);
  update public.orders set status = target where id = p_order;
  perform public._ops_log(p_actor, 'order.advance', 'order', p_order::text, o.zone_id, why,
                          jsonb_build_object('status', o.status), jsonb_build_object('status', target),
                          p_client_action_id);
  return public._ops_order_state(p_order, false);
end;
$$;

-- The refund of a paid order is queued in the same transaction as the
-- cancellation (_ops_queue_refund: the rest of the total, topping up an open
-- item refund), so a cancellation that fails queues nothing.
create or replace function public.ops_cancel_order(
  p_actor uuid, p_order uuid, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o         public.orders%rowtype;
  role_name text;
  why       constant text := nullif(trim(coalesce(p_reason, '')), '');
  refund    jsonb;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  role_name := public.ops_require_staff(p_actor, o.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_order_state(p_order, true) || jsonb_build_object('refund_amount', 0);
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
  refund := public._ops_queue_refund(p_order, null, left(why, 200), role_name, p_actor);
  perform public._ops_log(p_actor, 'order.cancel', 'order', p_order::text, o.zone_id, why,
                          jsonb_build_object('status', o.status),
                          jsonb_build_object('status', 'cancelled', 'refundId', refund -> 'refund_id',
                                             'refundAmount', refund -> 'amount'),
                          p_client_action_id);
  return public._ops_order_state(p_order, false) || jsonb_build_object('refund_amount', refund -> 'amount');
end;
$$;

-- p_override: put an ineligible rider on anyway, for the reasons a manager can
-- see past from where they stand (offline, on a break, no fresh fix — the rider
-- is on the phone with them). Never out of zone, suspended, or the same rider.
-- An override needs a reason and is recorded as one.
create or replace function public.ops_assign_rider(
  p_actor uuid, p_order uuid, p_rider uuid, p_reason text, p_client_action_id text, p_override boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o          public.orders%rowtype;
  d          public.deliveries%rowtype;
  why        constant text := nullif(trim(coalesce(p_reason, '')), '');
  bad        text;
  overridden text;
  new_leg    boolean;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, o.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_order_state(p_order, true);
  end if;
  if o.status in ('delivered', 'cancelled') then
    raise exception 'terminal' using errcode = '22023';
  end if;

  select * into d from public.deliveries where order_id = p_order for update;
  if d.id is not null and d.status not in ('unassigned', 'failed', 'cancelled') then
    raise exception 'already_assigned' using errcode = '23505';
  end if;
  new_leg := d.id is not null and d.status in ('failed', 'cancelled');
  if new_leg and why is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if new_leg and d.cod_collected_at is not null then
    raise exception 'financially_closed' using errcode = '22023';
  end if;
  bad := public._ops_rider_ineligible(p_rider, o.zone_id, null);
  if bad is not null then
    if coalesce(p_override, false) and bad in ('offline', 'on_break', 'stale_fix') then
      if why is null then
        raise exception 'reason_required' using errcode = '22023';
      end if;
      overridden := bad;
    else
      raise exception 'rider_ineligible' using errcode = '22023', detail = bad;
    end if;
  end if;

  perform public._ops_set_actor(p_actor, why);
  if d.id is null then
    insert into public.deliveries (order_id, driver_id, status, assigned_at, driver_location_source)
    values (p_order, p_rider, 'assigned', now(), 'none');
  elsif new_leg then
    perform public._ops_new_leg(d.id, p_rider, why);
  else
    update public.deliveries
       set driver_id = p_rider, status = 'assigned', assigned_at = now(), driver_location_source = 'none'
     where id = d.id;
  end if;
  perform public._ops_log(p_actor, case when overridden is null then 'delivery.assign' else 'delivery.assign.override' end,
                          'order', p_order::text, o.zone_id, why,
                          jsonb_build_object('riderId', d.driver_id, 'deliveryStatus', d.status,
                                             'offeredRiderId', d.offered_driver_id),
                          jsonb_build_object('riderId', p_rider, 'deliveryStatus', 'assigned',
                                             'override', overridden, 'newLeg', new_leg),
                          p_client_action_id);
  return public._ops_order_state(p_order, false);
end;
$$;

create or replace function public.ops_reassign_delivery(
  p_actor uuid, p_order uuid, p_rider uuid, p_reason text, p_after_pickup boolean, p_client_action_id text,
  p_override boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o          public.orders%rowtype;
  d          public.deliveries%rowtype;
  why        constant text := nullif(trim(coalesce(p_reason, '')), '');
  bad        text;
  overridden text;
  new_leg    boolean;
  restamp    boolean;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, o.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_order_state(p_order, true);
  end if;
  if why is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into d from public.deliveries where order_id = p_order for update;
  if o.status in ('delivered', 'cancelled') or d.status = 'delivered' then
    raise exception 'terminal' using errcode = '22023';
  end if;
  if d.id is null or d.status = 'unassigned' or d.driver_id is null then
    raise exception 'invalid_transition' using errcode = '22023', detail = 'no rider to reassign; assign instead';
  end if;
  new_leg := d.status in ('failed', 'cancelled');
  if new_leg and d.cod_collected_at is not null then
    raise exception 'financially_closed' using errcode = '22023';
  end if;
  if d.status = 'picked_up' and not coalesce(p_after_pickup, false) then
    raise exception 'picked_up' using errcode = '22023';
  end if;
  bad := public._ops_rider_ineligible(p_rider, o.zone_id, case when new_leg then null else d.driver_id end);
  if bad is not null then
    if coalesce(p_override, false) and bad in ('offline', 'on_break', 'stale_fix') then
      overridden := bad;
    else
      raise exception 'rider_ineligible' using errcode = '22023', detail = bad;
    end if;
  end if;

  -- 0081's trigger writes the `reassigned` row naming the old rider; the
  -- reason reaches it through _ops_set_actor.
  perform public._ops_set_actor(p_actor, why);
  if new_leg then
    perform public._ops_new_leg(d.id, p_rider, why);
  else
    -- The new rider starts their own leg: the old rider's arrival stamps and
    -- position do not carry over (customer tracking would show the old rider).
    -- After pickup the package has left the shop, so only the drop arrival resets.
    restamp := (d.status = 'assigned' and (d.arrived_pickup_at is not null or d.departed_pickup_at is not null))
               or d.arrived_drop_at is not null;
    update public.deliveries
       set driver_id = p_rider, assigned_at = now(),
           driver_lat = null, driver_lng = null, driver_location_at = null, driver_location_source = 'none',
           offered_driver_id = null,
           arrived_pickup_at  = case when d.status = 'assigned' then null else arrived_pickup_at end,
           departed_pickup_at = case when d.status = 'assigned' then null else departed_pickup_at end,
           arrived_drop_at = null,
           correction_reason = case when restamp
                                    then public._ops_correction_stamp(d.correction_reason, 'Reassigned: ' || why)
                                    else correction_reason end
     where id = d.id;
  end if;
  perform public._ops_log(p_actor, case when overridden is null then 'delivery.reassign' else 'delivery.reassign.override' end,
                          'order', p_order::text, o.zone_id, why,
                          jsonb_build_object('riderId', d.driver_id, 'deliveryStatus', d.status,
                                             'offeredRiderId', d.offered_driver_id),
                          jsonb_build_object('riderId', p_rider,
                                             'deliveryStatus', case when new_leg then 'assigned' else d.status::text end,
                                             'afterPickup', d.status = 'picked_up', 'override', overridden,
                                             'newLeg', new_leg),
                          p_client_action_id);
  return public._ops_order_state(p_order, false);
end;
$$;

-- Corrections never touch money: no move INTO delivered (that is advance, with
-- its cash record and delivery close: `use_advance`), none out of a delivered
-- order with recorded cash or a settlement line (`financially_closed`), and an
-- unavailable item is refunded through _ops_queue_refund (paid orders only,
-- one open refund topped up, never above the total), each item once.
drop function if exists public.ops_correct_order(uuid, uuid, text, text, uuid, text, text);
create or replace function public.ops_correct_order(
  p_actor uuid, p_order uuid, p_kind text, p_to_status text, p_item uuid, p_reason text, p_client_action_id text,
  p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o        public.orders%rowtype;
  d        public.deliveries%rowtype;
  it       public.order_items%rowtype;
  why      constant text := nullif(trim(coalesce(p_reason, '')), '');
  note     constant text := nullif(trim(coalesce(p_note, '')), '');
  closed   boolean;
  to_o     public.order_status;
  to_d     public.delivery_status;
  refund   jsonb;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, o.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_order_state(p_order, true);
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
    if to_o = 'delivered' then
      raise exception 'use_advance' using errcode = '22023';
    end if;
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
    if to_d = 'delivered' then
      raise exception 'use_advance' using errcode = '22023';
    end if;
    if to_d = d.status then
      raise exception 'invalid_transition' using errcode = '22023', detail = 'nothing to change';
    end if;
    if closed or d.cod_collected_at is not null then
      raise exception 'financially_closed' using errcode = '22023';
    end if;
    perform public._ops_set_actor(p_actor, why);
    update public.deliveries
       set status = to_d,
           correction_reason = public._ops_correction_stamp(d.correction_reason, why),
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
    if exists (select 1 from public.ops_audit_log l
                where l.action = 'order.correct.item_unavailable' and l.entity_id = p_order::text
                  and l.before ->> 'itemId' = it.id::text) then
      raise exception 'invalid_transition' using errcode = '22023', detail = 'this item is already marked unavailable';
    end if;
    perform public._ops_set_actor(p_actor, why);
    refund := public._ops_queue_refund(p_order, it.qty * it.price, 'Item unavailable: ' || it.name || ' (' || why || ')',
                                       'manager', p_actor);
    perform public._ops_log(p_actor, 'order.correct.item_unavailable', 'order', p_order::text, o.zone_id, why,
                            jsonb_build_object('itemId', it.id, 'name', it.name, 'qty', it.qty, 'price', it.price),
                            jsonb_build_object('refundId', refund -> 'refund_id', 'amount', refund -> 'amount',
                                               'paid', refund -> 'paid'),
                            p_client_action_id);

  elsif p_kind = 'address_note' then
    if o.status in ('delivered', 'cancelled') then
      raise exception 'terminal' using errcode = '22023';
    end if;
    if note is null or char_length(note) < 3 or char_length(note) > 300 then
      raise exception 'invalid_transition' using errcode = '22023', detail = 'note must be 3 to 300 characters';
    end if;
    perform public._ops_set_actor(p_actor, why);
    update public.orders set ops_address_note = note where id = p_order;
    perform public._ops_log(p_actor, 'order.correct.address_note', 'order', p_order::text, o.zone_id, why,
                            jsonb_build_object('note', o.ops_address_note), jsonb_build_object('note', note),
                            p_client_action_id);
  else
    raise exception 'invalid_transition' using errcode = '22023', detail = 'unknown correction kind';
  end if;

  return public._ops_order_state(p_order, false);
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
    return public._ops_order_state(p_order, true);
  end if;
  if char_length(body) < 3 or char_length(body) > 1000 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  insert into public.order_ops_notes (order_id, author_id, body) values (p_order, p_actor, body)
  returning id into nid;
  perform public._ops_log(p_actor, 'order.note', 'order', p_order::text, o.zone_id, null,
                          null, jsonb_build_object('noteId', nid, 'body', body), p_client_action_id);
  return public._ops_order_state(p_order, false);
end;
$$;

-- 6. Queue facts: the lean active-order rows the queue counts and the delayed
-- queues are computed from (live-rules.ts delayFor). One scoped read, oldest
-- first and uncapped (in-flight orders are bounded by the day's operations), no
-- embeds. Unpaid online checkouts are not orders: `ops_counts_as_order` is
-- `isCountedOrder` (src/lib/metrics/definitions.ts). Declared here because this
-- runs before 0144, which re-declares it with the same body.
create or replace function public.ops_counts_as_order(p_method text, p_payment text)
returns boolean
language sql immutable parallel safe set search_path = public as $$
  select coalesce(p_method, '') <> 'online'
      or coalesce(p_payment, '') in ('authorized', 'paid', 'refunded');
$$;

create or replace function public.ops_order_queue_facts(p_zone_ids uuid[], p_all_zones boolean)
returns table (
  id uuid, status text, created_at timestamptz, accepted_at timestamptz, ready_at timestamptz,
  prep_minutes integer, zone_id uuid, eta_min integer, eta_max integer,
  shop_lat double precision, shop_lng double precision, drop_lat double precision, drop_lng double precision,
  delivery_status text, driver_id uuid, picked_up_at timestamptz, failed_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select o.id, o.status::text, o.created_at, o.accepted_at, o.ready_at, o.prep_minutes::int, o.zone_id,
         r.eta_min::int, r.eta_max::int, r.lat::double precision, r.lng::double precision,
         (o.address ->> 'lat')::double precision, (o.address ->> 'lng')::double precision,
         d.status::text, d.driver_id, d.picked_up_at, d.failed_at
    from public.orders o
    join public.restaurants r on r.id = o.restaurant_id
    left join public.deliveries d on d.order_id = o.id
   where o.status in ('placed', 'kitchen', 'ready', 'on_the_way')
     and public.ops_counts_as_order(o.payment_method::text, o.payment_status::text)
     and (coalesce(p_all_zones, false) or o.zone_id = any (coalesce(p_zone_ids, '{}'::uuid[])))
   order by o.created_at asc, o.id asc;
end;
$$;

revoke execute on function public.ops_order_queue_facts(uuid[], boolean) from public, anon, authenticated;
grant execute on function public.ops_order_queue_facts(uuid[], boolean) to service_role;
revoke execute on function public.ops_advance_order(uuid, uuid, public.order_status, text, text) from public, anon, authenticated;
revoke execute on function public.ops_cancel_order(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ops_assign_rider(uuid, uuid, uuid, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.ops_reassign_delivery(uuid, uuid, uuid, text, boolean, text, boolean) from public, anon, authenticated;
revoke execute on function public.ops_correct_order(uuid, uuid, text, text, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_add_order_note(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.ops_advance_order(uuid, uuid, public.order_status, text, text) to service_role;
grant execute on function public.ops_cancel_order(uuid, uuid, text, text) to service_role;
grant execute on function public.ops_assign_rider(uuid, uuid, uuid, text, text, boolean) to service_role;
grant execute on function public.ops_reassign_delivery(uuid, uuid, uuid, text, boolean, text, boolean) to service_role;
grant execute on function public.ops_correct_order(uuid, uuid, text, text, uuid, text, text, text) to service_role;
grant execute on function public.ops_add_order_note(uuid, uuid, text, text) to service_role;
