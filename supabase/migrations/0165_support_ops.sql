-- ============================================================
-- 0165 — Support operations: assignment, priority, escalation, ticket history,
--        the transition table, reopen rules and ticket metrics
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL — not applied to any database.
-- Deploy order: 0064 → 0087 → 0141 → 0142 → 0143 → 0145 → … → 0165.
--
-- Builds on the ONE copy of the ticket tables (0064 / 0087: support_tickets
-- with `assigned_to`, support_messages with `internal`) and 0143's manager
-- extensions (team, escalation_level, first_response_at, resolution, zone_id,
-- the `escalated` status). Nothing here creates a second ticket table.
--
-- What it adds:
--   * support_tickets.assigned_at, reopened_count; queue indexes.
--   * support_ticket_events — the requester-safe history, written only by
--     triggers (created, status, assigned, team, priority, escalated, reopened,
--     first_response, attachment). Internal-note attachments are flagged
--     `internal` and never shown to the requester.
--   * reopen_on_requester_reply — a requester's message on a resolved ticket
--     puts it back in progress.
--   * ops_set_ticket_status re-declared with the transition table and a reason
--     for reopening (the 0145 five-argument form is kept as a wrapper);
--     ops_add_ticket_message re-declared with attachments (wrapper kept).
--   * ops_assign_ticket, ops_set_ticket_priority, ops_escalate_ticket — one
--     audited transaction each, zone-checked, replay-safe.
--   * ops_ticket_metrics — first response, resolution, recurring problems.
--
-- Transition table (escalated is reached only through ops_escalate_ticket):
--   open                 → in_progress | waiting_on_requester | resolved
--   in_progress          → waiting_on_requester | resolved
--   waiting_on_requester → in_progress | resolved
--   escalated            → in_progress | waiting_on_requester | resolved
--   resolved             → closed | in_progress (reopen, reason required)
--   closed               → (final)
--
-- Rollback:
--   drop function if exists public.ops_ticket_metrics(uuid[], boolean, date, date, int);
--   drop function if exists public.ops_escalate_ticket(uuid, uuid, text, text);
--   drop function if exists public.ops_set_ticket_priority(uuid, uuid, text, text, text);
--   drop function if exists public.ops_assign_ticket(uuid, uuid, uuid, text, text);
--   drop function if exists public.ops_add_ticket_message(uuid, uuid, text, boolean, text[], text);
--   drop function if exists public.ops_set_ticket_status(uuid, uuid, text, text, text, text);
--   -- then re-run 0145 §6 to restore its ops_add_ticket_message / ops_set_ticket_status
--   drop function if exists public.ops_ticket_allowed_transitions(text);
--   drop function if exists public._ops_staff_flag_on(uuid, text, boolean);
--   drop trigger if exists reopen_on_requester_reply on public.support_messages;
--   drop trigger if exists log_ticket_message_event on public.support_messages;
--   drop trigger if exists log_ticket_event on public.support_tickets;
--   drop function if exists public.reopen_on_requester_reply();
--   drop function if exists public.log_ticket_message_event();
--   drop function if exists public.log_ticket_event();
--   drop table if exists public.support_ticket_events;
--   alter table public.support_tickets drop column if exists assigned_at, drop column if exists reopened_count;
--   update storage.buckets set allowed_mime_types = array['image/jpeg', 'image/png'] where id = 'support-attachments';
-- ============================================================

begin;

-- 1. Columns and queue indexes ---------------------------------------------------
alter table public.support_tickets
  add column if not exists assigned_at    timestamptz,
  add column if not exists reopened_count smallint not null default 0;

create index if not exists support_tickets_zone_queue_idx on public.support_tickets (zone_id, status, created_at desc);
create index if not exists support_tickets_assignee_idx on public.support_tickets (assigned_to, status);

-- Staff replies may attach WebP images and PDFs (a refund receipt, an invoice)
-- as well as the JPEG / PNG photos requesters send; the route checks each
-- file's first bytes too. 5 MB a file, as before.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    update storage.buckets
       set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
     where id = 'support-attachments';
  end if;
end $$;

