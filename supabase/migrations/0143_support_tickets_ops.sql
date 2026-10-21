-- 0143 — Support tickets for operations: the shared ticket tables, the
-- manager extensions (zone, escalation level, team, first response,
-- resolution, the `escalated` status) and order escalation.
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0143.mjs); run it on staging first.
-- Depends on 0141 (zones, staff_zones, _ops_log) and 0142 (ops_require_staff,
-- _ops_replayed, orders.short_code).
-- Plan: docs/superpowers/plans/2026-10-21-manager-app-phase-3-orders-live.md.
--
-- Base tables are the Rider branch's 0087 shape (rider plan phase 7, Task 1),
-- built here first because 0087 had not landed when this was written;
-- whichever is applied first creates them (`create table if not exists`,
-- `drop policy if exists`), so either order converges. `user_notifications`
-- and `announcements` stay with the Rider branch.
--
-- Security changes (docs/SECURITY_AUDIT.md applies):
--   * `support_tickets`, `support_messages`: RLS on. A requester reads their
--     own tickets and only the non-internal messages on them; admins read all;
--     a manager reads the tickets of their zones (and every message on them,
--     internal notes included). No insert, update or delete for anon or
--     authenticated: every write goes through the service role behind a role
--     check, or through ops_escalate_order().
--   * Private bucket `support-attachments` (5 MB, jpeg/png), created only where
--     the storage schema exists. No storage policies: attachments are read
--     through short-lived signed URLs minted by the server.
--   * ops_escalate_order() is service_role only and re-checks the actor's zone
--     in the database (ops_require_staff).
--
-- Rollback:
--   drop function if exists public.ops_escalate_order(uuid, uuid, text, text, text);
--   drop trigger if exists stamp_ticket_zone on public.support_tickets;
--   drop function if exists public.stamp_ticket_zone();
--   drop policy if exists "support_tickets — manager zone read" on public.support_tickets;
--   drop policy if exists "support_messages — manager zone read" on public.support_messages;
--   alter table public.support_tickets drop constraint if exists support_tickets_status_check;
--   alter table public.support_tickets add constraint support_tickets_status_check
--     check (status in ('open','in_progress','waiting_on_requester','resolved','closed'));
--   alter table public.support_tickets drop column if exists team, drop column if exists escalation_level,
--     drop column if exists first_response_at, drop column if exists resolution, drop column if exists zone_id;
--   -- and, only if the Rider branch's 0087 has not been applied:
--   drop table if exists public.support_messages; drop table if exists public.support_tickets;
--   delete from storage.buckets where id = 'support-attachments';

