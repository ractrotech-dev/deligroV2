-- ============================================================
-- 0081 — Rider app foundation: availability, shifts, rider ID, delivery audit
--        and the delivery transition guard
-- STATUS: PENDING APPROVAL — not applied to any database. Staging first.
-- ------------------------------------------------------------
-- The ground every later rider-app task stands on (design:
-- docs/superpowers/specs/2026-10-21-rider-app-design.md, "Delivery statuses"
-- and "Offers and dispatch"). Numbered from 0081 because the Partner app owns
-- 0061–0080.
--
--   1. delivery_status gains 'failed'. Every other new rider step (arrived at
--      the shop, left it, arrived at the door) is a timestamp on `deliveries`,
--      not a status, so the rider, manager, customer and web code keep reading
--      the five statuses they already understand.
--   2. `deliveries` gains those stamps, the failure reason, how the pickup and
--      the delivery were proved (`pickup_method`, `delivery_method`), the
--      route distance, the client's action id and a correction reason.
--   3. `rider_status` — one row per rider: online, on a break, last fix.
--      `rider_shifts` — one row per online session; at most one open per rider.
--   4. `rider_profiles` — the rider ID shown on the app and to ops (DR-0001,
--      DR-0002, … in registration order). Every driver gets one: existing
--      drivers are backfilled by `profiles.created_at`, new and promoted ones
--      by the `ensure_rider_profile` trigger. Later phases add columns here.
--   5. `delivery_events` — the audit trail (§17.5): one row per offer, accept,
--      arrival, pickup, departure, delivery, failure, cancellation,
--      reassignment and correction, written by the `log_delivery_event`
--      trigger, so no writer can change a delivery without leaving a row.
--   6. `guard_delivery_transition` — the delivery state machine in the
--      database, for EVERY role including service_role: the app is not the
--      only writer that can get this wrong (see the rules on the function).
--   7. `platform_settings.privacy_policy_url` / `terms_url`. Deligro has no
--      published policy or terms yet; nothing is invented. Both default to ''
--      and the app links them once an admin sets them (https only).
--
-- Replay protection. The rider app sends one uuid per tap as
-- `deliveries.last_action_id`. The event row the tap produces carries it in
-- `delivery_events.client_action_id`, which is unique, so a tap replayed by a
-- flaky network fails the WHOLE update with 23505 instead of being applied
-- twice. The id is carried only when the update itself set the column (see
-- `mark_delivery_action`): a later location ping or staff correction leaves the
-- old id on the row, and logging it again would refuse an innocent write.
--
-- Security:
--   * The four new tables: RLS on. A rider SELECTs their own rows
--     (driver_id = auth.uid()); admins and managers read all. No insert,
--     update or delete for anon or authenticated — every write goes through the
--     service role behind requireRole(), or through the triggers below. The
--     Supabase default grants are revoked explicitly, because RLS filters rows,
--     not privileges (AGENTS.md rule 1).
--   * `log_delivery_event` and `ensure_rider_profile` are SECURITY DEFINER:
--     managers write `deliveries` and admins write `profiles.role` with their
--     own JWT, and those writes must still produce the audit row / rider ID
--     that the writer has no privilege to insert itself. Both pin search_path
--     and EXECUTE is revoked from PUBLIC (0054: revoking anon/authenticated by
--     name alone changes nothing).
--   * `guard_delivery_transition` is SECURITY INVOKER and exempts nobody.
--     A "correction" (correction_reason changed) relaxes three of its rules;
--     only staff can make one, because riders have had no direct UPDATE on
--     `deliveries` since 0055 and the service-role data layer sets it only on
--     staff paths (recordCodForStaffDelivery).
--   * New `deliveries` columns are readable by whoever already reads the row
--     ("deliveries — read": the rider on it, the owning vendor, admin;
--     "manager read"). None of them is a secret: a failure or correction reason
--     and the method used are things each of those parties is shown anyway.
--   * The two `platform_settings` URLs are granted to anon/authenticated by
--     name — that row is column-granted since 0032 — because the apps link them.
--
-- ORDER OF DEPLOY: ship the app first. Its delivery writers (driver-orders.ts)
-- set pickup_method / delivery_method / correction_reason only once a probe has
-- seen the columns, so it runs before AND after this migration. Applied before
-- the app, the guard would refuse the old staff path's assigned -> delivered
-- (it sends no correction_reason).
-- AFTER applying it, restart the app instances. Each one remembers "column
-- missing" for its lifetime once a write has failed on it, so an instance that
-- wrote before the migration keeps writing without the new columns. The staff
-- path re-probes when the guard refuses it, but the pickup and delivery
-- methods are not recorded until the instance restarts.
--
-- The enum value is added BEFORE `begin;`: Postgres refuses to use a new enum
-- label inside the transaction that added it. Nothing in this file uses
-- 'failed' at DDL time (only inside function bodies, which run later), so the
-- file is also safe where a runner wraps it in a single transaction.
--
-- Once applied, riders receive offers only after they tap Go online; until each
-- rider does, orders rely on the open pool and the ring.
--
-- Idempotent: safe to re-run. A re-run neither renumbers nor skips rider codes.
-- Re-run rule (ruling P8-R3): re-apply every migration from 0081 through the
-- newest one applied, all branches, in number order — never this file or the
-- rider files alone (Manager 0141, 0142 and 0152 narrow what they open).
--
-- Rollback (Postgres cannot drop an enum value, so 'failed' stays; move any
-- 'failed' delivery to 'cancelled' first, since nothing else will read it):
--   drop trigger if exists log_delivery_event        on public.deliveries;
--   drop trigger if exists guard_delivery_transition on public.deliveries;
--   drop trigger if exists mark_delivery_action      on public.deliveries;
--   drop trigger if exists ensure_rider_profile      on public.profiles;
--   drop table if exists public.delivery_events, public.rider_profiles,
--                        public.rider_shifts, public.rider_status;
--   drop function if exists public.log_delivery_event(),
--                           public.guard_delivery_transition(),
--                           public.mark_delivery_action(),
--                           public.ensure_rider_profile(),
--                           public.next_rider_code();
--   drop sequence if exists public.rider_code_seq;
--   alter table public.deliveries
--     drop column if exists arrived_pickup_at,  drop column if exists departed_pickup_at,
--     drop column if exists arrived_drop_at,    drop column if exists failed_at,
--     drop column if exists failure_reason,     drop column if exists pickup_method,
--     drop column if exists delivery_method,    drop column if exists distance_km,
--     drop column if exists last_action_id,     drop column if exists correction_reason;
--   alter table public.platform_settings
--     drop column if exists privacy_policy_url, drop column if exists terms_url;
-- ============================================================

