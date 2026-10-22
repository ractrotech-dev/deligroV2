-- ============================================================
-- 0087 — Rider app phase 7: support tickets, the notification inbox,
--        announcements, SOS, and the pickup-reminder / delay / high-demand
--        alerts
-- STATUS: PENDING APPROVAL — not applied to any database. Staging first.
--         Requires 0081 (rider app foundation) and 0082 (rider jobs).
-- ------------------------------------------------------------
-- Plan: docs/superpowers/plans/2026-10-21-rider-app-phase-7-help-safety-
-- notifications.md (Task 1). Design: docs/superpowers/specs/2026-10-21-rider-
-- app-design.md ("Notifications (§11)", "Help, safety (§13, §15)", "Shared
-- with the Partner app").
--
-- ONE SOURCE OF TRUTH. `support_tickets`, `support_messages`,
-- `user_notifications`, `announcements` and the `support-attachments` bucket
-- are shared by three branches: the Partner app's 0064 (feat/vendor-app), the
-- Manager app's 0143 (feat/manager-app, which widens the ticket status with
-- `escalated` and adds its own columns) and this migration. Sections 1–3 below
-- are 0064's statements in 0064's shape — English only, no `*_hi` columns —
-- and every one is guarded (`create table if not exists`, `drop policy if
-- exists`, `create or replace`, `on conflict do nothing`), so whichever of the
-- three is applied first creates the tables and the others converge on them.
-- Section 1b repeats 0143's status widening verbatim (same constraint name,
-- same list), so applying 0087 before or after 0143 ends in the same state.
-- 0143's manager columns (team, escalation_level, first_response_at,
-- resolution, zone_id) are NOT added here: zone_id references the manager
-- branch's delivery_zones, which this branch does not have. Where the rider
-- plan's shape differed from 0064 (Hindi title/body columns), 0064 wins.
--
-- Rider-only additions (also guarded):
--   4. A manager reads RIDER tickets that are emergencies or about a delivery
--      (the delivery, pickup-report and safety categories) — the spec's
--      "appears at the top of their boards". Additive to 0143's zone policy:
--      policies OR together.
--   5. `rider_raise_sos(...)` — the SOS write, atomically: a per-rider
--      advisory lock, then either a location update appended to the rider's
--      open emergency ticket OF THE SAME CATEGORY touched in the last 10
--      minutes, or a new `emergency` ticket. Ten panic taps in a minute = one
--      ticket. A tap on a ticket staff already acknowledged re-alerts ops
--      (at most once a minute; `support_tickets.sos_alerted_at`, a rider-only
--      column). Service role only (the route has already checked who is
--      asking). It never contacts anything outside the database.
--   6. `deliveries.pickup_reminded_at`, `deliveries.delay_alerted_at` — set
--      once by the dispatch sweep when it sends the pickup reminder / the
--      delay alert, conditionally (`where … is null`), so each is sent once.
--   7. `platform_settings.high_demand_ratio` (2.0 waiting orders per online
--      idle rider), `pickup_reminder_minutes` (10), `delay_alert_minutes`
--      (10). Granted by column to anon / authenticated like 0082's rider
--      settings (the settings facade reads with the caller's client; Admin →
--      Settings → Riders edits them). The support phone / WhatsApp numbers already exist
--      (`support_phone`, `support_whatsapp`, 0015) and are reused.
--   8. `delivery_events.kind` gains `note` — a plain line on the order's
--      timeline ("Shop delay reported by the rider: …"). The kind check is
--      rebuilt from whatever list it holds now plus `note`, so kinds another
--      migration added in the meantime are kept.
--
-- Security changes (docs/SECURITY_AUDIT.md applies — logged there):
--   * support_tickets / support_messages: RLS on. A requester reads their own
--     tickets and only the non-internal messages; admins read all; managers
--     read rider emergency / delivery tickets (and all their messages,
--     internal notes included, like 0143's zone read). No insert, update or
--     delete for anon or authenticated: every write is the service role
--     behind a role check, or `rider_raise_sos` (service role only).
--   * Private bucket `support-attachments` (5 MB, jpeg/png). No storage
--     policies: nobody reads an object directly; the server mints a 10-minute
--     signed URL only after checking the ticket is the caller's (or the
--     caller is staff). Paths are `<uploader id>/<uuid>.<jpg|png>`, built by
--     the server, never taken from a client.
--   * user_notifications: the user reads their own rows and may update only
--     `read_at` (column grant + policy). Inserted only by the server.
--   * announcements: readable by signed-in users whose role matches the
--     audience while live; written only by admins (service role). Its rider
--     additions `push_mode` / `pushed_at` (ruling P7-R2) follow the table's
--     SELECT grant and have no anon/authenticated write.
--   * deliveries: two timestamp columns. `deliveries` is readable by the
--     order's customer, shop, rider and ops (existing policies); two
--     "reminder sent at" stamps disclose nothing beyond what those parties
--     already see.
--   * platform_settings: three numeric thresholds, readable by column like
--     0082's rider settings. Nothing sensitive.
--   * support_tickets.sos_alerted_at: a timestamp on rows whose readers
--     (requester, staff) already see the ticket.
--
-- Idempotent: every statement is guarded, so a re-run converges.
-- Re-run rule (ruling P8-R3): re-apply every migration from 0081 through the
-- newest one applied, all branches, in number order — never this file or the
-- rider files alone (Manager 0141, 0142 and 0152 narrow what they open).
--
-- Rollback (in this order):
--   drop function if exists public.rider_raise_sos(uuid, text, text, text, double precision, double precision, uuid, text[], integer);
--   drop policy if exists "support_tickets — manager rider read" on public.support_tickets;
--   drop policy if exists "support_messages — manager rider read" on public.support_messages;
--   drop function if exists public.is_rider_ops_ticket(text, text, text);
--   alter table public.support_tickets drop column if exists sos_alerted_at;
--   drop index if exists public.announcements_push_due_idx;
--   alter table public.announcements drop column if exists push_mode, drop column if exists pushed_at;
--   alter table public.deliveries drop column if exists pickup_reminded_at, drop column if exists delay_alerted_at;
--   alter table public.platform_settings drop column if exists high_demand_ratio,
--     drop column if exists pickup_reminder_minutes, drop column if exists delay_alert_minutes;
--   -- delivery_events: delete from public.delivery_events where kind = 'note'; then drop delivery_events_kind_check
--   -- and add it back with 0082 §2's list (re-running 0082 keeps every kind already allowed, 'note' included).
--   -- and, only if neither the Partner 0064 nor the Manager 0143 has been applied:
--   drop table if exists public.announcements, public.user_notifications;
--   drop function if exists public.announcement_audience_of(uuid);
--   drop table if exists public.support_messages; drop table if exists public.support_tickets;
--   delete from storage.buckets where id = 'support-attachments';
-- ============================================================