-- 2. Ticket history -----------------------------------------------------------------
create table if not exists public.support_ticket_events (
  id         bigint generated always as identity primary key,
  ticket_id  uuid not null references public.support_tickets (id) on delete cascade,
  kind       text not null check (kind in ('created', 'status', 'assigned', 'team', 'priority',
                                           'escalated', 'reopened', 'first_response', 'attachment')),
  from_value text,
  to_value   text,
  actor_id   uuid,
  reason     text,
  internal   boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists support_ticket_events_ticket_idx on public.support_ticket_events (ticket_id, created_at);

comment on table public.support_ticket_events is
  'Requester-safe ticket history, written only by triggers (0165). Rows with internal = true are staff-only.';

alter table public.support_ticket_events enable row level security;

drop policy if exists "support_ticket_events — read" on public.support_ticket_events;
create policy "support_ticket_events — read" on public.support_ticket_events for select
  using (
    public.is_admin()
    or exists (select 1 from public.support_tickets t
                where t.id = ticket_id and public.manager_can_see_zone(t.zone_id))
    or (not internal and exists (select 1 from public.support_tickets t
                                  where t.id = ticket_id and t.requester_id = auth.uid()))
  );

revoke all on public.support_ticket_events from anon, authenticated;
grant select on public.support_ticket_events to authenticated;
revoke insert, update, delete, truncate on public.support_ticket_events from service_role;
grant select on public.support_ticket_events to service_role;

-- The acting person: the signed-in user, else the ops actor an RPC set (0142).
create or replace function public._ticket_event_actor()
returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(auth.uid(), nullif(current_setting('deligro.actor_id', true), '')::uuid);
$$;
revoke execute on function public._ticket_event_actor() from public, anon, authenticated, service_role;

create or replace function public.log_ticket_event()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  actor  constant uuid := public._ticket_event_actor();
  reason constant text := nullif(current_setting('deligro.ops_reason', true), '');
begin
  if tg_op = 'INSERT' then
    insert into public.support_ticket_events (ticket_id, kind, to_value, actor_id)
    values (new.id, 'created', new.status, coalesce(actor, new.requester_id));
    return null;
  end if;

  if new.status is distinct from old.status then
    insert into public.support_ticket_events (ticket_id, kind, from_value, to_value, actor_id, reason)
    values (new.id,
            case when old.status = 'resolved' and new.status not in ('closed', 'resolved') then 'reopened'
                 when new.status = 'escalated' then 'escalated'
                 else 'status' end,
            old.status, new.status, actor, reason);
  elsif new.escalation_level is distinct from old.escalation_level then
    -- A further escalation while already escalated.
    insert into public.support_ticket_events (ticket_id, kind, from_value, to_value, actor_id, reason)
    values (new.id, 'escalated', old.escalation_level::text, new.escalation_level::text, actor, reason);
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    insert into public.support_ticket_events (ticket_id, kind, from_value, to_value, actor_id, reason)
    values (new.id, 'assigned', old.assigned_to::text, new.assigned_to::text, actor, reason);
  end if;
  if new.team is distinct from old.team then
    insert into public.support_ticket_events (ticket_id, kind, from_value, to_value, actor_id, reason)
    values (new.id, 'team', old.team, new.team, actor, reason);
  end if;
  if new.priority is distinct from old.priority then
    insert into public.support_ticket_events (ticket_id, kind, from_value, to_value, actor_id, reason)
    values (new.id, 'priority', old.priority, new.priority, actor, reason);
  end if;
  if old.first_response_at is null and new.first_response_at is not null then
    insert into public.support_ticket_events (ticket_id, kind, actor_id)
    values (new.id, 'first_response', actor);
  end if;
  return null;
end;
$$;
revoke execute on function public.log_ticket_event() from public, anon, authenticated;

drop trigger if exists log_ticket_event on public.support_tickets;
create trigger log_ticket_event after insert or update on public.support_tickets
  for each row execute function public.log_ticket_event();

create or replace function public.log_ticket_message_event()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if cardinality(coalesce(new.attachments, '{}')) > 0 then
    insert into public.support_ticket_events (ticket_id, kind, to_value, actor_id, internal)
    values (new.ticket_id, 'attachment', cardinality(new.attachments)::text, new.author_id, coalesce(new.internal, false));
  end if;
  return null;
end;
$$;
revoke execute on function public.log_ticket_message_event() from public, anon, authenticated;

drop trigger if exists log_ticket_message_event on public.support_messages;
create trigger log_ticket_message_event after insert on public.support_messages
  for each row execute function public.log_ticket_message_event();

-- 3. A requester's reply reopens a resolved ticket --------------------------------
create or replace function public.reopen_on_requester_reply()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.internal, false) then
    return null;
  end if;
  update public.support_tickets
     set status = 'in_progress', reopened_count = reopened_count + 1, updated_at = now()
   where id = new.ticket_id and requester_id = new.author_id and status = 'resolved';
  return null;