alter type public.delivery_status add value if not exists 'failed';

begin;

-- ============================================================
-- 1 — deliveries: the rider's steps, how each was proved, and replay/correction
-- ============================================================
alter table public.deliveries
  add column if not exists arrived_pickup_at  timestamptz,
  add column if not exists departed_pickup_at timestamptz,
  add column if not exists arrived_drop_at    timestamptz,
  add column if not exists failed_at          timestamptz,
  add column if not exists failure_reason     text,
  add column if not exists pickup_method      text,
  add column if not exists delivery_method    text,
  add column if not exists distance_km        numeric(6,2),
  add column if not exists last_action_id     uuid,
  add column if not exists correction_reason  text;

do $$
begin
  alter table public.deliveries
    add constraint deliveries_pickup_method_check
    check (pickup_method in ('code', 'qr', 'vendor', 'manual', 'none'));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.deliveries
    add constraint deliveries_delivery_method_check
    check (delivery_method in ('code', 'photo', 'ops_approved', 'staff'));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.deliveries
    add constraint deliveries_distance_km_nonneg
    check (distance_km >= 0);
exception
  when duplicate_object then null;
end $$;

-- Rows the original writer moved to 'picked_up' never stamped picked_up_at. The
-- guard below refuses assigned/picked_up -> delivered without it, so such a row
-- would let the order reach delivered and then refuse the delivery update,
-- leaving the delivery stuck at picked_up for ever. Backfill it here, BEFORE any
-- trigger exists, so this one-off write is neither guarded nor audited.
update public.deliveries
   set picked_up_at = coalesce(assigned_at, now())
 where status = 'picked_up' and picked_up_at is null;

comment on column public.deliveries.arrived_pickup_at is
  'Rider reached the shop. Set once (guard_delivery_transition); only a correction may change it.';
comment on column public.deliveries.departed_pickup_at is
  'Rider left the shop with the order ("Start trip", or leaving the shop geofence). Set once.';
comment on column public.deliveries.arrived_drop_at is
  'Rider reached the customer. Set once.';
comment on column public.deliveries.failed_at is
  'When the delivery became failed. Stamped by guard_delivery_transition.';
