-- ============================================================
-- 0166 — Ops alerts: per-zone rules, one row per condition, lifecycle,
--        audited acknowledge / resolve / incident / threshold changes
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL — not applied to any database.
-- Deploy order: … → 0141 → 0142 → 0151 → 0165 → 0166.
--
-- The alert ENGINE lives in the server (src/lib/ops/alerts/*): it evaluates
-- conditions and calls ops_raise_alert / ops_clear_alerts. This migration is
-- the store and its rules:
--   * ops_alert_rules — one platform default per kind (zone_id null, seeded
--     below) and optional per-zone overrides. Thresholds are not sensitive:
--     every manager reads every rule; writes go through the audited RPCs.
--   * ops_alerts — one row per dedupe_key. A raise on an open alert updates
--     it (severity only rises); a raise on a resolved alert reopens the same
--     row and pushes again only after a 15-minute cooldown (anti-flap).
--     ops_clear_alerts resolves what the evaluator no longer sees.
--   * ops_alert_events — the alert's own history, written by the RPCs.
--   * ops_alert_runs + ops_claim_alert_run — one evaluation at a time.
--
-- Visibility: admins see every alert; a manager sees alerts in their zones and
-- platform-wide (zone null) INCIDENTS only. The permission audiences (finance,
-- marketing, support kinds) are applied by the route — permissions live in the
-- flag catalog, not here.
--
-- Rollback:
--   drop function if exists public.ops_reset_alert_rule(uuid, text, uuid, text);
--   drop function if exists public.ops_set_alert_rule(uuid, text, uuid, boolean, numeric, int, text);
--   drop function if exists public.ops_raise_incident(uuid, uuid, text, text, text, text);
--   drop function if exists public.ops_resolve_alert(uuid, uuid, text, text);
--   drop function if exists public.ops_ack_alert(uuid, uuid, text);
--   drop function if exists public.ops_mark_alert_pushed(uuid);
--   drop function if exists public.ops_clear_alerts(text, text[]);
--   drop function if exists public.ops_raise_alert(text, text, text, text, uuid, text, text, text);
--   drop function if exists public.ops_claim_alert_run(text, int);
--   drop function if exists public._ops_alert_staff(uuid, uuid, text);
--   drop function if exists public._ops_alert_unit(text);
--   drop function if exists public._ops_severity_rank(text);
--   drop table if exists public.ops_alert_runs, public.ops_alert_events, public.ops_alerts, public.ops_alert_rules;
-- ============================================================

begin;

-- 1. Kinds and units ------------------------------------------------------------------
-- The unit of a kind's threshold; null = the kind has no threshold. Mirrors
-- ALERT_KINDS in src/lib/ops/alerts/catalog.ts.
create or replace function public._ops_alert_unit(p_kind text)
returns text
language sql immutable set search_path = public as $$
  select case
    when p_kind in ('order_needs_intervention', 'order_unassigned', 'delivery_delayed', 'vendor_downtime',
                    'complaint_high_priority', 'rider_inactive') then 'minutes'
    when p_kind = 'high_cancellation_rate' then 'percent'
    when p_kind = 'rider_shortage' then 'ratio'
    when p_kind = 'cash_discrepancy' then 'rupees'
    when p_kind in ('delivery_failed', 'settlement_delayed', 'rider_payout_issue', 'marketing_request_new',
                    'incident', 'fraud_suspected', 'sla_breach') then 'none'
    else null
  end;
$$;

create or replace function public._ops_severity_rank(p text)
returns int
language sql immutable set search_path = public as $$
  select case p when 'info' then 1 when 'warning' then 2 when 'critical' then 3 else 0 end;
$$;

-- 2. Rules --------------------------------------------------------------------------------
create table if not exists public.ops_alert_rules (
  id             bigint generated always as identity primary key,
  kind           text not null check (public._ops_alert_unit(kind) is not null),
  zone_id        uuid references public.delivery_zones (id) on delete cascade,
  enabled        boolean not null default true,
  threshold      numeric,
  window_minutes int check (window_minutes is null or window_minutes between 5 and 1440),
  updated_by     uuid references public.profiles (id) on delete set null,
  updated_at     timestamptz not null default now(),
  constraint ops_alert_rules_kind_zone unique nulls not distinct (kind, zone_id)
);

insert into public.ops_alert_rules (kind, zone_id, enabled, threshold, window_minutes) values
  ('order_needs_intervention', null, true,  5,    null),
  ('order_unassigned',         null, true,  5,    null),
  ('delivery_delayed',         null, true,  10,   null),
  ('high_cancellation_rate',   null, true,  20,   60),
  ('vendor_downtime',          null, true,  30,   60),
  ('rider_shortage',           null, true,  2.0,  null),
  ('delivery_failed',          null, true,  null, null),
  ('settlement_delayed',       null, true,  null, null),
  ('rider_payout_issue',       null, true,  null, null),
  ('marketing_request_new',    null, true,  null, null),
  ('complaint_high_priority',  null, true,  30,   null),
  ('cash_discrepancy',         null, true,  500,  720),
  ('incident',                 null, true,  null, null),
  ('rider_inactive',           null, true,  5,    null),
  ('fraud_suspected',          null, false, null, null),
  ('sla_breach',               null, false, null, null)
on conflict (kind, zone_id) do nothing;

-- 3. Alerts and their history ---------------------------------------------------------------
create table if not exists public.ops_alerts (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (public._ops_alert_unit(kind) is not null),
  severity        text not null check (severity in ('info', 'warning', 'critical')),
  status          text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  title           text not null check (char_length(title) between 1 and 200),
  body            text not null check (char_length(body) <= 1000),
  zone_id         uuid references public.delivery_zones (id) on delete set null,
  entity_type     text not null,
  entity_id       text not null,
  dedupe_key      text not null unique,
  opened_at       timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  reopen_count    int not null default 0,
  last_pushed_at  timestamptz,
  acknowledged_by uuid references public.profiles (id) on delete set null,
  acknowledged_at timestamptz,
  resolved_by     uuid references public.profiles (id) on delete set null,
  resolved_at     timestamptz,
  resolution      text
);
create index if not exists ops_alerts_zone_idx on public.ops_alerts (zone_id, status, severity, last_seen_at desc);
create index if not exists ops_alerts_kind_idx on public.ops_alerts (kind, status);

create table if not exists public.ops_alert_events (
  id         bigint generated always as identity primary key,
  alert_id   uuid not null references public.ops_alerts (id) on delete cascade,
  event      text not null check (event in ('opened', 'escalated_severity', 'acknowledged', 'resolved', 'cleared', 'reopened')),
  actor_id   uuid references public.profiles (id) on delete set null,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists ops_alert_events_alert_idx on public.ops_alert_events (alert_id, created_at);

create table if not exists public.ops_alert_runs (
  name         text primary key,
  leased_until timestamptz not null
);

-- 4. RLS ---------------------------------------------------------------------------------------
alter table public.ops_alert_rules  enable row level security;
alter table public.ops_alerts       enable row level security;
alter table public.ops_alert_events enable row level security;
alter table public.ops_alert_runs   enable row level security;

drop policy if exists "ops_alert_rules — staff read" on public.ops_alert_rules;
create policy "ops_alert_rules — staff read" on public.ops_alert_rules for select
  using (public.is_admin() or public.is_manager());

drop policy if exists "ops_alerts — staff read" on public.ops_alerts;
create policy "ops_alerts — staff read" on public.ops_alerts for select
  using (public.is_admin()
         or public.manager_can_see_zone(zone_id)
         or (zone_id is null and kind = 'incident' and public.is_manager()));

drop policy if exists "ops_alert_events — staff read" on public.ops_alert_events;
create policy "ops_alert_events — staff read" on public.ops_alert_events for select
  using (exists (select 1 from public.ops_alerts a where a.id = alert_id
                  and (public.is_admin()
                       or public.manager_can_see_zone(a.zone_id)
                       or (a.zone_id is null and a.kind = 'incident' and public.is_manager()))));

revoke all on public.ops_alert_rules, public.ops_alerts, public.ops_alert_events, public.ops_alert_runs from anon, authenticated;
grant select on public.ops_alert_rules, public.ops_alerts, public.ops_alert_events to authenticated;
-- The server writes only through the functions below.
revoke insert, update, delete, truncate on public.ops_alert_rules, public.ops_alerts, public.ops_alert_events, public.ops_alert_runs
  from service_role;
grant select on public.ops_alert_rules, public.ops_alerts, public.ops_alert_events, public.ops_alert_runs to service_role;

-- 5. Lease ----------------------------------------------------------------------------------------
create or replace function public.ops_claim_alert_run(p_name text, p_seconds int)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  won boolean;
begin
  insert into public.ops_alert_runs (name, leased_until)
  values (p_name, now() + make_interval(secs => greatest(1, p_seconds)))
  on conflict (name) do update
     set leased_until = excluded.leased_until
   where ops_alert_runs.leased_until <= now()
  returning true into won;
  return coalesce(won, false);
end;
$$;

-- 6. Raise, clear, mark pushed (the engine; no actor) ----------------------------------------------
create or replace function public.ops_raise_alert(
  p_kind text, p_severity text, p_title text, p_body text, p_zone uuid,
  p_entity_type text, p_entity_id text, p_dedupe_key text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a        record;
  new_id   uuid;
  do_push  boolean := false;
begin
  if public._ops_alert_unit(p_kind) is null then
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if p_severity not in ('info', 'warning', 'critical') then
    raise exception 'bad_request' using errcode = '22023';
  end if;

  select * into a from public.ops_alerts where dedupe_key = p_dedupe_key for update;
  if a.id is null then
    insert into public.ops_alerts (kind, severity, title, body, zone_id, entity_type, entity_id, dedupe_key)
    values (p_kind, p_severity, left(p_title, 200), left(coalesce(p_body, ''), 1000), p_zone, p_entity_type, p_entity_id, p_dedupe_key)
    on conflict (dedupe_key) do nothing
    returning id into new_id;
    if new_id is null then
      -- Another evaluation inserted it a moment ago: treat as seen.
      select id into new_id from public.ops_alerts where dedupe_key = p_dedupe_key;
      return jsonb_build_object('id', new_id, 'push', false);
    end if;
    insert into public.ops_alert_events (alert_id, event) values (new_id, 'opened');
    return jsonb_build_object('id', new_id, 'push', true);
  end if;

  if a.status = 'resolved' then
    do_push := a.last_pushed_at is null or a.last_pushed_at < now() - interval '15 minutes';
    update public.ops_alerts
       set status = 'open', severity = p_severity, title = left(p_title, 200), body = left(coalesce(p_body, ''), 1000),
           zone_id = p_zone, last_seen_at = now(), reopen_count = reopen_count + 1,
           acknowledged_by = null, acknowledged_at = null, resolved_by = null, resolved_at = null, resolution = null
     where id = a.id;
    insert into public.ops_alert_events (alert_id, event) values (a.id, 'reopened');
    return jsonb_build_object('id', a.id, 'push', do_push);
  end if;

  if public._ops_severity_rank(p_severity) > public._ops_severity_rank(a.severity) then
    insert into public.ops_alert_events (alert_id, event, note) values (a.id, 'escalated_severity', a.severity || ' → ' || p_severity);
    do_push := p_severity = 'critical';
  end if;
  update public.ops_alerts
     set severity = case when public._ops_severity_rank(p_severity) > public._ops_severity_rank(severity) then p_severity else severity end,
         title = left(p_title, 200), body = left(coalesce(p_body, ''), 1000), last_seen_at = now()
   where id = a.id;
  return jsonb_build_object('id', a.id, 'push', do_push);
end;
$$;

create or replace function public.ops_clear_alerts(p_kind text, p_keep_keys text[])
returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  with cleared as (
    update public.ops_alerts
       set status = 'resolved', resolved_at = now(), resolved_by = null, resolution = 'cleared'
     where kind = p_kind and status in ('open', 'acknowledged')
       and not (dedupe_key = any (coalesce(p_keep_keys, '{}')))
    returning id
  ), ev as (
    insert into public.ops_alert_events (alert_id, event) select id, 'cleared' from cleared returning 1
  )
  select count(*) into n from ev;
  return n;
end;
$$;

create or replace function public.ops_mark_alert_pushed(p_id uuid)
returns void
language sql security definer set search_path = public as $$
  update public.ops_alerts set last_pushed_at = now() where id = p_id;
$$;

-- 7. Staff actions (audited) --------------------------------------------------------------------------
-- A platform-wide alert (zone null) may be acted on by an admin, and — for an
-- incident only — by any manager; otherwise the zone rule of ops_require_staff.
create or replace function public._ops_alert_staff(p_actor uuid, p_zone uuid, p_kind text)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  role_name text;
begin
  if p_zone is null and p_kind = 'incident' then
    if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    select p.role::text into role_name from public.profiles p where p.id = p_actor;
    if role_name in ('admin', 'manager') then
      return role_name;
    end if;
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return public.ops_require_staff(p_actor, p_zone);
end;
$$;

create or replace function public.ops_ack_alert(p_actor uuid, p_alert uuid, p_client_action_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a record;
begin
  select * into a from public.ops_alerts where id = p_alert for update;
  if a.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public._ops_alert_staff(p_actor, a.zone_id, a.kind);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['alert.acknowledge'], p_alert::text);
    return jsonb_build_object('id', p_alert, 'replayed', true);
  end if;
  if a.status = 'resolved' then
    raise exception 'already_resolved' using errcode = '22023';
  end if;
  update public.ops_alerts
     set status = 'acknowledged', acknowledged_by = p_actor, acknowledged_at = now()
   where id = p_alert;
  insert into public.ops_alert_events (alert_id, event, actor_id) values (p_alert, 'acknowledged', p_actor);
  perform public._ops_log(p_actor, 'alert.acknowledge', 'alert', p_alert::text, a.zone_id, null,
    jsonb_build_object('status', a.status), jsonb_build_object('status', 'acknowledged', 'kind', a.kind), p_client_action_id);
  return jsonb_build_object('id', p_alert, 'replayed', false);
end;
$$;

create or replace function public.ops_resolve_alert(p_actor uuid, p_alert uuid, p_note text, p_client_action_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a      record;
  v_note constant text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into a from public.ops_alerts where id = p_alert for update;
  if a.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public._ops_alert_staff(p_actor, a.zone_id, a.kind);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['alert.resolve'], p_alert::text);
    return jsonb_build_object('id', p_alert, 'replayed', true);
  end if;
  if a.status = 'resolved' then
    raise exception 'already_resolved' using errcode = '22023';
  end if;
  if v_note is null or char_length(v_note) < 3 or char_length(v_note) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  update public.ops_alerts
     set status = 'resolved', resolved_by = p_actor, resolved_at = now(), resolution = v_note
   where id = p_alert;
  insert into public.ops_alert_events (alert_id, event, actor_id, note) values (p_alert, 'resolved', p_actor, v_note);
  perform public._ops_log(p_actor, 'alert.resolve', 'alert', p_alert::text, a.zone_id, v_note,
    jsonb_build_object('status', a.status), jsonb_build_object('status', 'resolved', 'kind', a.kind), p_client_action_id);
  return jsonb_build_object('id', p_alert, 'replayed', false);
end;
$$;

create or replace function public.ops_raise_incident(
  p_actor uuid, p_zone uuid, p_title text, p_body text, p_severity text, p_client_action_id text
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_title constant text := nullif(trim(coalesce(p_title, '')), '');
  v_body  constant text := nullif(trim(coalesce(p_body, '')), '');
  ref     uuid;
  new_id  uuid;
begin
  perform public.ops_require_staff(p_actor, p_zone);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['alert.incident'], null);
    select entity_id::uuid into new_id from public.ops_audit_log where client_action_id = p_client_action_id;
    return new_id;
  end if;
  if v_title is null or char_length(v_title) < 3 or char_length(v_title) > 120
     or v_body is null or char_length(v_body) < 3 or char_length(v_body) > 1000 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_severity not in ('warning', 'critical') then
    raise exception 'bad_request' using errcode = '22023';
  end if;
  ref := gen_random_uuid();
  insert into public.ops_alerts (kind, severity, title, body, zone_id, entity_type, entity_id, dedupe_key, last_pushed_at)
  values ('incident', p_severity, v_title, v_body, p_zone, 'incident', 'manual:' || ref, 'incident:manual:' || ref, null)
  returning id into new_id;
  insert into public.ops_alert_events (alert_id, event, actor_id, note) values (new_id, 'opened', p_actor, 'Raised by staff');
  perform public._ops_log(p_actor, 'alert.incident', 'alert', new_id::text, p_zone, v_title, null,
    jsonb_build_object('title', v_title, 'severity', p_severity), p_client_action_id);
  return new_id;
end;
$$;

create or replace function public.ops_set_alert_rule(
  p_actor uuid, p_kind text, p_zone uuid, p_enabled boolean, p_threshold numeric, p_window int, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  unit       constant text := public._ops_alert_unit(p_kind);
  role_name  text;
  prior      record;
begin
  if unit is null then
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if p_zone is null then
    if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    select p.role::text into role_name from public.profiles p where p.id = p_actor;
    if role_name is distinct from 'admin' then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  else
    perform public.ops_require_staff(p_actor, p_zone);
  end if;
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['alert_rule.set'], p_kind);
    return jsonb_build_object('kind', p_kind, 'replayed', true);
  end if;
  if (unit = 'none' and p_threshold is not null)
     or (unit = 'minutes' and (p_threshold is null or p_threshold < 1 or p_threshold > 1440))
     or (unit = 'percent' and (p_threshold is null or p_threshold < 1 or p_threshold > 100))
     or (unit = 'ratio' and (p_threshold is null or p_threshold < 0.5 or p_threshold > 20))
     or (unit = 'rupees' and (p_threshold is null or p_threshold < 50 or p_threshold > 100000))
     or (p_window is not null and (p_window < 5 or p_window > 1440)) then
    raise exception 'bad_threshold' using errcode = '22023';
  end if;

  -- The effective rule before the change (the zone's own, else the default).
  select r.enabled, r.threshold, r.window_minutes into prior
    from public.ops_alert_rules r
   where r.kind = p_kind and (r.zone_id = p_zone or r.zone_id is null)
   order by (r.zone_id is null) limit 1;

  insert into public.ops_alert_rules (kind, zone_id, enabled, threshold, window_minutes, updated_by, updated_at)
  values (p_kind, p_zone, coalesce(p_enabled, true), p_threshold, p_window, p_actor, now())
  on conflict (kind, zone_id) do update
     set enabled = excluded.enabled, threshold = excluded.threshold, window_minutes = excluded.window_minutes,
         updated_by = excluded.updated_by, updated_at = now();

  perform public._ops_log(p_actor, 'alert_rule.set', 'alert_rule', p_kind, p_zone, null,
    jsonb_build_object('enabled', prior.enabled, 'threshold', prior.threshold, 'windowMinutes', prior.window_minutes),
    jsonb_build_object('enabled', coalesce(p_enabled, true), 'threshold', p_threshold, 'windowMinutes', p_window),
    p_client_action_id);
  return jsonb_build_object('kind', p_kind, 'replayed', false);
end;
$$;

create or replace function public.ops_reset_alert_rule(p_actor uuid, p_kind text, p_zone uuid, p_client_action_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  prior record;
begin
  if p_zone is null then
    -- The platform default is changed, never deleted.
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, p_zone);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['alert_rule.reset'], p_kind);
    return jsonb_build_object('kind', p_kind, 'replayed', true);
  end if;
  delete from public.ops_alert_rules where kind = p_kind and zone_id = p_zone
  returning enabled, threshold, window_minutes into prior;
  perform public._ops_log(p_actor, 'alert_rule.reset', 'alert_rule', p_kind, p_zone, null,
    case when prior is null then null
         else jsonb_build_object('enabled', prior.enabled, 'threshold', prior.threshold, 'windowMinutes', prior.window_minutes) end,
    null, p_client_action_id);
  return jsonb_build_object('kind', p_kind, 'replayed', false);
end;
$$;

-- 8. Grants -----------------------------------------------------------------------------------------
revoke execute on function public._ops_alert_unit(text) from public, anon, authenticated;
revoke execute on function public._ops_severity_rank(text) from public, anon, authenticated;
revoke execute on function public._ops_alert_staff(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.ops_claim_alert_run(text, int) from public, anon, authenticated;
revoke execute on function public.ops_raise_alert(text, text, text, text, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_clear_alerts(text, text[]) from public, anon, authenticated;
revoke execute on function public.ops_mark_alert_pushed(uuid) from public, anon, authenticated;
revoke execute on function public.ops_ack_alert(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.ops_resolve_alert(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ops_raise_incident(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_set_alert_rule(uuid, text, uuid, boolean, numeric, int, text) from public, anon, authenticated;
revoke execute on function public.ops_reset_alert_rule(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public._ops_alert_unit(text) to service_role;
grant execute on function public.ops_claim_alert_run(text, int) to service_role;
grant execute on function public.ops_raise_alert(text, text, text, text, uuid, text, text, text) to service_role;
grant execute on function public.ops_clear_alerts(text, text[]) to service_role;
grant execute on function public.ops_mark_alert_pushed(uuid) to service_role;
grant execute on function public.ops_ack_alert(uuid, uuid, text) to service_role;
grant execute on function public.ops_resolve_alert(uuid, uuid, text, text) to service_role;
grant execute on function public.ops_raise_incident(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.ops_set_alert_rule(uuid, text, uuid, boolean, numeric, int, text) to service_role;
grant execute on function public.ops_reset_alert_rule(uuid, text, uuid, text) to service_role;

commit;
