-- ============================================================
-- 0169 — Observability v2, phase 1: people per issue, and an ingest that a
--        bad row cannot break (docs/OBSERVABILITY_V2.md)
-- ------------------------------------------------------------
-- 1. obs_issue_people: who each issue hit and how often, kept in the same
--    atomic obs_ingest call that counts the issue, so "500 times to one
--    person" and "once each to 500 people" can finally be told apart.
--    obs_issues.users_affected is the count of real (signed-in) people;
--    signed-out occurrences are kept under one 'anonymous' row.
-- 2. obs_ingest no longer aborts the whole batch on one malformed row (a bad
--    uuid, a CHECK failure): the row is skipped and counted in obs_job_runs
--    ('ingest_rejects').
-- 3. The daily cap reads a per-day counter (obs_ingest_daily) instead of a
--    count(*) over the day's events, which got slower every hour.
--
-- Additive and safe to run before the app: the new columns default to 0 and
-- the function keeps its signature. Rollback:
--   drop table if exists public.obs_issue_people;
--   drop table if exists public.obs_ingest_daily;
--   alter table public.obs_issues drop column if exists users_affected;
--   (and re-run obs_ingest from 0046)
-- ============================================================

begin;

alter table public.obs_issues
  add column if not exists users_affected integer not null default 0;

comment on column public.obs_issues.users_affected is
  'Distinct signed-in people this issue hit since it was first seen (0169). Signed-out occurrences are counted under obs_issue_people.person_key = ''anonymous'' and not here.';

create table if not exists public.obs_issue_people (
  fingerprint  text        not null references public.obs_issues(fingerprint) on delete cascade,
  -- The profile id as text, or 'anonymous'.
  person_key   text        not null,
  actor_id     uuid,
  actor_role   text,
  occurrences  bigint      not null default 0,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  primary key (fingerprint, person_key)
);

create index if not exists obs_issue_people_actor_idx
  on public.obs_issue_people (actor_id, last_seen desc) where actor_id is not null;

create table if not exists public.obs_ingest_daily (
  env    text   not null,
  day    date   not null,
  events bigint not null default 0,
  primary key (env, day)
);