-- ============================================================
-- 1 — Support tickets (0064 §3, the shared shape)
-- ============================================================
create table if not exists public.support_tickets (
  id              uuid primary key default gen_random_uuid(),
  number          bigint generated always as identity unique,
  requester_id    uuid not null references public.profiles (id) on delete cascade,
  requester_role  text not null,
  category        text not null,
  priority        text not null default 'normal' check (priority in ('normal', 'high', 'emergency')),
  subject         text not null,
  order_id        uuid references public.orders (id) on delete set null,
  cash_dispute_id uuid,
  lat             double precision,
  lng             double precision,
  status          text not null default 'open'
                  check (status in ('open', 'in_progress', 'waiting_on_requester', 'resolved', 'closed')),
  assigned_to     uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

create index if not exists support_tickets_requester_idx on public.support_tickets (requester_id, created_at desc);
create index if not exists support_tickets_status_idx on public.support_tickets (status, created_at desc);
create index if not exists support_tickets_order_idx on public.support_tickets (order_id);

create table if not exists public.support_messages (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references public.support_tickets (id) on delete cascade,
  author_id   uuid not null references public.profiles (id) on delete cascade,
  author_role text not null,
  body        text not null check (char_length(body) <= 4000),
  attachments text[] not null default '{}' check (cardinality(attachments) <= 4),
  internal    boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists support_messages_ticket_idx on public.support_messages (ticket_id, created_at);

comment on table public.support_tickets is
  'Support and incident tickets from riders, vendors, customers and ops. Written only through the server (service role).';
comment on column public.support_messages.internal is
  'Staff-only note. Never shown to the requester.';

alter table public.support_tickets  enable row level security;
alter table public.support_messages enable row level security;

drop policy if exists "support_tickets — requester read" on public.support_tickets;
create policy "support_tickets — requester read" on public.support_tickets for select
  using (requester_id = auth.uid() or public.is_admin());

drop policy if exists "support_messages — requester read" on public.support_messages;
create policy "support_messages — requester read" on public.support_messages for select
  using (
    public.is_admin()
    or (not internal and exists (
      select 1 from public.support_tickets t where t.id = ticket_id and t.requester_id = auth.uid()))
  );

revoke all on public.support_tickets, public.support_messages from anon, authenticated;
grant select on public.support_tickets, public.support_messages to authenticated;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('support-attachments', 'support-attachments', false, 5242880, array['image/jpeg', 'image/png'])
    on conflict (id) do nothing;
  end if;
end $$;

-- ------------------------------------------------------------
-- 1b — 0143's status list (every 0064 status plus `escalated`), verbatim.
-- ------------------------------------------------------------
alter table public.support_tickets drop constraint if exists support_tickets_status_check;
alter table public.support_tickets add constraint support_tickets_status_check
  check (status in ('open', 'in_progress', 'waiting_on_requester', 'escalated', 'resolved', 'closed'));

-- ============================================================
-- 2 — Notification inbox (0064 §4)
-- ============================================================
create table if not exists public.user_notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null,
  category   text not null,
  title      text not null check (char_length(title) <= 200),
  body       text not null check (char_length(body) <= 1000),
  data       jsonb not null default '{}',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_notifications_user_idx on public.user_notifications (user_id, created_at desc);
create index if not exists user_notifications_unread_idx on public.user_notifications (user_id) where read_at is null;

alter table public.user_notifications enable row level security;

drop policy if exists "user_notifications — own read" on public.user_notifications;
create policy "user_notifications — own read" on public.user_notifications for select
  using (user_id = auth.uid());
drop policy if exists "user_notifications — own mark read" on public.user_notifications;
create policy "user_notifications — own mark read" on public.user_notifications for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.user_notifications from anon, authenticated;
grant select on public.user_notifications to authenticated;
grant update (read_at) on public.user_notifications to authenticated;
grant select, insert, update, delete on public.user_notifications to service_role;

-- ============================================================
-- 3 — Announcements (0064 §5)
-- ============================================================
create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  audience   text not null check (audience in ('rider', 'vendor', 'manager', 'all')),
  title      text not null check (char_length(btrim(title)) between 3 and 120),
  body       text not null check (char_length(body) <= 2000),
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint announcements_window check (ends_at is null or ends_at > starts_at)
);

create index if not exists announcements_live_idx on public.announcements (audience, starts_at desc);

-- ------------------------------------------------------------
-- 3b — Push state on the row (ruling P7-R2; rider additions, guarded).
-- `push_mode`: what the composer asked for — 'now' (pushed at publish),
-- 'scheduled' (the dispatch sweep pushes it once its start has passed),
-- 'none' (never pushed). NULL = written by another composer (the Partner
-- app's or the Manager app's) or before this column: the rider sweep never
-- touches those rows. `pushed_at`: set exactly once, by the claim
-- `update … set pushed_at = now() where id = … and pushed_at is null`, before
-- the fan-out — the row is the latch, so it cannot fail open the way a
-- rate-limit bucket can. Written only by the service role (the table grants
-- authenticated SELECT only).
-- ------------------------------------------------------------
alter table public.announcements
  add column if not exists push_mode text check (push_mode in ('now', 'scheduled', 'none')),
  add column if not exists pushed_at timestamptz;

comment on column public.announcements.push_mode is
  'Rider composer only: now | scheduled | none. NULL = another composer; the rider sweep ignores it.';
comment on column public.announcements.pushed_at is
  'When the fan-out was claimed (set once, where pushed_at is null). The claim IS the once-only latch.';

create index if not exists announcements_push_due_idx
  on public.announcements (starts_at)
  where push_mode = 'scheduled' and pushed_at is null;

-- Which audience a signed-in user belongs to: a shop owner is a vendor whatever
-- their profile role says (0017 lets a customer account own a shop).
-- Ruling P8-R1: it answers only about the CALLER (uid = auth.uid()), unless the
-- caller is an admin or the service role; for anyone else it returns null.
-- As SECURITY DEFINER it reads every profile, and EXECUTE is granted to
-- authenticated (the announcements policy below calls it with auth.uid()), so
-- without this any signed-in user could ask whether a uuid they know belongs
-- to a rider, a manager, a vendor or a customer. Its only caller is that
-- policy (here, and identically in 0064); the server filters audiences itself.
-- Same signature, return type and privileges as 0064's copy, so either order
-- converges; this body is the final one and the Partner branch mirrors it.
create or replace function public.announcement_audience_of(uid uuid)
returns text
language sql stable security definer set search_path = public as $$
  select case
    when p.role = 'driver' then 'rider'
    when p.role = 'manager' then 'manager'
    when p.role = 'restaurant' or exists (select 1 from public.restaurants r where r.owner_id = uid) then 'vendor'
    else 'customer'
  end
  from public.profiles p
  where p.id = uid
    and (uid = auth.uid()
         or public.is_admin()
         or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin'))
$$;
revoke all on function public.announcement_audience_of(uuid) from public, anon;
grant execute on function public.announcement_audience_of(uuid) to authenticated, service_role;

alter table public.announcements enable row level security;

drop policy if exists "announcements — audience read" on public.announcements;
create policy "announcements — audience read" on public.announcements for select
  using (
    public.is_admin()
    or (starts_at <= now() and (ends_at is null or ends_at > now())
        and (audience = 'all' and public.announcement_audience_of(auth.uid()) <> 'customer'
             or audience = public.announcement_audience_of(auth.uid())))
  );

revoke all on public.announcements from anon, authenticated;
grant select on public.announcements to authenticated;
grant select, insert, update, delete on public.announcements to service_role;

-- ============================================================
-- 4 — Managers read rider emergencies and delivery tickets
-- ------------------------------------------------------------
-- The category lists are src/lib/support/rules.ts's: the delivery
-- categories of the rider's §13.3 list, the pickup reports Phase 2 files as
-- tickets (ruling P2-R11), and the five safety categories. A plain SQL
-- function (not definer: it reads nothing) so both policies state one rule.
-- ============================================================
create or replace function public.is_rider_ops_ticket(p_role text, p_priority text, p_category text)
returns boolean
language sql immutable set search_path = public as $$
  select p_role = 'rider' and (
    p_priority = 'emergency'
    or p_category in (
      'vendor_not_handing_over', 'customer_unreachable', 'incorrect_address',
      'delivery_payment', 'cash_reconciliation', 'accident_emergency',
      'missing_items', 'wrong_package', 'vendor_delay', 'other_issue',
      'unsafe_situation', 'accident', 'vehicle_breakdown', 'harassment_threat',
      'suspicious_order_location'))
$$;
revoke all on function public.is_rider_ops_ticket(text, text, text) from public, anon;
grant execute on function public.is_rider_ops_ticket(text, text, text) to authenticated, service_role;

drop policy if exists "support_tickets — manager rider read" on public.support_tickets;
create policy "support_tickets — manager rider read" on public.support_tickets for select
  using (public.current_role() = 'manager'
         and public.is_rider_ops_ticket(requester_role, priority, category));

drop policy if exists "support_messages — manager rider read" on public.support_messages;
create policy "support_messages — manager rider read" on public.support_messages for select
  using (public.current_role() = 'manager' and exists (
    select 1 from public.support_tickets t
     where t.id = ticket_id and public.is_rider_ops_ticket(t.requester_role, t.priority, t.category)));

-- ============================================================
-- 5 — SOS: one emergency ticket per incident
-- ------------------------------------------------------------
-- The rider's open emergency ticket OF THE SAME CATEGORY (not resolved or
-- closed) touched within p_window_minutes gets the new tap as a message — a
-- location update — and its position refreshed; otherwise a new emergency
-- ticket is opened with the tap as its first message. Same category only
-- (fix round 1): an SOS pressed after a breakdown report is a new incident,
-- never a quiet line on the old one. The per-rider transaction advisory lock
-- makes two concurrent taps take turns, so the second always sees the
-- first's ticket.
--
-- Re-alerting: a tap that joins a ticket staff have already acknowledged
-- (assigned, or moved off `open`) returns `rering: true` — the server rings
-- every ops phone again and the banner sounds — at most once a minute per
-- ticket (`sos_alerted_at`, the last time ops were alerted for it; the
-- banner keys its sound on it).
--
-- Returns { ticket_id, number, deduped, rering, alerted_at }.
-- ============================================================
alter table public.support_tickets
  add column if not exists sos_alerted_at timestamptz;

comment on column public.support_tickets.sos_alerted_at is
  'Rider SOS only: when ops were last rung for this ticket (opened, or re-alerted by a later tap after staff acknowledged it). Set by rider_raise_sos.';

create or replace function public.rider_raise_sos(
  p_driver         uuid,
  p_category       text,
  p_subject        text,
  p_body           text,
  p_lat            double precision,
  p_lng            double precision,
  p_order          uuid,
  p_attachments    text[]  default '{}',
  p_window_minutes integer default 10
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  safety constant text[] := array['accident_emergency', 'unsafe_situation', 'accident',
                                  'vehicle_breakdown', 'harassment_threat', 'suspicious_order_location'];
  t      public.support_tickets%rowtype;
  win    constant integer := greatest(1, least(coalesce(p_window_minutes, 10), 60));
  rering boolean;
begin
  if p_category is null or not (p_category = any (safety)) then
    raise exception 'invalid_category' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_body, '')), '') is null then
    raise exception 'invalid_body' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_driver and role = 'driver') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('rider_sos:' || p_driver::text, 0));

  select * into t
    from public.support_tickets
   where requester_id = p_driver
     and priority = 'emergency'
     and category = p_category
     and status not in ('resolved', 'closed')
     and updated_at > now() - make_interval(mins => win)
   order by updated_at desc
   limit 1
   for update;

  if t.id is not null then
    rering := (t.assigned_to is not null or t.status <> 'open')
              and coalesce(t.sos_alerted_at, t.created_at) <= now() - interval '1 minute';
    insert into public.support_messages (ticket_id, author_id, author_role, body, attachments)
    values (t.id, p_driver, 'rider', left(p_body, 4000), coalesce(p_attachments, '{}'));
    update public.support_tickets
       set updated_at = now(),
           lat = coalesce(p_lat, lat),
           lng = coalesce(p_lng, lng),
           order_id = coalesce(order_id, p_order),
           sos_alerted_at = case when rering then now() else sos_alerted_at end
     where id = t.id
    returning * into t;
    return jsonb_build_object('ticket_id', t.id, 'number', t.number, 'deduped', true,
                              'rering', rering, 'alerted_at', t.sos_alerted_at);
  end if;

  insert into public.support_tickets
    (requester_id, requester_role, category, priority, subject, order_id, lat, lng, sos_alerted_at)
  values
    (p_driver, 'rider', p_category, 'emergency', left(coalesce(nullif(btrim(p_subject), ''), 'SOS'), 200),
     p_order, p_lat, p_lng, now())
  returning * into t;

  insert into public.support_messages (ticket_id, author_id, author_role, body, attachments)
  values (t.id, p_driver, 'rider', left(p_body, 4000), coalesce(p_attachments, '{}'));

  return jsonb_build_object('ticket_id', t.id, 'number', t.number, 'deduped', false,
                            'rering', false, 'alerted_at', t.sos_alerted_at);