comment on column public.deliveries.failure_reason is
  'Why it failed. Required for status failed (guard_delivery_transition).';
comment on column public.deliveries.pickup_method is
  'How the pickup was proved: code (kitchen handover code typed by the rider), qr, vendor (vendor confirmed), manual (ops), none (no code on the order).';
comment on column public.deliveries.delivery_method is
  'How the delivery was proved: code (customer handover code), photo, ops_approved (approved exception), staff (a manager/admin marked the order delivered).';
comment on column public.deliveries.distance_km is
  'Route distance shop -> customer for this delivery, for earnings and history. Null until computed.';
comment on column public.deliveries.last_action_id is
  'The rider app''s id for the tap that last changed this row. Copied onto the resulting delivery_events row, whose unique index turns a replayed tap into a 23505.';
comment on column public.deliveries.correction_reason is
  'Set by staff paths only. An update that changes it is a correction: guard_delivery_transition relaxes its pickup, set-once and terminal rules, and log_delivery_event writes a corrected event.';

-- ============================================================
-- 2 — rider_status and rider_shifts: availability, for dispatch
-- ============================================================
create table if not exists public.rider_status (
  driver_id    uuid primary key references public.profiles (id) on delete cascade,
  is_online    boolean not null default false,
  break_until  timestamptz,
  online_since timestamptz,
  last_lat     double precision,
  last_lng     double precision,
  last_fix_at  timestamptz,
  updated_at   timestamptz not null default now()
);

comment on table public.rider_status is
  'One row per rider who has ever gone online. Dispatch offers only to riders who are online, not on a break and have a recent fix. A rider with no row is offline. Written only by the service role (src/lib/rider).';
comment on column public.rider_status.break_until is
  'On a break until this instant; dispatch skips the rider meanwhile without ending the shift.';
comment on column public.rider_status.last_fix_at is
  'When the last position arrived. A stale fix takes the rider out of dispatch, so a dead phone does not stay "online".';

create table if not exists public.rider_shifts (
  id         bigint generated always as identity primary key,
  driver_id  uuid not null references public.profiles (id) on delete cascade,
  started_at timestamptz not null,
  ended_at   timestamptz,
  ended_by   text check (ended_by in ('rider', 'logout', 'ops', 'presence')),
  constraint rider_shifts_end_after_start check (ended_at is null or ended_at >= started_at)
);

comment on table public.rider_shifts is
  'One row per online session, for hours and attendance. ended_by: rider (went offline), logout, ops (an operator took them offline), presence (no fix for too long).';

create index if not exists rider_shifts_driver_started_idx
  on public.rider_shifts (driver_id, started_at desc);

-- At most one open shift per rider: two concurrent "go online" calls cannot
-- both open one.
create unique index if not exists rider_shifts_one_open_idx
  on public.rider_shifts (driver_id)
  where ended_at is null;

-- ============================================================
-- 3 — rider_profiles: the rider ID
-- ============================================================
create sequence if not exists public.rider_code_seq;

-- 'DR-' plus at least four digits. A plain lpad(…, 4, '0') would TRUNCATE
-- rider 10000 to 'DR-1000' and fail every later signup on the unique index.
create or replace function public.next_rider_code()
returns text
language sql volatile set search_path = public as $$
  select 'DR-' || case when s.n < 10000 then lpad(s.n::text, 4, '0') else s.n::text end
    from nextval('public.rider_code_seq') as s(n);
$$;

