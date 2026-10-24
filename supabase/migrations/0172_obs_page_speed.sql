-- ============================================================
-- 0172 — Observability v2, phase 5: page speed for real people
--        (docs/OBSERVABILITY_V2.md)
-- ------------------------------------------------------------
-- obs_page_timings: one row per page visit, measured in the visitor's browser.
--   kind 'first' — a full page load: visitor_ms = largest contentful paint
--                  (or the load event); server_ms = time to the first byte,
--                  NULL when the browser answered from its own cache (Back
--                  button, restored tab), never 0, or "our server" would look
--                  faster than it is.
--   kind 'move'  — moving to another page inside the app: visitor_ms = click
--                  to the next paint; server_ms = the router's data request.
-- No person and no query string is stored: the page is a pattern
-- (/orders/[id]), the door is which part of the app it is, the device is
-- phone or computer. Kept 7 days.
--
-- obs_page_speed() answers per page: visits, typical (median) and slowest 1 in
-- 10 (90th percentile), for the visitor and for the server separately.
--
-- Additive. Rollback:
--   drop function if exists public.obs_page_speed(timestamptz,text,text,text,int);
--   drop function if exists public.obs_record_timings(text,jsonb);
--   drop table if exists public.obs_page_timings;
-- ============================================================

begin;

create table if not exists public.obs_page_timings (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  env         text        not null,
  page        text        not null,
  door        text        not null,
  device      text        not null check (device in ('phone','computer')),
  kind        text        not null check (kind in ('first','move')),
  visitor_ms  integer     not null check (visitor_ms >= 0 and visitor_ms <= 120000),
  server_ms   integer              check (server_ms is null or (server_ms >= 0 and server_ms <= 120000)),
  release     text
);

create index if not exists obs_page_timings_time_idx on public.obs_page_timings (env, occurred_at desc);
create index if not exists obs_page_timings_page_idx on public.obs_page_timings (env, page, occurred_at desc);

alter table public.obs_page_timings enable row level security;
alter table public.obs_page_timings force row level security;
revoke all on public.obs_page_timings from anon, authenticated;
grant select, insert, update, delete on public.obs_page_timings to service_role;

-- A batch from one browser. Rows that are not plausible are skipped, not stored.
create or replace function public.obs_record_timings(p_env text, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r       jsonb;
  v_n     int := 0;
  v_vis   int;
  v_srv   int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return 0;
  end if;
  for r in select * from jsonb_array_elements(p_rows) limit 50 loop
    begin
      v_vis := (r ->> 'visitor_ms')::int;
      v_srv := nullif(r ->> 'server_ms', '')::int;
      if v_vis is null or v_vis < 0 or v_vis > 120000 then continue; end if;
      if v_srv is not null and (v_srv < 0 or v_srv > 120000) then v_srv := null; end if;
      insert into public.obs_page_timings (env, page, door, device, kind, visitor_ms, server_ms, release)
      values (coalesce(p_env, 'production'), left(r ->> 'page', 120), left(r ->> 'door', 20),
              r ->> 'device', r ->> 'kind', v_vis, v_srv, left(r ->> 'release', 12));
      v_n := v_n + 1;
    exception when others then
      null; -- one bad row costs that row only
    end;
  end loop;

  if random() < 0.01 then
    delete from public.obs_page_timings where occurred_at < now() - interval '7 days';
  end if;
  return v_n;
end;
$$;

create or replace function public.obs_page_speed(
  p_since timestamptz, p_env text default 'production',
  p_door text default null, p_device text default null, p_min_visits int default 3
)
returns table (
  page text, visits bigint,
  visitor_p50 int, visitor_p90 int,
  server_p50 int, server_p90 int
)
language sql
stable
security definer
set search_path = public
as $$
  select t.page,
         count(*)::bigint as visits,
         round(percentile_cont(0.5) within group (order by t.visitor_ms))::int,
         round(percentile_cont(0.9) within group (order by t.visitor_ms))::int,
         round(percentile_cont(0.5) within group (order by t.server_ms))::int,
         round(percentile_cont(0.9) within group (order by t.server_ms))::int
    from public.obs_page_timings t
   where t.env = coalesce(p_env, 'production')
     and t.occurred_at >= p_since
     and (p_door is null or t.door = p_door)
     and (p_device is null or t.device = p_device)
   group by t.page
  having count(*) >= greatest(1, p_min_visits)
   order by 4 desc nulls last
   limit 100;
$$;

revoke all on function public.obs_record_timings(text,jsonb) from public, anon, authenticated;
revoke all on function public.obs_page_speed(timestamptz,text,text,text,int) from public, anon, authenticated;
grant execute on function public.obs_record_timings(text,jsonb) to service_role;
grant execute on function public.obs_page_speed(timestamptz,text,text,text,int) to service_role;

commit;
