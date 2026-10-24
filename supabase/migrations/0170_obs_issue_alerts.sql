-- ============================================================
-- 0170 — Observability v2, phase 4: tell developers when an issue is new or
--        comes back after being fixed (docs/OBSERVABILITY_V2.md)
-- ------------------------------------------------------------
-- A trigger on obs_issues queues one alert per ISSUE, not per event: a loop
-- writing ten thousand rows still alerts once. Queued when:
--   * a new issue appears at error or fatal level, or
--   * an issue turns 'regressed' (it was resolved and happened again).
-- obs_take_alerts() hands the server the production alerts not yet sent and
-- marks them sent in the same statement (skip locked), so two servers flushing
-- at once never send the same alert twice. The server pushes them to every
-- developer (src/lib/obs/issue-alerts.ts); the console lists the last day.
--
-- Additive. Rollback:
--   drop trigger if exists obs_issue_alert on public.obs_issues;
--   drop function if exists public.obs_issue_alert_trg();
--   drop function if exists public.obs_take_alerts(int);
--   drop table if exists public.obs_issue_alerts;
-- ============================================================

begin;

create table if not exists public.obs_issue_alerts (
  id           bigint generated always as identity primary key,
  fingerprint  text        not null,
  short_id     text        not null,
  title        text        not null,
  -- 'new' | 'regressed'
  reason       text        not null check (reason in ('new','regressed')),
  env          text        not null,
  level        text        not null,
  created_at   timestamptz not null default now(),
  notified_at  timestamptz
);

create index if not exists obs_issue_alerts_pending_idx
  on public.obs_issue_alerts (env, id) where notified_at is null;
create index if not exists obs_issue_alerts_recent_idx
  on public.obs_issue_alerts (created_at desc);

alter table public.obs_issue_alerts enable row level security;
alter table public.obs_issue_alerts force row level security;
revoke all on public.obs_issue_alerts from anon, authenticated;
grant select, insert, update, delete on public.obs_issue_alerts to service_role;

create or replace function public.obs_issue_alert_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.level in ('error','fatal') then
      insert into public.obs_issue_alerts (fingerprint, short_id, title, reason, env, level)
      values (new.fingerprint, new.short_id, new.title, 'new', new.env, new.level);
    end if;
  elsif new.status = 'regressed' and old.status is distinct from 'regressed' then
    insert into public.obs_issue_alerts (fingerprint, short_id, title, reason, env, level)
    values (new.fingerprint, new.short_id, new.title, 'regressed', new.env, new.level);
  end if;
  return new;
end;
$$;

drop trigger if exists obs_issue_alert on public.obs_issues;
create trigger obs_issue_alert
  after insert or update of status on public.obs_issues
  for each row execute function public.obs_issue_alert_trg();

create or replace function public.obs_take_alerts(p_limit int default 20)
returns setof public.obs_issue_alerts
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Old alerts are only history; a month is plenty.
  delete from public.obs_issue_alerts where created_at < now() - interval '30 days';

  return query
  update public.obs_issue_alerts a
     set notified_at = now()
   where a.id in (
     select id from public.obs_issue_alerts
      where notified_at is null and env = 'production'
      order by id
      limit greatest(1, least(p_limit, 100))
      for update skip locked
   )
  returning a.*;
end;
$$;

comment on function public.obs_take_alerts(int) is
  'Production issue alerts not yet sent, marked sent in the same statement (0170). Called by src/lib/obs/issue-alerts.ts after an ingest that carried errors.';

revoke all on function public.obs_issue_alert_trg() from public, anon, authenticated;
revoke all on function public.obs_take_alerts(int) from public, anon, authenticated;
grant execute on function public.obs_take_alerts(int) to service_role;

commit;