-- Same locks as every obs_* table (0046): RLS on with no policies, nothing for
-- anon/authenticated, the service role only.
do $$
declare t text;
begin
  foreach t in array array['obs_issue_people', 'obs_ingest_daily'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

create or replace function public.obs_ingest(p_events jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stored   int := 0;
  v_rejected int := 0;
  v_shed     int := 0;
  e          jsonb;
  v_env      text;
  v_today    bigint;
  v_cap      bigint := 500000;   -- per environment, per day
  v_level    text;
  v_fp       text;
  v_id       bigint;
  v_short    text;
  v_at       timestamptz;
  v_actor    uuid;
  v_person   text;
  v_new      boolean;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return 0;
  end if;

  v_env := coalesce(p_events -> 0 ->> 'env', 'production');

  -- Daily cap from a counter row, not a count(*) over the day. Past the cap,
  -- debug/info/http are shed and errors are kept (see 0046 for why).
  select events into v_today
    from public.obs_ingest_daily
   where env = v_env and day = current_date;
  v_today := coalesce(v_today, 0);

  for e in select * from jsonb_array_elements(p_events) loop
    v_level := coalesce(e ->> 'level', 'info');

    if v_today >= v_cap and v_level not in ('error','fatal') then
      v_shed := v_shed + 1;
      continue;
    end if;

    -- One malformed row (a bad uuid, a CHECK the app did not anticipate) must
    -- cost that row, not the batch it arrived in.
    begin
      v_at    := coalesce((e ->> 'occurred_at')::timestamptz, now());
      v_actor := nullif(e ->> 'actor_id', '')::uuid;

      insert into public.obs_events (
        occurred_at, env, release, kind, level, source, message,
        trace_id, request_id, span_id, parent_span_id, duration_ms,
        http_method, http_route, http_status, provider,
        error_type, error_fingerprint, stack,
        actor_role, actor_id, order_id, restaurant_id, driver_id, attrs
      ) values (
        v_at,
        coalesce(e ->> 'env', 'production'),
        e ->> 'release',
        coalesce(e ->> 'kind', 'log'),
        v_level,
        coalesce(e ->> 'source', 'unknown'),
        left(coalesce(e ->> 'message', '(no message)'), 2000),
        e ->> 'trace_id',
        e ->> 'request_id',
        e ->> 'span_id',
        e ->> 'parent_span_id',
        nullif(e ->> 'duration_ms', '')::integer,
        e ->> 'http_method',
        e ->> 'http_route',
        nullif(e ->> 'http_status', '')::smallint,
        e ->> 'provider',
        e ->> 'error_type',
        e ->> 'error_fingerprint',
        left(e ->> 'stack', 8000),
        e ->> 'actor_role',
        v_actor,
        nullif(e ->> 'order_id', '')::uuid,
        nullif(e ->> 'restaurant_id', '')::uuid,
        nullif(e ->> 'driver_id', '')::uuid,
        coalesce(e -> 'attrs', '{}'::jsonb)
      )
      returning id into v_id;

      -- ---------- group it ----------
      v_fp := e ->> 'error_fingerprint';
      if v_fp is not null and v_level in ('warn','error','fatal') then
        v_short := 'DEL-' || nextval('public.obs_issue_seq')::text;

        insert into public.obs_issues (
          fingerprint, short_id, title, culprit, kind, level, env,
          severity, first_seen, last_seen, occurrences,
          release_first_seen, release_last_seen, sample_event_id, sample_trace_id
        ) values (
          v_fp, v_short,
          left(coalesce(e ->> 'title', e ->> 'message', 'Unknown error'), 300),
          e ->> 'culprit',
          coalesce(e ->> 'kind', 'error'),
          v_level,
          coalesce(e ->> 'env', 'production'),
          coalesce(e ->> 'severity', 'medium'),
          v_at, v_at, 1,
          e ->> 'release', e ->> 'release', v_id, e ->> 'trace_id'
        )
        on conflict (fingerprint) do update set
          last_seen         = greatest(public.obs_issues.last_seen, excluded.last_seen),
          occurrences       = public.obs_issues.occurrences + 1,
          release_last_seen = coalesce(excluded.release_last_seen, public.obs_issues.release_last_seen),
          sample_event_id   = excluded.sample_event_id,
          sample_trace_id   = coalesce(excluded.sample_trace_id, public.obs_issues.sample_trace_id),
          culprit           = coalesce(excluded.culprit, public.obs_issues.culprit),
          severity          = case
                                when public.obs_issues.severity_source = 'manual'
                                  then public.obs_issues.severity
                                else excluded.severity
                              end,
          status            = case
                                when public.obs_issues.status = 'resolved' then 'regressed'
                                else public.obs_issues.status
                              end,
          updated_at        = now();

        -- ---------- who it hit ----------
        v_person := coalesce(v_actor::text, 'anonymous');
        insert into public.obs_issue_people as p (
          fingerprint, person_key, actor_id, actor_role, occurrences, first_seen, last_seen
        ) values (
          v_fp, v_person, v_actor, e ->> 'actor_role', 1, v_at, v_at
        )
        on conflict (fingerprint, person_key) do update set
          occurrences = p.occurrences + 1,
          last_seen   = greatest(p.last_seen, excluded.last_seen),
          actor_role  = coalesce(excluded.actor_role, p.actor_role)
        returning (xmax = 0) into v_new;

        if v_new and v_actor is not null then
          update public.obs_issues
             set users_affected = users_affected + 1
           where fingerprint = v_fp;
        end if;
      end if;

      v_stored := v_stored + 1;
      v_today  := v_today + 1;
    exception when others then
      v_rejected := v_rejected + 1;
    end;
  end loop;

  if v_stored > 0 then
    insert into public.obs_ingest_daily (env, day, events)
    values (v_env, current_date, v_stored)
    on conflict (env, day) do update set events = public.obs_ingest_daily.events + excluded.events;
  end if;

  if v_shed > 0 then
    insert into public.obs_job_runs (job, last_run_at, last_error, runs, failures)
    values ('ingest_cap', now(),
            format('daily cap %s reached for env=%s; %s low-level events shed', v_cap, v_env, v_shed), 1, 1)
    on conflict (job) do update
      set last_run_at = now(),
          last_error  = excluded.last_error,
          failures    = public.obs_job_runs.failures + 1;
  end if;

  if v_rejected > 0 then
    insert into public.obs_job_runs (job, last_run_at, last_error, runs, failures)
    values ('ingest_rejects', now(),
            format('%s malformed telemetry rows skipped for env=%s', v_rejected, v_env), 1, 1)
    on conflict (job) do update
      set last_run_at = now(),
          last_error  = excluded.last_error,
          failures    = public.obs_job_runs.failures + 1;
  end if;

  return v_stored;
end;
$$;

comment on function public.obs_ingest(jsonb) is
  'Store a batch of already-redacted telemetry, upsert its issue groups and the people each issue hit, in one round trip (0169). A malformed row is skipped, not the batch. Called from src/lib/obs/emit.ts inside after(), with the service role.';

revoke all on function public.obs_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.obs_ingest(jsonb) to service_role;

commit;
