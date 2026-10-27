-- 0178 — Weather notices per delivery zone.
--
-- Spec: docs/superpowers/specs/2026-10-27-weather-notice-design.md
--
-- Each zone has an automatic reading (the server checks Open-Meteo for the
-- zone's centre) and an optional manual override a manager or admin sets for a
-- few hours. The level adds minutes to delivery times and is shown to
-- customers and riders.
--
-- Rollback:
--   drop function if exists public.shop_weather_minutes();
--   drop function if exists public.zone_weather_now();
--   drop function if exists public.ops_set_zone_weather(uuid, uuid, text, integer, text, text);
--   drop function if exists public.set_zone_weather_auto(uuid, text, text);
--   drop function if exists public.zone_weather_mark_notified(uuid, text);
--   drop function if exists public.weather_extra_minutes(text);
--   drop function if exists public._zone_weather_level(public.zone_weather);
--   drop table if exists public.zone_weather;

begin;

create table if not exists public.zone_weather (
  zone_id         uuid primary key references public.delivery_zones (id) on delete cascade,
  auto_level      text not null default 'clear',
  auto_detail     text,
  auto_checked_at timestamptz,
  manual_level    text,
  manual_until    timestamptz,
  manual_note     text check (manual_note is null or char_length(manual_note) <= 200),
  manual_by       uuid references public.profiles (id) on delete set null,
  -- The level riders were last told about, so a rise is pushed once.
  notified_level  text not null default 'clear',
  updated_at      timestamptz not null default now(),
  check (auto_level in ('clear', 'rain', 'heavy_rain', 'storm', 'heat')),
  check (manual_level is null or manual_level in ('clear', 'rain', 'heavy_rain', 'storm', 'heat')),
  check (notified_level in ('clear', 'rain', 'heavy_rain', 'storm', 'heat')),
  check ((manual_level is null) = (manual_until is null))
);
alter table public.zone_weather enable row level security;
revoke all on public.zone_weather from anon, authenticated;
grant select, insert, update on public.zone_weather to service_role;

-- The customer app reads restaurants as a guest too; the zone id says nothing private.
grant select (zone_id) on public.restaurants to anon;

create or replace function public.weather_extra_minutes(p_level text)
returns integer
language sql immutable set search_path = public as $$
  select case p_level when 'rain' then 10 when 'heavy_rain' then 20 when 'storm' then 30 when 'heat' then 5 else 0 end;
$$;

-- Manual while it lasts; otherwise the automatic reading, if it is under 3 hours old.
create or replace function public._zone_weather_level(w public.zone_weather)
returns text
language sql stable set search_path = public as $$
  select case
    when w.manual_level is not null and w.manual_until > now() then w.manual_level
    when w.auto_checked_at > now() - interval '3 hours' then w.auto_level
    else 'clear'
  end;
$$;

-- Every zone with weather right now, for the apps and the site (no private fields).
create or replace function public.zone_weather_now()
returns table (zone_id uuid, zone_name text, level text, extra_minutes integer, source text, until timestamptz)
language sql stable security definer set search_path = public as $$
  select z.id, z.name, l.level, public.weather_extra_minutes(l.level),
         case when w.manual_level is not null and w.manual_until > now() then 'manual' else 'auto' end,
         case when w.manual_level is not null and w.manual_until > now() then w.manual_until end
    from public.zone_weather w
    join public.delivery_zones z on z.id = w.zone_id and z.is_active
    cross join lateral (select public._zone_weather_level(w) as level) l
   where l.level <> 'clear';
$$;
revoke execute on function public.zone_weather_now() from public;
grant execute on function public.zone_weather_now() to anon, authenticated, service_role;

-- Shops in a zone with weather now, and the minutes it adds (the customer
-- app's restaurant cards; empty while every zone is clear).
create or replace function public.shop_weather_minutes()
returns table (restaurant_id uuid, extra_minutes integer)
language sql stable security definer set search_path = public as $$
  select r.id, w.extra_minutes
    from public.zone_weather_now() w
    join public.restaurants r on r.zone_id = w.zone_id and r.approved;
$$;
revoke execute on function public.shop_weather_minutes() from public;
grant execute on function public.shop_weather_minutes() to anon, authenticated, service_role;

-- The server's automatic reading (service role only).
create or replace function public.set_zone_weather_auto(p_zone uuid, p_level text, p_detail text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_level not in ('clear', 'rain', 'heavy_rain', 'storm', 'heat') then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  insert into public.zone_weather (zone_id, auto_level, auto_detail, auto_checked_at, updated_at)
  values (p_zone, p_level, left(p_detail, 200), now(), now())
  on conflict (zone_id) do update
    set auto_level = excluded.auto_level, auto_detail = excluded.auto_detail,
        auto_checked_at = excluded.auto_checked_at, updated_at = now();
end;
$$;
revoke execute on function public.set_zone_weather_auto(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_zone_weather_auto(uuid, text, text) to service_role;

-- Riders were told about this level (service role only). Answers whether this
-- call moved it up, so two servers racing push once.
create or replace function public.zone_weather_mark_notified(p_zone uuid, p_level text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  moved integer;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.zone_weather set notified_level = p_level
   where zone_id = p_zone and notified_level is distinct from p_level;
  get diagnostics moved = row_count;
  return moved > 0;
end;
$$;
revoke execute on function public.zone_weather_mark_notified(uuid, text) from public, anon, authenticated;
grant execute on function public.zone_weather_mark_notified(uuid, text) to service_role;

-- A manager in the zone, or an admin: set a level for p_hours (1–12), or
-- p_level 'auto' to go back to the automatic reading.
create or replace function public.ops_set_zone_weather(
  p_actor uuid, p_zone uuid, p_level text, p_hours integer, p_note text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  w      public.zone_weather%rowtype;
  note   constant text := nullif(btrim(coalesce(p_note, '')), '');
  before text;
begin
  if not exists (select 1 from public.delivery_zones z where z.id = p_zone) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, p_zone);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('zone_id', p_zone);
  end if;
  if p_level is null or p_level not in ('auto', 'clear', 'rain', 'heavy_rain', 'storm', 'heat')
     or (p_level <> 'auto' and (p_hours is null or p_hours < 1 or p_hours > 12))
     or (note is not null and char_length(note) > 200) then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  insert into public.zone_weather (zone_id) values (p_zone) on conflict (zone_id) do nothing;
  select * into w from public.zone_weather where zone_id = p_zone for update;
  before := public._zone_weather_level(w);
  if p_level = 'auto' then
    update public.zone_weather
       set manual_level = null, manual_until = null, manual_note = null, manual_by = p_actor, updated_at = now()
     where zone_id = p_zone;
  else
    update public.zone_weather
       set manual_level = p_level, manual_until = now() + make_interval(hours => p_hours), manual_note = note,
           manual_by = p_actor, updated_at = now()
     where zone_id = p_zone;
  end if;
  perform public._ops_log(p_actor, 'zone.weather', 'zone', p_zone::text, p_zone, note,
                          jsonb_build_object('level', before),
                          jsonb_build_object('level', p_level, 'hours', case when p_level = 'auto' then null else p_hours end),
                          p_client_action_id);
  return jsonb_build_object('zone_id', p_zone, 'level', p_level);
end;
$$;
revoke execute on function public.ops_set_zone_weather(uuid, uuid, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.ops_set_zone_weather(uuid, uuid, text, integer, text, text) to service_role;

commit;