-- 1. Base tables (0087's shape) -------------------------------------------------
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
  status          text not null default 'open',
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

-- 2. Manager extensions ----------------------------------------------------------
alter table public.support_tickets
  add column if not exists team              text,
  add column if not exists escalation_level  smallint not null default 0,
  add column if not exists first_response_at timestamptz,
  add column if not exists resolution        text,
  add column if not exists zone_id           uuid references public.delivery_zones (id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.support_tickets'::regclass
                    and conname = 'support_tickets_escalation_level_range') then
    alter table public.support_tickets
      add constraint support_tickets_escalation_level_range check (escalation_level between 0 and 3);
  end if;
end $$;

-- Every 0087 status plus `escalated`.
alter table public.support_tickets drop constraint if exists support_tickets_status_check;
alter table public.support_tickets add constraint support_tickets_status_check
  check (status in ('open', 'in_progress', 'waiting_on_requester', 'escalated', 'resolved', 'closed'));

create index if not exists support_tickets_zone_idx on public.support_tickets (zone_id, status, created_at desc);

comment on column public.support_tickets.zone_id is
  'Zone the ticket belongs to: the order''s zone, else the requester''s first zone. Decides which managers see it.';

-- The zone is derived, never trusted from the writer.
create or replace function public.stamp_ticket_zone()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.order_id is not null then
    select o.zone_id into new.zone_id from public.orders o where o.id = new.order_id;
  end if;
  if new.zone_id is null then
    select sz.zone_id into new.zone_id
      from public.staff_zones sz
     where sz.user_id = new.requester_id
     order by sz.created_at, sz.zone_id
     limit 1;
  end if;
  return new;
end;
$$;
revoke all on function public.stamp_ticket_zone() from public;

drop trigger if exists stamp_ticket_zone on public.support_tickets;
create trigger stamp_ticket_zone
  before insert on public.support_tickets
  for each row execute function public.stamp_ticket_zone();

-- 3. RLS ---------------------------------------------------------------------------
alter table public.support_tickets  enable row level security;
alter table public.support_messages enable row level security;

drop policy if exists "support_tickets — requester read" on public.support_tickets;
create policy "support_tickets — requester read" on public.support_tickets for select
  using (requester_id = auth.uid() or public.is_admin());

drop policy if exists "support_tickets — manager zone read" on public.support_tickets;
create policy "support_tickets — manager zone read" on public.support_tickets for select
  using (public.manager_can_see_zone(zone_id));

drop policy if exists "support_messages — requester read" on public.support_messages;
create policy "support_messages — requester read" on public.support_messages for select
  using (
    public.is_admin()
    or (not internal and exists (
      select 1 from public.support_tickets t where t.id = ticket_id and t.requester_id = auth.uid()))
  );

drop policy if exists "support_messages — manager zone read" on public.support_messages;
create policy "support_messages — manager zone read" on public.support_messages for select
  using (exists (
    select 1 from public.support_tickets t where t.id = ticket_id and public.manager_can_see_zone(t.zone_id)));

revoke all on public.support_tickets, public.support_messages from anon, authenticated;
grant select on public.support_tickets, public.support_messages to authenticated;

-- 4. Private attachments bucket (only where Supabase storage exists) --------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('support-attachments', 'support-attachments', false, 5242880, array['image/jpeg', 'image/png'])
    on conflict (id) do nothing;
  end if;
end $$;

-- 5. Escalating an order -----------------------------------------------------------
-- One open ticket per order for order issues: a second escalation raises the
-- level and adds a message instead of opening a duplicate.
create or replace function public.ops_escalate_order(
  p_actor uuid, p_order uuid, p_reason text, p_priority text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o         public.orders%rowtype;
  t         public.support_tickets%rowtype;
  role_name text;
  why       constant text := nullif(trim(coalesce(p_reason, '')), '');
  prio      constant text := coalesce(nullif(p_priority, ''), 'high');
  prev_lvl  smallint;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  role_name := public.ops_require_staff(p_actor, o.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    select st.* into t
      from public.ops_audit_log l
      join public.support_tickets st on st.id = (l.after ->> 'ticketId')::uuid
     where l.client_action_id = p_client_action_id;
    return jsonb_build_object('ticket_id', t.id, 'number', t.number);
  end if;
  if why is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if prio not in ('high', 'emergency') then
    raise exception 'invalid_transition' using errcode = '22023', detail = 'priority must be high or emergency';
  end if;

  select * into t from public.support_tickets
   where order_id = p_order and category = 'order_issue' and status not in ('resolved', 'closed')
   order by created_at desc
   limit 1
   for update;

  if t.id is null then
    insert into public.support_tickets
      (requester_id, requester_role, category, priority, subject, order_id, status, escalation_level, zone_id)
    values
      (p_actor, role_name, 'order_issue', prio, 'Order ' || o.short_code, p_order, 'escalated', 1, o.zone_id)
    returning * into t;
    prev_lvl := 0;
  else
    prev_lvl := t.escalation_level;
    update public.support_tickets
       set escalation_level = least(escalation_level + 1, 3),
           status = 'escalated',
           priority = case when prio = 'emergency' or priority = 'emergency' then 'emergency' else 'high' end,
           updated_at = now()
     where id = t.id
    returning * into t;
  end if;

  insert into public.support_messages (ticket_id, author_id, author_role, body, internal)
  values (t.id, p_actor, role_name, left(why, 4000), false);

  perform public._ops_log(p_actor, 'order.escalate', 'order', p_order::text, o.zone_id, why,
                          jsonb_build_object('escalationLevel', prev_lvl),
                          jsonb_build_object('ticketId', t.id, 'number', t.number,
                                             'escalationLevel', t.escalation_level, 'priority', t.priority),
                          p_client_action_id);
  return jsonb_build_object('ticket_id', t.id, 'number', t.number);
end;
$$;

revoke execute on function public.ops_escalate_order(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.ops_escalate_order(uuid, uuid, text, text, text) to service_role;