create table if not exists public.rider_profiles (
  driver_id  uuid primary key references public.profiles (id) on delete cascade,
  rider_code text not null unique default public.next_rider_code(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter sequence public.rider_code_seq owned by public.rider_profiles.rider_code;

comment on table public.rider_profiles is
  'Rider-only profile data, one row per driver. rider_code is the rider ID shown in the app and to ops; issued in registration order and never reused. Later phases add columns.';

create or replace function public.ensure_rider_profile()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- `where not exists` before the insert, not only `on conflict`: the default
  -- draws a code before the conflict is detected, so re-saving a driver's role
  -- would otherwise burn a number each time.
  insert into public.rider_profiles (driver_id)
  select new.id
   where not exists (select 1 from public.rider_profiles where driver_id = new.id)
  on conflict (driver_id) do nothing;
  return null;
end;
$$;

drop trigger if exists ensure_rider_profile on public.profiles;
create trigger ensure_rider_profile
  after insert or update of role on public.profiles
  for each row
  when (new.role = 'driver')
  execute function public.ensure_rider_profile();

-- Existing drivers, oldest first, so DR-0001 is the first rider who joined.
insert into public.rider_profiles (driver_id)
select p.id
  from public.profiles p
 where p.role = 'driver'
   and not exists (select 1 from public.rider_profiles rp where rp.driver_id = p.id)
 order by p.created_at, p.id
on conflict (driver_id) do nothing;

-- ============================================================
-- 4 — delivery_events: the audit trail
-- ------------------------------------------------------------
-- No foreign key on delivery_id on purpose: cancelDeliveryForOrder deletes an
-- unassigned offer row, and its `offered` history must outlive it. order_id
-- carries the cascade instead.
-- ============================================================
create table if not exists public.delivery_events (
  id               bigint generated always as identity primary key,
  delivery_id      uuid not null,
  order_id         uuid not null references public.orders (id) on delete cascade,
  driver_id        uuid references public.profiles (id) on delete set null,
  kind             text not null check (kind in (
                     'offered', 'rejected', 'lapsed', 'accepted',
                     'arrived_pickup', 'picked_up', 'departed', 'arrived_drop',
                     'delivered', 'failed', 'cancelled', 'reassigned',
                     'exception_requested', 'exception_decided', 'corrected')),
  method           text,
  reason           text,
  actor_id         uuid references public.profiles (id) on delete set null,
  lat              double precision,
  lng              double precision,
  client_action_id uuid,
  created_at       timestamptz not null default now()
);

comment on table public.delivery_events is
  'Append-only audit of every delivery step (§17.5): history, timelines and performance read it. Written by the log_delivery_event trigger and the service-role data layer; never updated.';
comment on column public.delivery_events.driver_id is
  'The rider the event concerns: the offered rider for offered, the rider who LOST the job for reassigned (later rows name the new one), otherwise the rider on the delivery.';
comment on column public.delivery_events.actor_id is
  'auth.uid() of whoever made the change; null for the service role (the rider app and dispatch write through it).';
comment on column public.delivery_events.client_action_id is
  'The rider app''s per-tap id (deliveries.last_action_id). Unique, so a replayed tap fails its update with 23505.';

create unique index if not exists delivery_events_client_action_idx
  on public.delivery_events (client_action_id)
  where client_action_id is not null;
create index if not exists delivery_events_delivery_idx
  on public.delivery_events (delivery_id, created_at);
create index if not exists delivery_events_driver_idx
  on public.delivery_events (driver_id, created_at desc);

-- ------------------------------------------------------------
-- Did THIS statement set last_action_id? Only a column-specific trigger can
-- tell: it fires when the column is in the UPDATE's SET list, even if the
-- value is unchanged — which is exactly a replayed tap. It leaves a
-- transaction-local marker, '<delivery id>:<action id>', for
-- log_delivery_event to consume.
--
-- One fixed setting name, not one per row: every distinct custom setting name
-- stays allocated in the session for its lifetime, and pooled API connections
-- live long. The cost of the single slot is that a statement setting
-- last_action_id on several rows at once marks only the last of them — the app
-- writes one tap to one row, so that statement does not exist.
-- ------------------------------------------------------------
create or replace function public.mark_delivery_action()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if new.last_action_id is not null then
    perform set_config('deligro.delivery_action',
                       new.id::text || ':' || new.last_action_id::text, true);
  end if;
  return new;
end;
$$;

drop trigger if exists mark_delivery_action on public.deliveries;
create trigger mark_delivery_action
  before update of last_action_id on public.deliveries
  for each row
  execute function public.mark_delivery_action();

create or replace function public.log_delivery_event()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o      public.deliveries%rowtype;  -- all null on insert: an insert is a change from nothing
  marker constant text := current_setting('deligro.delivery_action', true);
  action uuid;
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
      (2,  'accepted',       new.driver_id,         null,                null,
           new.status = 'assigned' and coalesce(o.status::text, 'unassigned') = 'unassigned'),
      (3,  'reassigned',     o.driver_id,           null,                null,
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
      (10, 'cancelled',      new.driver_id,         null,                null,
           new.status = 'cancelled' and new.status is distinct from o.status),
      (11, 'corrected',      new.driver_id,         null,                new.correction_reason,
           new.correction_reason is distinct from o.correction_reason)
    ) as e(ord, kind, driver, method, reason, fire)
   where e.fire
   order by e.ord;

  return null;
end;
$$;

drop trigger if exists log_delivery_event on public.deliveries;
create trigger log_delivery_event
  after insert or update on public.deliveries
  for each row
  execute function public.log_delivery_event();

-- ============================================================
-- 5 — guard_delivery_transition: the state machine, for every writer
-- ------------------------------------------------------------
-- A correction is an update that changes correction_reason. It relaxes rules
-- 1, 4 and 5 and nothing else.
--   (1) -> delivered needs picked_up_at.          Stamps delivered_at.
--   (2) -> picked_up needs old status assigned and a rider. Stamps picked_up_at.
--   (3) -> failed needs a failure_reason and old status assigned or picked_up.
--          Stamps failed_at.
--   (4) arrived_pickup_at, departed_pickup_at, arrived_drop_at and
--       picked_up_at cannot change once set.
--   (5) nothing leaves delivered, failed or cancelled.
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
  why        text;
begin
  if not correction then
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

  if why is not null then
    raise exception 'invalid_delivery_transition'
      using errcode = 'check_violation', detail = why;
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

drop trigger if exists guard_delivery_transition on public.deliveries;
create trigger guard_delivery_transition
  before update on public.deliveries
  for each row
  execute function public.guard_delivery_transition();

-- ============================================================
-- 6 — platform_settings: privacy policy and terms links
-- ============================================================
alter table public.platform_settings
  add column if not exists privacy_policy_url text not null default '',
  add column if not exists terms_url          text not null default '';

do $$
begin
  alter table public.platform_settings
    add constraint platform_settings_privacy_policy_url_https
    check (privacy_policy_url = '' or privacy_policy_url ~* '^https://');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.platform_settings
    add constraint platform_settings_terms_url_https
    check (terms_url = '' or terms_url ~* '^https://');
exception
  when duplicate_object then null;
end $$;

comment on column public.platform_settings.privacy_policy_url is
  'Public https link to the privacy policy. Empty = none published; the apps hide the link rather than invent one.';
comment on column public.platform_settings.terms_url is
  'Public https link to the terms of service. Empty = none published.';

-- Column-granted since 0032: a new column is invisible until granted. These
-- two are meant to be public — the apps link them before sign-in.
grant select (privacy_policy_url, terms_url) on public.platform_settings to anon, authenticated;

-- ============================================================
-- 7 — RLS and privileges
-- ============================================================
alter table public.rider_status    enable row level security;
alter table public.rider_shifts    enable row level security;
alter table public.rider_profiles  enable row level security;
alter table public.delivery_events enable row level security;

drop policy if exists "rider_status — read" on public.rider_status;
create policy "rider_status — read" on public.rider_status for select
  using (driver_id = auth.uid() or public.is_admin() or public.current_role() = 'manager');

drop policy if exists "rider_shifts — read" on public.rider_shifts;
create policy "rider_shifts — read" on public.rider_shifts for select
  using (driver_id = auth.uid() or public.is_admin() or public.current_role() = 'manager');

drop policy if exists "rider_profiles — read" on public.rider_profiles;
create policy "rider_profiles — read" on public.rider_profiles for select
  using (driver_id = auth.uid() or public.is_admin() or public.current_role() = 'manager');

drop policy if exists "delivery_events — read" on public.delivery_events;
create policy "delivery_events — read" on public.delivery_events for select
  using (driver_id = auth.uid() or public.is_admin() or public.current_role() = 'manager');

-- No write policy for any authenticated role, and no write privilege either:
-- belt and braces, so a policy added later by mistake still cannot open writes.
revoke all on public.rider_status, public.rider_shifts, public.rider_profiles, public.delivery_events
  from anon, authenticated;
grant select on public.rider_status, public.rider_shifts, public.rider_profiles, public.delivery_events
  to authenticated;
grant select, insert, update, delete
  on public.rider_status, public.rider_shifts, public.rider_profiles, public.delivery_events
  to service_role;

revoke all on sequence public.rider_code_seq from public, anon, authenticated;
grant usage, select on sequence public.rider_code_seq to service_role;

revoke execute on function public.next_rider_code()           from public, anon, authenticated;
revoke execute on function public.ensure_rider_profile()      from public, anon, authenticated;
revoke execute on function public.log_delivery_event()        from public, anon, authenticated;
revoke execute on function public.mark_delivery_action()      from public, anon, authenticated;
revoke execute on function public.guard_delivery_transition() from public, anon, authenticated;
grant  execute on function public.next_rider_code() to service_role;

commit;