end;
$$;
revoke execute on function public.reopen_on_requester_reply() from public, anon, authenticated;

drop trigger if exists reopen_on_requester_reply on public.support_messages;
create trigger reopen_on_requester_reply after insert on public.support_messages
  for each row execute function public.reopen_on_requester_reply();

-- 4. Helpers --------------------------------------------------------------------------
-- One manager switch for one person, in SQL: the person's row, else the
-- role-wide row, else the catalog default (src/lib/features/resolve.ts).
create or replace function public._ops_staff_flag_on(p_user uuid, p_feature text, p_default boolean)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select f.enabled from public.role_feature_flags f
      where f.feature = p_feature and f.subject_kind = 'profile' and f.subject_id = p_user limit 1),
    (select f.enabled from public.role_feature_flags f
      where f.feature = p_feature and f.subject_kind = 'role' and f.subject_id is null limit 1),
    p_default);
$$;
revoke execute on function public._ops_staff_flag_on(uuid, text, boolean) from public, anon, authenticated, service_role;

-- The status moves a staff member may make from `p_status` (escalated is
-- reached only through ops_escalate_ticket). Pure; the route shows it.
create or replace function public.ops_ticket_allowed_transitions(p_status text)
returns text[]
language sql immutable set search_path = public as $$
  select case p_status
    when 'open'                 then array['in_progress', 'waiting_on_requester', 'resolved']
    when 'in_progress'          then array['waiting_on_requester', 'resolved']
    when 'waiting_on_requester' then array['in_progress', 'resolved']
    when 'escalated'            then array['in_progress', 'waiting_on_requester', 'resolved']
    when 'resolved'             then array['closed', 'in_progress']
    else array[]::text[]
  end;
$$;
grant execute on function public.ops_ticket_allowed_transitions(text) to service_role;

-- 5. Status (re-declared from 0145 with the transition table) ---------------------
create or replace function public.ops_set_ticket_status(
  p_actor uuid, p_ticket uuid, p_status text, p_resolution text, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t            record;
  v_resolution constant text := nullif(trim(coalesce(p_resolution, '')), '');
  v_reason     constant text := nullif(trim(coalesce(p_reason, '')), '');
  reopening    boolean;
begin
  select id, zone_id, status, resolution into t from public.support_tickets where id = p_ticket for update;
  if t.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, t.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['ticket.status', 'ticket.reopen'], p_ticket::text);
    return jsonb_build_object('ticket_id', p_ticket, 'status', t.status, 'replayed', true);
  end if;
  if not (p_status = any (public.ops_ticket_allowed_transitions(t.status))) then
    raise exception 'invalid_transition' using errcode = '22023',
      detail = array_to_string(public.ops_ticket_allowed_transitions(t.status), ',');
  end if;

  reopening := t.status = 'resolved' and p_status = 'in_progress';
  if reopening and (v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 300) then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_status = 'resolved'
     and (v_resolution is null or char_length(v_resolution) < 3 or char_length(v_resolution) > 1000) then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_status = 'closed' and coalesce(v_resolution, t.resolution) is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if v_resolution is not null and char_length(v_resolution) > 1000 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  perform public._ops_set_actor(p_actor, coalesce(v_reason, v_resolution));
  update public.support_tickets
     set status = p_status,
         resolution = case when p_status in ('resolved', 'closed') then coalesce(v_resolution, resolution) else resolution end,
         -- The first resolution is kept through a reopen (metrics count it once).
         resolved_at = case when p_status in ('resolved', 'closed') then coalesce(resolved_at, now()) else resolved_at end,
         reopened_count = reopened_count + case when reopening then 1 else 0 end,
         updated_at = now()
   where id = p_ticket;

  perform public._ops_log(
    p_actor, case when reopening then 'ticket.reopen' else 'ticket.status' end, 'ticket', p_ticket::text, t.zone_id,
    coalesce(v_reason, v_resolution),
    jsonb_build_object('status', t.status), jsonb_build_object('status', p_status), p_client_action_id);
  return jsonb_build_object('ticket_id', p_ticket, 'status', p_status, 'replayed', false);
