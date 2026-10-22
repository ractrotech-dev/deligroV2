-- ============================================================
-- 0167 — Vendor availability, for the downtime alert (§14.5)
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL — not applied to any database.
-- Deploy order: 0062 → … → 0141 → 0166 → 0167.
--
-- "A shop closed during its own opening hours for 30 minutes" needs to know
-- when it closed. Nothing recorded that, so:
--   * restaurants.availability_changed_at — stamped by trigger whenever
--     is_open or closed_until changes (whoever writes it). Not granted to
--     anon/authenticated: restaurants is granted by column (0022), so it stays
--     invisible to them. Back-filled with now() for existing shops, so the
--     first alert after deploy waits one threshold.
--   * ops_vendor_downtime_facts(now, window, zones, all) — service role only;
--     for every ACTIVE shop in scope: inside its own hours (0062's rules: not a
--     holiday, not a weekly off, within opening–closing, past midnight
--     allowed; no hours set = never scheduled), closed (switched off or
--     closed for a while), minutes since availability changed, and when the
--     orders it left unaccepted (> 5 min) or cancelled itself in the last day
--     were placed. The alert engine applies the per-zone threshold and window.
--
-- 0062 owns restaurant_status_now(); this repeats its hours rule rather than
-- calling it because that function answers "closed" before it looks at hours.
--
-- Rollback:
--   drop function if exists public.ops_vendor_downtime_facts(timestamptz, int, uuid[], boolean);
--   drop trigger if exists stamp_restaurant_availability on public.restaurants;
--   drop function if exists public.stamp_restaurant_availability();
--   alter table public.restaurants drop column if exists availability_changed_at;
-- ============================================================

begin;

alter table public.restaurants add column if not exists availability_changed_at timestamptz;
update public.restaurants set availability_changed_at = now() where availability_changed_at is null;

create or replace function public.stamp_restaurant_availability()
returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT'
     or new.is_open is distinct from old.is_open
     or new.closed_until is distinct from old.closed_until then
    new.availability_changed_at := now();
  else
    new.availability_changed_at := old.availability_changed_at;
  end if;
  return new;
end;
$$;
revoke execute on function public.stamp_restaurant_availability() from public, anon, authenticated;

drop trigger if exists stamp_restaurant_availability on public.restaurants;
create trigger stamp_restaurant_availability before insert or update on public.restaurants
  for each row execute function public.stamp_restaurant_availability();

create or replace function public.ops_vendor_downtime_facts(
  p_now timestamptz, p_window_minutes int, p_zone_ids uuid[], p_all boolean
)
returns table (
  restaurant_id        uuid,
  name                 text,
  zone_id              uuid,
  scheduled_open       boolean,
  closed               boolean,
  closed_minutes       int,
  troubled_order_times timestamptz[]
)
language sql stable security definer set search_path = public as $$
  with shops as (
    select r.id, r.name, r.zone_id, r.is_open, r.closed_until, r.opening_time, r.closing_time,
           coalesce(r.weekly_off, '{}') as weekly_off, r.availability_changed_at,
           (p_now at time zone 'Asia/Kolkata') as local
      from public.restaurants r
     where r.status::text = 'active'
       and (coalesce(p_all, false) or r.zone_id = any (coalesce(p_zone_ids, '{}')))
  )
  select
    s.id, s.name, s.zone_id,
    (s.opening_time is not null and s.closing_time is not null and s.opening_time <> s.closing_time
      and not exists (select 1 from public.store_holidays h
                       where h.restaurant_id = s.id and s.local::date between h.starts_on and h.ends_on)
      and not (to_char(s.local, 'FMDay') = any (s.weekly_off))
      and case when s.opening_time < s.closing_time
               then s.local::time >= s.opening_time and s.local::time < s.closing_time
               else not (s.local::time < s.opening_time and s.local::time >= s.closing_time) end) as scheduled_open,
    (not s.is_open or (s.closed_until is not null and s.closed_until > p_now)) as closed,
    case when not s.is_open or (s.closed_until is not null and s.closed_until > p_now)
         then floor(extract(epoch from (p_now - s.availability_changed_at)) / 60)::int end as closed_minutes,
    coalesce((
      select array_agg(o.created_at order by o.created_at)
        from public.orders o
       where o.restaurant_id = s.id
         and o.created_at >= p_now - interval '1 day'
         and o.created_at <= p_now
         and ((o.status::text = 'placed' and o.created_at < p_now - interval '5 minutes')
              or (o.status::text = 'cancelled' and o.cancelled_by in ('vendor', 'system')))
    ), '{}') as troubled_order_times
  from shops s;
$$;

revoke execute on function public.ops_vendor_downtime_facts(timestamptz, int, uuid[], boolean) from public, anon, authenticated;
grant execute on function public.ops_vendor_downtime_facts(timestamptz, int, uuid[], boolean) to service_role;

commit;