end;
$$;

revoke all on function public.rider_raise_sos(uuid, text, text, text, double precision, double precision, uuid, text[], integer)
  from public, anon, authenticated;
grant execute on function public.rider_raise_sos(uuid, text, text, text, double precision, double precision, uuid, text[], integer)
  to service_role;

-- ============================================================
-- 6 — deliveries: the reminder / delay stamps
-- ============================================================
alter table public.deliveries
  add column if not exists pickup_reminded_at timestamptz,
  add column if not exists delay_alerted_at   timestamptz;

comment on column public.deliveries.pickup_reminded_at is
  'When the sweep reminded the rider to go and collect (order ready, rider not arrived after pickup_reminder_minutes). Set once.';
comment on column public.deliveries.delay_alerted_at is
  'When the sweep told the rider and ops the delivery was delay_alert_minutes past its ETA. Set once.';

-- ============================================================
-- 7 — platform_settings: alert thresholds
-- ------------------------------------------------------------
-- Readable by column like every non-secret setting (0082's rider settings):
-- the settings facade reads with the caller's own client, and Admin →
-- Settings → Riders edits them. Thresholds, nothing sensitive.
-- ============================================================
alter table public.platform_settings
  add column if not exists high_demand_ratio       numeric(4,2) not null default 2.0,
  add column if not exists pickup_reminder_minutes integer      not null default 10,
  add column if not exists delay_alert_minutes     integer      not null default 10;

do $$
begin
  alter table public.platform_settings
    add constraint platform_settings_high_demand_ratio_range check (high_demand_ratio between 0.5 and 20);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.platform_settings
    add constraint platform_settings_pickup_reminder_range check (pickup_reminder_minutes between 2 and 60);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.platform_settings
    add constraint platform_settings_delay_alert_range check (delay_alert_minutes between 2 and 60);
exception
  when duplicate_object then null;
end $$;

grant select (high_demand_ratio, pickup_reminder_minutes, delay_alert_minutes)
  on public.platform_settings to anon, authenticated;

-- ============================================================
-- 8 — delivery_events: a `note` kind for timeline notes
-- ------------------------------------------------------------
-- Rebuilt from the constraint's current list rather than restated, so a kind
-- another migration added after 0082 survives. Idempotent: a list that
-- already holds 'note' is left alone.
-- ============================================================
do $$
declare
  def   text;
  kinds text[];
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
   where c.conrelid = 'public.delivery_events'::regclass
     and c.conname = 'delivery_events_kind_check';
  if def is null or def ~ '''note''' then
    return;
  end if;
  select array_agg(m[1]) into kinds from regexp_matches(def, '''([a-z_]+)''', 'g') as m;
  alter table public.delivery_events drop constraint delivery_events_kind_check;
  execute format(
    'alter table public.delivery_events add constraint delivery_events_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(k), ', ') from unnest(kinds || array['note']) as k));
end $$;