end;
$$;

-- The 0145 form, for its callers: no reopen reason.
create or replace function public.ops_set_ticket_status(
  p_actor uuid, p_ticket uuid, p_status text, p_resolution text, p_client_action_id text
)
returns jsonb
language sql security definer set search_path = public as $$
  select public.ops_set_ticket_status(p_actor, p_ticket, p_status, p_resolution, null::text, p_client_action_id);
$$;

-- 6. Messages (re-declared from 0145 with attachments) ----------------------------
create or replace function public.ops_add_ticket_message(
  p_actor uuid, p_ticket uuid, p_body text, p_internal boolean, p_attachments text[], p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t         record;
  role_name text;
  body      constant text := trim(coalesce(p_body, ''));
  internal_ constant boolean := coalesce(p_internal, false);
  files     constant text[] := coalesce(p_attachments, '{}');
  mid       uuid;
begin
  select id, zone_id, status, first_response_at into t
    from public.support_tickets where id = p_ticket for update;
  if t.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  role_name := public.ops_require_staff(p_actor, t.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['ticket.message'], p_ticket::text);
    return jsonb_build_object('ticket_id', p_ticket, 'replayed', true);
  end if;
  if char_length(body) < 1 or char_length(body) > 4000 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if cardinality(files) > 4 or exists (select 1 from unnest(files) f where f not like p_ticket::text || '/%') then
    raise exception 'bad_file' using errcode = '22023';
  end if;
  if t.status = 'closed' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  perform public._ops_set_actor(p_actor, null);
  insert into public.support_messages (ticket_id, author_id, author_role, body, internal, attachments)
  values (p_ticket, p_actor, role_name, body, internal_, files)
  returning id into mid;

  update public.support_tickets
     set first_response_at = case when not internal_ and first_response_at is null then now() else first_response_at end,
         status = case when not internal_ and status = 'open' then 'in_progress' else status end,
         updated_at = now()
   where id = p_ticket;

  perform public._ops_log(
    p_actor, 'ticket.message', 'ticket', p_ticket::text, t.zone_id, null, null,
    jsonb_build_object('messageId', mid, 'internal', internal_, 'attachments', cardinality(files)), p_client_action_id);
  return jsonb_build_object('ticket_id', p_ticket, 'message_id', mid, 'replayed', false);
end;
$$;

create or replace function public.ops_add_ticket_message(
  p_actor uuid, p_ticket uuid, p_body text, p_internal boolean, p_client_action_id text
)
returns jsonb
language sql security definer set search_path = public as $$
  select public.ops_add_ticket_message(p_actor, p_ticket, p_body, p_internal, '{}'::text[], p_client_action_id);
$$;

-- 7. Assignment, priority, escalation ------------------------------------------------
create or replace function public.ops_assign_ticket(
  p_actor uuid, p_ticket uuid, p_assignee uuid, p_team text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t      record;
  a_role text;
  v_team constant text := nullif(trim(coalesce(p_team, '')), '');
begin
  select id, zone_id, status, assigned_to, team into t from public.support_tickets where id = p_ticket for update;
  if t.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, t.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['ticket.assign'], p_ticket::text);
    return jsonb_build_object('ticket_id', p_ticket, 'replayed', true);
  end if;
  if v_team is not null and v_team not in ('operations', 'finance', 'vendor_support', 'rider_support', 'customer_support') then
    raise exception 'bad_team' using errcode = '22023';
  end if;
  if t.status = 'closed' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if p_assignee is not null then
    select p.role::text into a_role from public.profiles p where p.id = p_assignee;
    if not (
      a_role = 'admin'
      or (a_role = 'manager'
          and t.zone_id is not null
          and exists (select 1 from public.staff_zones sz where sz.user_id = p_assignee and sz.zone_id = t.zone_id)
          and public._ops_staff_flag_on(p_assignee, 'manager.support.manage', true))
    ) then
      raise exception 'assignee_ineligible' using errcode = '22023';
    end if;
  end if;

  perform public._ops_set_actor(p_actor, null);
  update public.support_tickets
     set assigned_to = p_assignee,
         assigned_at = case when p_assignee is null then null
                            when p_assignee is distinct from assigned_to then now() else assigned_at end,
         team = v_team,
         updated_at = now()
   where id = p_ticket;

  perform public._ops_log(
    p_actor, 'ticket.assign', 'ticket', p_ticket::text, t.zone_id, null,
    jsonb_build_object('assignedTo', t.assigned_to, 'team', t.team),
    jsonb_build_object('assignedTo', p_assignee, 'team', v_team), p_client_action_id);
  return jsonb_build_object('ticket_id', p_ticket, 'replayed', false);
end;
$$;

create or replace function public.ops_set_ticket_priority(
  p_actor uuid, p_ticket uuid, p_priority text, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t        record;
  v_reason constant text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select id, zone_id, status, priority into t from public.support_tickets where id = p_ticket for update;
  if t.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, t.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['ticket.priority'], p_ticket::text);
    return jsonb_build_object('ticket_id', p_ticket, 'priority', t.priority, 'replayed', true);
  end if;
  if p_priority not in ('normal', 'high', 'emergency') then
    raise exception 'bad_request' using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if t.status = 'closed' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  perform public._ops_set_actor(p_actor, v_reason);
  update public.support_tickets set priority = p_priority, updated_at = now() where id = p_ticket;

  perform public._ops_log(
    p_actor, 'ticket.priority', 'ticket', p_ticket::text, t.zone_id, v_reason,
    jsonb_build_object('priority', t.priority), jsonb_build_object('priority', p_priority), p_client_action_id);
  return jsonb_build_object('ticket_id', p_ticket, 'priority', p_priority, 'replayed', false);
end;
$$;

create or replace function public.ops_escalate_ticket(
  p_actor uuid, p_ticket uuid, p_reason text, p_client_action_id text
)
returns int
language plpgsql security definer set search_path = public as $$
declare
  t        record;
  v_reason constant text := nullif(trim(coalesce(p_reason, '')), '');
  v_level  int;
begin
  select id, zone_id, status, escalation_level into t from public.support_tickets where id = p_ticket for update;
  if t.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, t.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['ticket.escalate'], p_ticket::text);
    return coalesce(t.escalation_level, 0);
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if t.status in ('resolved', 'closed') then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if coalesce(t.escalation_level, 0) >= 3 then
    raise exception 'max_level' using errcode = '22023';
  end if;
  v_level := coalesce(t.escalation_level, 0) + 1;

  perform public._ops_set_actor(p_actor, v_reason);
  update public.support_tickets
     set escalation_level = v_level, status = 'escalated', updated_at = now()
   where id = p_ticket;

  perform public._ops_log(
    p_actor, 'ticket.escalate', 'ticket', p_ticket::text, t.zone_id, v_reason,
    jsonb_build_object('level', t.escalation_level, 'status', t.status),
    jsonb_build_object('level', v_level, 'status', 'escalated'), p_client_action_id);
  return v_level;
