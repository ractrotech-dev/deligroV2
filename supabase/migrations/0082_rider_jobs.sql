-- ============================================================
-- 0082 — Rider jobs: delivery exceptions, delivery instructions, proof photos
--        and the dispatch settings
-- STATUS: PENDING APPROVAL — not applied to any database. Staging first.
--         Requires 0081 (rider app foundation).
-- ------------------------------------------------------------
-- Phase 2 of the rider app (plan: docs/superpowers/plans/
-- 2026-10-21-rider-app-phase-2-jobs.md; design: docs/superpowers/specs/
-- 2026-10-21-rider-app-design.md, "Pickup and delivery verification").
--
--   1. `delivery_exceptions` — one table for everything a rider raises on a
--      job. Two families:
--        requests  customer_unreachable, wrong_address, complete_without_code,
--                  failed_delivery, manual_pickup, go_offline
--                  pending -> approved | rejected   (ops decide)
--        reports   return_to_shop, missing_items, wrong_package, vendor_delay,
--                  other_issue
--                  pending -> acknowledged          (ops note it)
--      A CHECK ties each kind to the statuses its family may reach, so a report
--      can never be "approved" into authorising something. At most one
--      `pending` row per (delivery, kind): a double-tap or a replayed queue
--      cannot stack requests in front of ops. A decision is final (section
--      1a): a decided row carries decided_at, and once it leaves `pending` its
--      status and decision never change; its delivery, rider, kind and
--      creation time never change at all.
--   2. `delivery_events.kind` gains `contact_attempt` (method `customer` or
--      `vendor`): the logged call that `customer_unreachable` waits on; and
--      `released` and `withdrawn` (item 6).
--   3. `deliveries.pod_photo_path` — object path of the proof-of-delivery
--      photo in the private `delivery-proofs` bucket (5 MB, JPEG/PNG).
--      `deliveries.distance_source` — how `distance_km` was computed:
--      'road' (the routing server answered) or 'estimate' (straight line x 1.3,
--      stored at acceptance and upgraded to 'road' when routing answers).
--   4. `orders.delivery_instructions` — the customer's note to the rider,
--      300 characters at most.
--   5. `guard_delivery_transition` re-declared. Every 0081 rule stays; added:
--        (6) a non-correction -> delivered also needs old status picked_up
--            (0081 accepted any row carrying a picked_up_at value);
--        (7) -> failed needs an APPROVED failed_delivery, customer_unreachable
--            or wrong_address exception for this delivery, raised by its
--            current rider;
--        (8) delivery_method = 'ops_approved' needs an approved
--            complete_without_code, the same way;
--        (9) pickup_method = 'manual' needs an approved manual_pickup.
--      A correction (correction_reason changed) bypasses 6–9, as it bypasses
--      0081's rules 1, 4 and 5; it still cannot skip the failure reason.
--      An approval counts for 7–9 only if it was raised during the current
--      assignment (created_at >= assigned_at), and assigned_at is stamped by
--      the database when a rider takes the job, so both sides are one clock.
--   5a. `guard_delivery_insert` (new, BEFORE INSERT): outside a correction a
--      delivery is created unassigned or assigned (with a rider), with no
--      pickup/delivery/failure stamp or method — the update guard cannot see
--      a row born past its rules.
--   6. `log_delivery_event` re-declared: a reassignment now writes
--      `reassigned` for the rider who lost the job AND `accepted` for the rider
--      who took it, so each rider's history and timeline is complete from
--      their own rows; a release writes `released`. The session-marker replay
--      check (mark_delivery_action) is unchanged. New `log_delivery_withdrawn`
--      (AFTER DELETE) writes `withdrawn` when an unassigned row holding an
--      offer is deleted, so every `offered` row has an outcome.
--   6a. Release: handing a job back to dispatch (driver_id -> null, status ->
--      unassigned) is a correction, only from `assigned` (before pickup), and
--      the guard clears the first rider's
--      stamps and the offer (offered_driver_id / offered_at) so the next rider
--      can set them (rule 10 in section 7). Each release carries its own
--      correction_reason (`released:<why>:<id>`): an update that repeats the
--      previous reason is not a correction.
--   7. `platform_settings`: rider_offer_window_seconds (60–600, default 180,
--      the old EXCLUSIVE_OFFER_MS), pod_photo_rule (never | cod | always |
--      exceptions), unreachable_wait_minutes (3–30, default 10) and
--      routing_base_url (https only, default the public OSRM server).
--   8. `guard_order_update` re-declared with delivery_instructions on its
--      locked list, and the Partner (0061, 0063) and Manager (0141)
--      branches' locked columns kept on it, so no landing order unlocks them.
--
-- Security:
--   * delivery_exceptions: RLS on. A rider SELECTs their own rows
--     (driver_id = auth.uid()); admins and managers read all. No insert,
--     update or delete for anon or authenticated — raising and deciding go
--     through the service role behind requireRole(). The Supabase default
--     grants are revoked explicitly (RLS filters rows, not privileges).
--   * guard_delivery_transition stays SECURITY INVOKER and exempts nobody. Its
--     exception lookup therefore runs under the writer's own RLS: the service
--     role, admins and managers (the only writers of `deliveries`) read every
--     exception row. A writer who could not read them would be refused, not
--     waved through.
--   * orders.delivery_instructions: `orders` SELECT is granted per column since
--     0058, so it is granted to authenticated by name — every party that reads
--     the order row (customer, vendor, admin, manager) is meant to see the
--     note, and the rider gets it through the service-role board. It is on
--     guard_order_update's locked list: a vendor or manager JWT cannot rewrite
--     what the customer asked for. The API writes it with the service role.
--   * deliveries.pod_photo_path is readable by whoever already reads the row.
--     It is a path, not a URL: the bucket is private, has no storage policies
--     for anon or authenticated, and photos are served only through
--     short-lived signed URLs minted by the service role.
--   * The four settings are granted to anon and authenticated by name (the row
--     is column-granted since 0032): the settings facade reads with the user's
--     own client, and none of them is a commercial term.
--
-- ORDER OF DEPLOY: no app change is required first. No current writer sets
-- failed, ops_approved or manual or releases a rider (driver_id -> null), and the only non-correction -> delivered
-- path (advanceDelivery) moves from picked_up. Every current insert into
-- deliveries is unassigned (dispatch) or assigned with a rider (accept, manager
-- assign), which is all guard_delivery_insert admits; their assigned_at is now
-- the database's clock rather than the app server's. The settings code probes for the
-- new columns (OPTIONAL_GROUPS in src/lib/data-access/settings.ts), so it runs
-- before AND after this migration.
--
-- Idempotent: safe to re-run. A re-run also resets the bucket to private,
-- 5 MB, JPEG/PNG if it has drifted.
-- Re-run rule (ruling P8-R3): re-apply every migration from 0081 through the
-- newest one applied, all branches, in number order — never this file or the
-- rider files alone (Manager 0141, 0142 and 0152 narrow what they open).
--
-- Rollback (re-declares the 0081 versions of the delivery logger and guard):
--   drop trigger if exists log_delivery_withdrawn on public.deliveries;
--   drop function if exists public.log_delivery_withdrawn();
--   drop trigger if exists guard_delivery_insert on public.deliveries;
--   drop function if exists public.guard_delivery_insert();
--   drop trigger if exists guard_delivery_exception_update on public.delivery_exceptions;
--   drop function if exists public.guard_delivery_exception_update();
--   re-run sections 4 and 5 of 0081_rider_app_foundation.sql (log_delivery_event,
--     guard_delivery_transition);
--   -- guard_order_update is left as 0082 declared it, on purpose: its locked list
--   -- also holds the Partner (0061, 0063) and Manager (0141) columns, and
--   -- delivery_instructions compares equal once that column is dropped below.
--   -- Re-declaring an older version (0055's) would unlock the sibling columns.
--   drop table if exists public.delivery_exceptions;
--   alter table public.delivery_events drop constraint if exists delivery_events_contact_method_check;
--   alter table public.delivery_events drop constraint if exists delivery_events_kind_check;
--   -- delete from public.delivery_events
--   --  where kind in ('contact_attempt', 'released', 'withdrawn'); then
--   alter table public.delivery_events add constraint delivery_events_kind_check
--     check (kind in ('offered', 'rejected', 'lapsed', 'accepted', 'arrived_pickup',
--       'picked_up', 'departed', 'arrived_drop', 'delivered', 'failed', 'cancelled',
--       'reassigned', 'exception_requested', 'exception_decided', 'corrected'));
--   alter table public.deliveries drop column if exists pod_photo_path;
--   alter table public.deliveries drop column if exists distance_source;
--   alter table public.orders drop column if exists delivery_instructions;
--   alter table public.platform_settings
--     drop column if exists rider_offer_window_seconds, drop column if exists pod_photo_rule,
--     drop column if exists unreachable_wait_minutes,   drop column if exists routing_base_url;
--   delete from storage.buckets where id = 'delivery-proofs';  -- after emptying it
-- ============================================================

begin;

-- ============================================================
-- 1 — delivery_exceptions
-- ------------------------------------------------------------
-- No foreign key on order_id or driver_id: the delivery carries the cascade
-- (deleting an order deletes its delivery, which deletes these), and a driver
-- FK would block deleting a profile that ever raised one.
-- ============================================================
create table if not exists public.delivery_exceptions (
  id            uuid primary key default gen_random_uuid(),
  delivery_id   uuid not null references public.deliveries (id) on delete cascade,
  order_id      uuid not null,
  driver_id     uuid not null,
  kind          text not null,
  reason        text not null,
  notes         text,
  photo_path    text,
  lat           double precision,
  lng           double precision,
  status        text not null default 'pending',
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now(),
  constraint delivery_exceptions_kind_check check (kind in (
    'customer_unreachable', 'wrong_address', 'complete_without_code',
    'failed_delivery', 'manual_pickup', 'go_offline',
    'return_to_shop', 'missing_items', 'wrong_package', 'vendor_delay', 'other_issue')),
  constraint delivery_exceptions_status_check check (status in (
    'pending', 'approved', 'rejected', 'acknowledged')),
  -- Which terminal status each kind may reach: a report is only ever
  -- acknowledged, a request only approved or rejected.
  constraint delivery_exceptions_status_for_kind check (
    case
      when kind in ('return_to_shop', 'missing_items', 'wrong_package', 'vendor_delay', 'other_issue')
        then status in ('pending', 'acknowledged')
      else status in ('pending', 'approved', 'rejected')
    end)
);

comment on table public.delivery_exceptions is
  'Exceptions a rider raises on a delivery. Requests (customer_unreachable, wrong_address, complete_without_code, failed_delivery, manual_pickup, go_offline) are approved or rejected by ops; reports (return_to_shop, missing_items, wrong_package, vendor_delay, other_issue) are acknowledged. guard_delivery_transition reads approved requests. Written only by the service role.';
comment on column public.delivery_exceptions.driver_id is
  'The rider who raised it. guard_delivery_transition only honours an approval for the delivery''s current rider.';
comment on column public.delivery_exceptions.photo_path is
  'Optional photo, an object path in the private delivery-proofs bucket.';
comment on column public.delivery_exceptions.lat is
  'Rider position when the exception was raised.';
comment on column public.delivery_exceptions.decided_by is
  'The manager or admin who decided it (profiles.id). Null while pending.';

-- One pending row per (delivery, kind): a replayed tap or a second request
-- while the first is with ops fails with 23505.
create unique index if not exists delivery_exceptions_one_pending_idx
  on public.delivery_exceptions (delivery_id, kind)
  where status = 'pending';
create index if not exists delivery_exceptions_delivery_idx
  on public.delivery_exceptions (delivery_id, status);
create index if not exists delivery_exceptions_driver_idx
  on public.delivery_exceptions (driver_id, created_at desc);
-- The ops boards' "waiting for a decision" list.
create index if not exists delivery_exceptions_pending_idx
  on public.delivery_exceptions (created_at)
  where status = 'pending';

alter table public.delivery_exceptions enable row level security;

drop policy if exists "delivery_exceptions — read" on public.delivery_exceptions;
create policy "delivery_exceptions — read" on public.delivery_exceptions for select
  using (driver_id = auth.uid() or public.is_admin() or public.current_role() = 'manager');

revoke all on public.delivery_exceptions from anon, authenticated;
grant select on public.delivery_exceptions to authenticated;
grant select, insert, update, delete on public.delivery_exceptions to service_role;

-- ------------------------------------------------------------
-- 1a — a decision is final
-- ------------------------------------------------------------
-- An approval is what guard_delivery_transition reads as authority to fail a
-- delivery, complete it without the code or accept a manual pickup. One that
-- could be re-decided — rejected after the delivery failed, or approved after
-- a rejection — would make that authority depend on when you looked. So:
--   * a decided row carries its decision time (CHECK below), and
--   * once a row has left `pending`, its status, decider, decision time and
--     note never change again (guard_delivery_exception_update), and
--   * a row's delivery, rider, kind and creation time never change at all —
--     the guard's "raised by the current rider during the current assignment"
--     test reads exactly those.
-- The data layer decides with `... where status = 'pending'`, so a second
-- decision matches nothing; this is the floor under that. No role is exempt:
-- the service role is the only writer.
-- ------------------------------------------------------------
do $$
begin
  alter table public.delivery_exceptions
    add constraint delivery_exceptions_decided_check
    check (status = 'pending' or decided_at is not null);
exception
  when duplicate_object then null;
end $$;

create or replace function public.guard_delivery_exception_update()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if new.delivery_id is distinct from old.delivery_id
     or new.driver_id is distinct from old.driver_id
     or new.kind is distinct from old.kind
     or new.created_at is distinct from old.created_at then
    raise exception 'delivery_exception_immutable'
      using errcode = 'check_violation',
            detail  = 'an exception''s delivery, rider, kind and creation time cannot change';
  end if;
  if old.status <> 'pending'
     and (new.status        is distinct from old.status
       or new.decided_by    is distinct from old.decided_by
       or new.decided_at    is distinct from old.decided_at
       or new.decision_note is distinct from old.decision_note) then
    raise exception 'delivery_exception_decided'
      using errcode = 'check_violation',
            detail  = format('a %s exception is already decided', old.status);
  end if;
  return new;
end;
$$;

drop trigger if exists guard_delivery_exception_update on public.delivery_exceptions;
create trigger guard_delivery_exception_update
  before update on public.delivery_exceptions
  for each row execute function public.guard_delivery_exception_update();

-- ============================================================
-- 2 — delivery_events: contact_attempt, released, withdrawn
-- ------------------------------------------------------------
-- released  — a job handed back to dispatch (section 7), naming the rider who
--             lost it.
-- withdrawn — an outstanding offer whose unassigned row was deleted (the order
--             was cancelled before anyone accepted), naming the offered rider,
--             so every `offered` row ends in an outcome.
--
-- 0081 declared the kind check inline, so Postgres named it
-- delivery_events_kind_check. Re-created by that name as 0082's list PLUS any
-- kind the current check already allows: a later migration (0087's `note`)
-- adds kinds the same way, and a re-run of this file must keep them — dropping
-- one would fail on the rows that use it, or quietly forbid new ones.
-- ============================================================
do $$
declare
  def   text;
  kinds text[] := array[
    'offered', 'rejected', 'lapsed', 'accepted',
    'arrived_pickup', 'picked_up', 'departed', 'arrived_drop',
    'delivered', 'failed', 'cancelled', 'reassigned',
    'exception_requested', 'exception_decided', 'corrected',
    'contact_attempt', 'released', 'withdrawn'];
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
   where c.conrelid = 'public.delivery_events'::regclass
     and c.conname = 'delivery_events_kind_check';
  if def is not null then
    kinds := kinds || array(
      select m[1] from regexp_matches(def, '''([a-z_]+)''', 'g') as m
       where not (m[1] = any (kinds)));
    alter table public.delivery_events drop constraint delivery_events_kind_check;
  end if;
  execute format(
    'alter table public.delivery_events add constraint delivery_events_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(k), ', ') from unnest(kinds) as k));
end $$;

-- A contact attempt says whom the rider called. coalesce: `null in (...)` is
-- null, which a CHECK would let through.
do $$
begin
  alter table public.delivery_events
    add constraint delivery_events_contact_method_check
    check (kind <> 'contact_attempt' or coalesce(method, '') in ('customer', 'vendor'));
exception
  when duplicate_object then null;
end $$;

comment on column public.delivery_events.method is
  'How the step was proved (picked_up: deliveries.pickup_method; delivered: deliveries.delivery_method), or whom the rider called (contact_attempt: customer | vendor).';

-- ============================================================
-- 3 — deliveries.pod_photo_path
-- ============================================================
alter table public.deliveries
  add column if not exists pod_photo_path text;

comment on column public.deliveries.pod_photo_path is
  'Proof-of-delivery photo: object path in the private delivery-proofs bucket. Served only through short-lived signed URLs. platform_settings.pod_photo_rule decides when one is required.';

-- How distance_km (0081) was computed. Written by the data layer at acceptance:
-- 'estimate' (straight line x 1.3) first, then 'road' once the routing server
-- (platform_settings.routing_base_url) has answered. Null where distance_km was
-- never computed. Earnings and history can tell a measured distance from a guess.
alter table public.deliveries
  add column if not exists distance_source text;

do $$
begin
  alter table public.deliveries
    add constraint deliveries_distance_source_check
    check (distance_source in ('road', 'estimate'));
exception
  when duplicate_object then null;
end $$;

comment on column public.deliveries.distance_source is
  'How distance_km was computed: road (routing server) or estimate (straight line x 1.3). Null when distance_km is null.';

-- ============================================================
-- 4 — orders.delivery_instructions
-- ============================================================
alter table public.orders
  add column if not exists delivery_instructions text;

do $$
begin
  alter table public.orders
    add constraint orders_delivery_instructions_length
    check (char_length(delivery_instructions) <= 300);
exception
  when duplicate_object then null;
end $$;

comment on column public.orders.delivery_instructions is
  'The customer''s note to the rider (landmark, gate, "call on arrival"), at most 300 characters. Locked by guard_order_update; written by the service role.';

-- Column-granted since 0058: invisible until granted on purpose.
grant select (delivery_instructions) on public.orders to authenticated;

-- ============================================================
-- 5 — guard_order_update: 0055's list, plus delivery_instructions
-- ============================================================
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
    -- 0082: the customer's note to the rider.
    'delivery_instructions',
    -- The sibling branches' locks, kept so this re-declaration never unlocks
    -- them whatever order the three branches' migrations land in: Partner
    -- 0061 (preparing_at, stamped only by start_preparing()), Partner 0063
    -- (invoice_no / invoice_at, only by assign_invoice_no()), Manager 0141
    -- (zone_id, derived at insert). A column the table does not have yet is
    -- absent from both rows and compares equal (0055), so this is a no-op
    -- until those migrations add them.
    'preparing_at',
    'invoice_no', 'invoice_at',
    'zone_id'
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

-- ============================================================
-- 6 — log_delivery_event: 0081's logger, plus reassignment for both riders
--     and release; log_delivery_withdrawn for deleted offers
-- ------------------------------------------------------------
-- Unchanged from 0081 except that
--   * a reassignment writes `reassigned` (the rider who lost the job) and then
--     `accepted` (the rider who took it);
--   * a release (driver_id -> null, section 7) writes `released` naming the
--     rider who lost the job, with the correction reason.
-- See 0081 for the action-id marker this consumes.
-- ============================================================
create or replace function public.log_delivery_event()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o        public.deliveries%rowtype;  -- all null on insert: an insert is a change from nothing
  marker   constant text := current_setting('deligro.delivery_action', true);
  action   uuid;
  reassign boolean;
begin
  if tg_op = 'UPDATE' then
    o := old;
  end if;

  reassign := o.driver_id is not null and new.driver_id is not null
              and new.driver_id is distinct from o.driver_id;

  if new.last_action_id is not null
     and (tg_op = 'INSERT'
          or new.last_action_id is distinct from o.last_action_id
          or marker = new.id::text || ':' || new.last_action_id::text) then
    action := new.last_action_id;
  end if;
  if marker <> '' then
    perform set_config('deligro.delivery_action', '', true);
  end if;

  -- One update can produce several events (e.g. picked_up + departed). The
  -- action id goes on the first only: the index is unique, and one row is
  -- enough to catch a replay.
  insert into public.delivery_events
    (delivery_id, order_id, driver_id, kind, method, reason, actor_id, lat, lng, client_action_id)
  select new.id, new.order_id, e.driver, e.kind, e.method, e.reason, auth.uid(),
         new.driver_lat, new.driver_lng,
         case when row_number() over (order by e.ord) = 1 then action end
    from (values
      (1,  'offered',        new.offered_driver_id, null::text,          null::text,
           new.offered_driver_id is not null
           and new.offered_driver_id is distinct from o.offered_driver_id),
      (2,  'released',       o.driver_id,           null,                new.correction_reason,
           o.driver_id is not null and new.driver_id is null),
      (3,  'reassigned',     o.driver_id,           null,                null,
           reassign),
      (4,  'accepted',       new.driver_id,         null,                null,
           (new.status = 'assigned' and coalesce(o.status::text, 'unassigned') = 'unassigned')
           or reassign),
      (5,  'arrived_pickup', new.driver_id,         null,                null,
           new.arrived_pickup_at is not null and o.arrived_pickup_at is null),
      (6,  'picked_up',      new.driver_id,         new.pickup_method,   null,
           new.status = 'picked_up' and new.status is distinct from o.status),
      (7,  'departed',       new.driver_id,         null,                null,
           new.departed_pickup_at is not null and o.departed_pickup_at is null),
      (8,  'arrived_drop',   new.driver_id,         null,                null,
           new.arrived_drop_at is not null and o.arrived_drop_at is null),
      (9,  'delivered',      new.driver_id,         new.delivery_method, null,
           new.status = 'delivered' and new.status is distinct from o.status),
      (10, 'failed',         new.driver_id,         null,                new.failure_reason,
           new.status = 'failed' and new.status is distinct from o.status),
      (11, 'cancelled',      new.driver_id,         null,                null,
           new.status = 'cancelled' and new.status is distinct from o.status),
      (12, 'corrected',      new.driver_id,         null,                new.correction_reason,
           new.correction_reason is distinct from o.correction_reason)
    ) as e(ord, kind, driver, method, reason, fire)
   where e.fire
   order by e.ord;

  return null;
end;
$$;

comment on column public.delivery_events.driver_id is
  'The rider the event concerns: the offered rider for offered and withdrawn; on a reassignment, the rider who LOST the job for reassigned and the rider who took it for the accepted row that follows; the rider who lost the job for released; otherwise the rider on the delivery.';

-- An unassigned row holding an offer is deleted when the order is cancelled
-- before anyone accepted (cancelDeliveryForOrder). Without this its `offered`
-- row would have no outcome and the acceptance rate would count it as ignored.
-- SECURITY DEFINER for the same reason as log_delivery_event: an admin or
-- manager deleting with their own JWT cannot insert the audit row themselves.
create or replace function public.log_delivery_withdrawn()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- The order may be going too (orders -> deliveries cascade). Its events are
  -- cascading away with it, and an insert naming it would fail the FK and with
  -- it the order delete, so write nothing then.
  insert into public.delivery_events (delivery_id, order_id, driver_id, kind, actor_id)
  select old.id, old.order_id, old.offered_driver_id, 'withdrawn', auth.uid()
   where exists (select 1 from public.orders where id = old.order_id);
  return null;
end;
$$;

drop trigger if exists log_delivery_withdrawn on public.deliveries;
create trigger log_delivery_withdrawn
  after delete on public.deliveries
  for each row
  when (old.status = 'unassigned' and old.offered_driver_id is not null)
  execute function public.log_delivery_withdrawn();

-- ============================================================
-- 7 — guard_delivery_transition: 0081's state machine plus the exception gates
-- ------------------------------------------------------------
-- A correction is an update that changes correction_reason. It relaxes rules
-- 1, 4, 5, 6, 7, 8 and 9, and nothing else.
--   (1) -> delivered needs picked_up_at.          Stamps delivered_at.
--   (2) -> picked_up needs old status assigned and a rider. Stamps picked_up_at.
--   (3) -> failed needs a failure_reason and old status assigned or picked_up.
--          Stamps failed_at.
--   (4) arrived_pickup_at, departed_pickup_at, arrived_drop_at and
--       picked_up_at cannot change once set.
--   (5) nothing leaves delivered, failed or cancelled.
--   (6) -> delivered needs old status picked_up.                       (0082)
--   (7) -> failed needs an approved failed_delivery, customer_unreachable or
--       wrong_address exception for this delivery and its current rider. (0082)
--   (8) delivery_method becoming ops_approved needs an approved
--       complete_without_code, the same way.                           (0082)
--   (9) pickup_method becoming manual needs an approved manual_pickup.  (0082)
--  (10) A RELEASE (driver_id non-null -> null: the job goes back to dispatch,
--       e.g. on an approved go_offline) must be a correction, must land on
--       unassigned, and must come out of `assigned` — not picked_up (the rider
--       has the food), delivered, failed or cancelled — even as a correction. The guard then clears the per-rider stamps —
--       assigned_at, arrived_pickup_at, picked_up_at, departed_pickup_at,
--       arrived_drop_at and pickup_method — so the next rider can set them
--       again under rule 4. A release is logged as `released`. It also
--       clears offered_driver_id / offered_at.                         (0082)
--  (11) Rules 7–9 count an approval only if it was raised during the current
--       assignment (created_at >= assigned_at), and a non-correction update
--       that gives the job to a rider stamps assigned_at = now(), so both
--       sides of that comparison are the database's clock.           (0082)
-- Inserts have their own guard, guard_delivery_insert (section 7a).
-- Violations raise 'invalid_delivery_transition' (SQLSTATE 23514,
-- check_violation) with the specific rule in DETAIL.
--
-- No role is exempt, unlike guard_order_status (0055): the service role IS the
-- rider app's writer, so exempting it would exempt the case this is for.
-- ============================================================
create or replace function public.guard_delivery_transition()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  correction constant boolean := new.correction_reason is distinct from old.correction_reason;
  moved      constant boolean := new.status is distinct from old.status;
  release    constant boolean := old.driver_id is not null and new.driver_id is null;
  why        text;
begin
  if release then
    if not correction then
      why := 'releasing a delivery back to dispatch is a correction (set correction_reason)';
    elsif old.status <> 'assigned' then
      -- Before pickup only (ruling P2-R9). Out of picked_up the food is with
      -- the rider, and the next rider would be sent to an empty counter; out
      -- of delivered / failed / cancelled the job is over.
      why := format('only an assigned delivery can be released (was %s)', old.status);
    elsif new.status <> 'unassigned' then
      why := format('a released delivery must become unassigned (not %s)', new.status);
    end if;
  end if;

  if why is null and not correction then
    if moved and old.status in ('delivered', 'failed', 'cancelled') then
      why := format('a %s delivery cannot become %s', old.status, new.status);
    elsif old.arrived_pickup_at is not null and new.arrived_pickup_at is distinct from old.arrived_pickup_at then
      why := 'arrived_pickup_at is already set';
    elsif old.departed_pickup_at is not null and new.departed_pickup_at is distinct from old.departed_pickup_at then
      why := 'departed_pickup_at is already set';
    elsif old.arrived_drop_at is not null and new.arrived_drop_at is distinct from old.arrived_drop_at then
      why := 'arrived_drop_at is already set';
    elsif old.picked_up_at is not null and new.picked_up_at is distinct from old.picked_up_at then
      why := 'picked_up_at is already set';
    elsif moved and new.status = 'delivered' and new.picked_up_at is null then
      why := 'delivered requires a pickup (picked_up_at)';
    elsif moved and new.status = 'delivered' and old.status <> 'picked_up' then
      why := format('delivered requires a picked-up delivery (was %s)', old.status);
    end if;
  end if;

  if why is null and moved then
    if new.status = 'picked_up' and (old.status <> 'assigned' or new.driver_id is null) then
      why := format('picked_up requires an assigned delivery with a rider (was %s)', old.status);
    elsif new.status = 'failed' and nullif(btrim(new.failure_reason), '') is null then
      why := 'failed requires a failure_reason';
    elsif new.status = 'failed' and old.status not in ('assigned', 'picked_up') then
      why := format('only an assigned or picked-up delivery can fail (was %s)', old.status);
    end if;
  end if;

  -- What only an approved exception can authorise. The lookup runs as the
  -- writer (SECURITY INVOKER); see the header for why that fails closed.
  -- An approval counts only for the CURRENT assignment (rule 7–9's last
  -- clause): one raised before assigned_at belongs to an earlier stint on this
  -- job — the same rider released and given it again — and authorises nothing
  -- now. A null assigned_at compares null, so it fails closed too.
  if why is null and not correction then
    if moved and new.status = 'failed'
       and not exists (
         select 1 from public.delivery_exceptions x
          where x.delivery_id = new.id
            and x.driver_id   = new.driver_id
            and x.status      = 'approved'
            and x.created_at >= new.assigned_at
            and x.kind in ('failed_delivery', 'customer_unreachable', 'wrong_address')) then
      why := 'failed requires an approved failed_delivery, customer_unreachable or wrong_address exception';
    elsif new.delivery_method = 'ops_approved'
          and new.delivery_method is distinct from old.delivery_method
          and not exists (
            select 1 from public.delivery_exceptions x
             where x.delivery_id = new.id
               and x.driver_id   = new.driver_id
               and x.status      = 'approved'
               and x.created_at >= new.assigned_at
               and x.kind        = 'complete_without_code') then
      why := 'delivery_method ops_approved requires an approved complete_without_code exception';
    elsif new.pickup_method = 'manual'
          and new.pickup_method is distinct from old.pickup_method
          and not exists (
            select 1 from public.delivery_exceptions x
             where x.delivery_id = new.id
               and x.driver_id   = new.driver_id
               and x.status      = 'approved'
               and x.created_at >= new.assigned_at
               and x.kind        = 'manual_pickup') then
      why := 'pickup_method manual requires an approved manual_pickup exception';
    end if;
  end if;

  if why is not null then
    raise exception 'invalid_delivery_transition'
      using errcode = 'check_violation', detail = why;
  end if;

  if release then
    new.assigned_at        := null;
    new.arrived_pickup_at  := null;
    new.picked_up_at       := null;
    new.departed_pickup_at := null;
    new.arrived_drop_at    := null;
    new.pickup_method      := null;
    -- And the offer (rule 10): the released job is dispatch's to offer again,
    -- and a stale offeree would read as "held for" a rider who just left it.
    new.offered_driver_id  := null;
    new.offered_at         := null;
  elsif not correction and new.driver_id is not null
        and new.driver_id is distinct from old.driver_id then
    -- A rider takes the job (rule 11): assigned_at is the database's clock, not
    -- the writer's, because rules 7–9 compare it with delivery_exceptions.
    -- created_at (also now()). An app server running fast would otherwise put
    -- a fresh assignment "after" the approval raised a minute later.
    new.assigned_at := now();
  end if;

  if moved then
    if new.status = 'delivered' then
      new.delivered_at := coalesce(new.delivered_at, now());
    elsif new.status = 'picked_up' then
      new.picked_up_at := coalesce(new.picked_up_at, now());
    elsif new.status = 'failed' then
      new.failed_at := coalesce(new.failed_at, now());
    end if;
  end if;

  return new;
end;
$$;

-- ============================================================
-- 7a — guard_delivery_insert: a delivery is born unassigned or assigned
-- ------------------------------------------------------------
-- guard_delivery_transition watches UPDATEs only, so an INSERT could create a
-- row already picked up, delivered or failed — past every rule above, with no
-- exception, code or pickup behind it. Every writer in the app inserts
-- `unassigned` (dispatch's offer row) or `assigned` (a rider accepting, a
-- manager assigning). So a non-correction insert must be one of those two,
-- `assigned` with a rider, and carry no pickup/delivery/failure stamp or
-- method. A correction (correction_reason set — an import, a backfill) may
-- insert anything, and is logged as such by log_delivery_event. An assigned
-- insert's assigned_at is stamped now() for the reason rule 11 gives.
-- No role is exempt, for the reason section 7 gives.
-- ============================================================
create or replace function public.guard_delivery_insert()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  why text;
begin
  if new.correction_reason is not null then
    return new;
  end if;

  if new.status not in ('unassigned', 'assigned') then
    why := format('a delivery is created unassigned or assigned (not %s)', new.status);
  elsif new.status = 'assigned' and new.driver_id is null then
    why := 'an assigned delivery needs a rider';
  elsif new.picked_up_at is not null or new.delivered_at is not null or new.failed_at is not null then
    why := 'a new delivery cannot carry a pickup, delivery or failure stamp';
  elsif new.pickup_method is not null or new.delivery_method is not null then
    why := 'a new delivery cannot carry a pickup or delivery method';
  end if;

  if why is not null then
    raise exception 'invalid_delivery_transition'
      using errcode = 'check_violation', detail = why;
  end if;

  if new.driver_id is not null then
    new.assigned_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists guard_delivery_insert on public.deliveries;
create trigger guard_delivery_insert
  before insert on public.deliveries
  for each row execute function public.guard_delivery_insert();

-- ============================================================
-- 8 — platform_settings: offer window, proof-photo rule, unreachable wait,
--     routing server
-- ============================================================
alter table public.platform_settings
  add column if not exists rider_offer_window_seconds integer not null default 180,
  add column if not exists pod_photo_rule             text    not null default 'never',
  add column if not exists unreachable_wait_minutes   integer not null default 10,
  add column if not exists routing_base_url           text    not null default 'https://router.project-osrm.org';

do $$
begin
  alter table public.platform_settings
    add constraint platform_settings_rider_offer_window_range
    check (rider_offer_window_seconds between 60 and 600);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.platform_settings
    add constraint platform_settings_pod_photo_rule_check
    check (pod_photo_rule in ('never', 'cod', 'always', 'exceptions'));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.platform_settings
    add constraint platform_settings_unreachable_wait_range
    check (unreachable_wait_minutes between 3 and 30);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.platform_settings
    add constraint platform_settings_routing_base_url_https
    check (routing_base_url ~* '^https://.+');
exception
  when duplicate_object then null;
end $$;

comment on column public.platform_settings.rider_offer_window_seconds is
  'How long a rider has to accept an exclusive offer before dispatch moves on, 60–600 s. Replaces the EXCLUSIVE_OFFER_MS constant, which stays as the fallback.';
comment on column public.platform_settings.pod_photo_rule is
  'When a proof-of-delivery photo is required: never, cod (cash orders), always, exceptions (ops-approved completions only).';
comment on column public.platform_settings.unreachable_wait_minutes is
  'Minutes after arrived_drop_at (and a logged call) before a rider may raise customer_unreachable, 3–30.';
comment on column public.platform_settings.routing_base_url is
  'Base URL of the OSRM-compatible routing server used for route distance and the in-app map. https only.';

grant select (rider_offer_window_seconds, pod_photo_rule, unreachable_wait_minutes, routing_base_url)
  on public.platform_settings to anon, authenticated;

-- ============================================================
-- 9 — storage: the private delivery-proofs bucket
-- ------------------------------------------------------------
-- No storage.objects policies for anon or authenticated, on purpose: uploads
-- and signed URLs go through the service role behind requireRole(), which
-- also checks the magic bytes and that the caller is on the delivery.
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'delivery-proofs',
  'delivery-proofs',
  false,   -- private: read only through signed URLs
  5242880, -- 5 MB
  array['image/jpeg', 'image/png']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ============================================================
-- 10 — function privileges (create or replace keeps them; restated so this
--      file stands on its own)
-- ============================================================
revoke execute on function public.log_delivery_event()        from public, anon, authenticated;
revoke execute on function public.guard_delivery_transition() from public, anon, authenticated;
revoke execute on function public.log_delivery_withdrawn()    from public, anon, authenticated;
revoke execute on function public.guard_delivery_insert()     from public, anon, authenticated;
revoke execute on function public.guard_delivery_exception_update() from public, anon, authenticated;

commit;