end;
$$;

-- 8. Metrics ----------------------------------------------------------------------------
-- Over tickets CREATED in [p_from, p_to] (IST dates, inclusive). First response
-- and resolution in minutes; open tickets are left out of resolution averages
-- and counted in openOverSla when they have had no first response for more
-- than p_sla_minutes. Names are joined by the route.
create or replace function public.ops_ticket_metrics(
  p_zone_ids uuid[], p_all boolean, p_from date, p_to date, p_sla_minutes int default 30
)
returns jsonb
language sql stable security definer set search_path = public as $$
  with bounds as (
    select (p_from::timestamp at time zone 'Asia/Kolkata') as lo,
           ((p_to + 1)::timestamp at time zone 'Asia/Kolkata') as hi
  ),
  tk as (
    select t.*,
           extract(epoch from (t.first_response_at - t.created_at)) / 60.0 as fr_min,
           extract(epoch from (t.resolved_at - t.created_at)) / 60.0 as res_min,
           coalesce(
             case when t.requester_role in ('rider', 'driver') then t.requester_id end,
             (select d.driver_id from public.deliveries d where d.order_id = t.order_id)
           ) as rider_id
      from public.support_tickets t, bounds b
     where t.created_at >= b.lo and t.created_at < b.hi
       and (coalesce(p_all, false) or t.zone_id = any (coalesce(p_zone_ids, '{}')))
  ),
  total as (select count(*)::numeric as n from tk),
  top_cat as (
    select category as key, count(*) as n from tk group by category order by count(*) desc, category limit 5
  ),
  top_vendor as (
    select restaurant_id as id, count(*) as n from tk where restaurant_id is not null
     group by restaurant_id order by count(*) desc, restaurant_id limit 5
  ),
  top_rider as (
    select rider_id as id, count(*) as n from tk where rider_id is not null
     group by rider_id order by count(*) desc, rider_id limit 5
  ),
  top_zone as (
    select zone_id as id, count(*) as n from tk where zone_id is not null
     group by zone_id order by count(*) desc, zone_id limit 5
  ),
  top_order as (
    select order_id as id, count(*) as n from tk where order_id is not null
     group by order_id having count(*) >= 2 order by count(*) desc, order_id limit 5
  ),
  days as (
    select d::date as day
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from::text, 'to', p_to::text),
    'created', (select count(*) from tk),
    'resolved', (select count(*) from tk where resolved_at is not null),
    'reopened', (select count(*) from tk where reopened_count > 0),
    'openOverSla', (select count(*) from tk
                     where status not in ('resolved', 'closed') and first_response_at is null
                       and created_at < now() - make_interval(mins => coalesce(p_sla_minutes, 30))),
    'firstResponse', (select jsonb_build_object(
        'avgMinutes', coalesce(round(avg(fr_min))::int, null),
        'medianMinutes', coalesce(round((percentile_cont(0.5) within group (order by fr_min))::numeric)::int, null),
        'count', count(fr_min)) from tk where fr_min is not null),
    'resolution', (select jsonb_build_object(
        'avgMinutes', coalesce(round(avg(res_min))::int, null),
        'medianMinutes', coalesce(round((percentile_cont(0.5) within group (order by res_min))::numeric)::int, null),
        'count', count(res_min)) from tk where res_min is not null),
    'byStatus', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from tk group by status) s),
    'byPriority', (select coalesce(jsonb_object_agg(priority, n), '{}') from (select priority, count(*) n from tk group by priority) s),
    'byRequesterRole', (select coalesce(jsonb_object_agg(requester_role, n), '{}') from (select requester_role, count(*) n from tk group by requester_role) s),
    'recurring', jsonb_build_object(
      'categories', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'count', n, 'share', n / nullif((select n from total), 0)) order by n desc, key), '[]') from top_cat),
      'vendors', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'count', n, 'share', n / nullif((select n from total), 0)) order by n desc, id), '[]') from top_vendor),
      'riders', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'count', n, 'share', n / nullif((select n from total), 0)) order by n desc, id), '[]') from top_rider),
      'zones', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'count', n, 'share', n / nullif((select n from total), 0)) order by n desc, id), '[]') from top_zone),
      'orders', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'count', n) order by n desc, id), '[]') from top_order)
    ),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object(
        'date', d.day::text,
        'created', (select count(*) from tk where (tk.created_at at time zone 'Asia/Kolkata')::date = d.day),
        'resolved', (select count(*) from tk where tk.resolved_at is not null and (tk.resolved_at at time zone 'Asia/Kolkata')::date = d.day)
      ) order by d.day), '[]') from days d)
  );
$$;

-- 9. Grants ------------------------------------------------------------------------------
revoke execute on function public.ops_set_ticket_status(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_set_ticket_status(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_add_ticket_message(uuid, uuid, text, boolean, text[], text) from public, anon, authenticated;
revoke execute on function public.ops_add_ticket_message(uuid, uuid, text, boolean, text) from public, anon, authenticated;
revoke execute on function public.ops_assign_ticket(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ops_set_ticket_priority(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_escalate_ticket(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ops_ticket_metrics(uuid[], boolean, date, date, int) from public, anon, authenticated;
revoke execute on function public.ops_ticket_allowed_transitions(text) from public, anon, authenticated;
grant execute on function public.ops_set_ticket_status(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.ops_set_ticket_status(uuid, uuid, text, text, text) to service_role;
grant execute on function public.ops_add_ticket_message(uuid, uuid, text, boolean, text[], text) to service_role;
grant execute on function public.ops_add_ticket_message(uuid, uuid, text, boolean, text) to service_role;
grant execute on function public.ops_assign_ticket(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.ops_set_ticket_priority(uuid, uuid, text, text, text) to service_role;
grant execute on function public.ops_escalate_ticket(uuid, uuid, text, text) to service_role;
grant execute on function public.ops_ticket_metrics(uuid[], boolean, date, date, int) to service_role;

commit;
