-- 0153 — Rider list facts and rider history, in SQL.
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0153.mjs); run it on staging first.
-- Depends on 0081 (delivery_events), 0142 (indexes on deliveries), 0150
-- (rider_ratings, rider_documents), 0064 (support_tickets).
-- Plan: docs/superpowers/plans/2026-10-21-manager-app-phase-5-riders.md (S3).
--
-- Why: the rider list needs per-rider counts (active, delivered today, rating,
-- documents to review, open complaints) and the rider history needs keyset
-- paging on "when it ended", which lives in a different column per outcome.
-- Neither can be expressed as PostgREST filters without reading a rider's
-- whole history into the server; these do it in the database, bounded.
--
-- Security: service_role only (the routes authorise and scope first, AGENTS.md
-- rule 5). Nothing here exposes an address line or a customer id: the history
-- returns the drop AREA only (address ->> 'area').
--
-- Rollback:
--   drop function if exists public.ops_rider_history_totals(uuid, date, date);
--   drop function if exists public.ops_rider_history(uuid, date, date, text, timestamptz, text, int);
--   drop function if exists public._rider_history_rows(uuid);
--   drop function if exists public.ops_rider_list_facts(uuid[], timestamptz);

begin;

create or replace function public.ops_rider_list_facts(p_ids uuid[], p_day_start timestamptz)
returns table (
  driver_id         uuid,
  active_deliveries int,
  delivered_today   int,
  rating_avg        numeric,
  rating_count      int,
  pending_docs      int,
  expiring_docs     int,
  open_complaints   int
)
language sql stable security definer set search_path = public as $$
  select r.id,
    (select count(*)::int from public.deliveries d
      where d.driver_id = r.id and d.status in ('assigned', 'picked_up')),
    (select count(*)::int from public.deliveries d
      where d.driver_id = r.id and d.status = 'delivered' and d.delivered_at >= p_day_start),
    (select round(avg(rr.rating)::numeric, 2) from public.rider_ratings rr where rr.driver_id = r.id),
    (select count(*)::int from public.rider_ratings rr where rr.driver_id = r.id),
    (select count(*)::int from public.rider_documents rd where rd.driver_id = r.id and rd.status = 'pending'),
    (select count(*)::int from public.rider_documents rd
      where rd.driver_id = r.id and rd.status in ('pending', 'verified')
        and rd.expires_on is not null
        and rd.expires_on <= (now() at time zone 'Asia/Kolkata')::date + 30),
    (select count(*)::int from public.support_tickets t
      where t.status in ('open', 'in_progress', 'waiting_on_requester', 'escalated')
        and (t.requester_id = r.id
             or t.order_id in (select d.order_id from public.deliveries d where d.driver_id = r.id)))
  from unnest(p_ids) as r(id);
$$;

-- Every finished job of one rider, one row each: their deliveries that ended
-- (delivered, failed, cancelled — or still open on a cancelled order), plus the
-- jobs taken off them (a `reassigned` event names the rider who lost it).
create or replace function public._rider_history_rows(p_rider uuid)
returns table (
  row_key      text,
  order_id     uuid,
  shop         text,
  drop_area    text,
  outcome      text,
  accepted_at  timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  ended_at     timestamptz,
  distance_km  numeric,
  reason       text,
  cancelled_by text,
  proof        text,
  item_count   int,
  order_value  int
)
language sql stable security definer set search_path = public as $$
  select 'd:' || d.id::text,
         o.id,
         coalesce(s.name, 'Shop'),
         nullif(o.address ->> 'area', ''),
         case when d.status = 'delivered' then 'delivered'
              when d.status::text = 'failed' then 'failed'
              else 'cancelled' end,
         d.assigned_at,
         d.picked_up_at,
         d.delivered_at,
         case when d.status = 'delivered' then coalesce(d.delivered_at, d.assigned_at)
              when d.status::text = 'failed' then coalesce(d.failed_at, d.assigned_at)
              else coalesce(o.cancelled_at, d.assigned_at, o.created_at) end,
         d.distance_km,
         case when d.status::text = 'failed' then d.failure_reason
              when d.status = 'delivered' then null
              else o.cancellation_reason end,
         case when d.status = 'delivered' or d.status::text = 'failed' then null else o.cancelled_by end,
         case when d.status = 'delivered' and d.delivery_method in ('code', 'photo', 'ops_approved', 'staff', 'vendor')
              then d.delivery_method end,
         (select count(*)::int from public.order_items i where i.order_id = o.id),
         coalesce(o.total, 0)::int
    from public.deliveries d
    join public.orders o on o.id = d.order_id
    left join public.restaurants s on s.id = o.restaurant_id
   where d.driver_id = p_rider
     and (d.status in ('delivered', 'cancelled') or d.status::text = 'failed' or o.status = 'cancelled')
  union all
  select 'e:' || e.id::text,
         o.id,
         coalesce(s.name, 'Shop'),
         nullif(o.address ->> 'area', ''),
         'reassigned',
         null::timestamptz,
         null::timestamptz,
         null::timestamptz,
         e.created_at,
         null::numeric,
         e.reason,
         null::text,
         null::text,
         (select count(*)::int from public.order_items i where i.order_id = o.id),
         coalesce(o.total, 0)::int
    from public.delivery_events e
    join public.orders o on o.id = e.order_id
    left join public.restaurants s on s.id = o.restaurant_id
   where e.kind = 'reassigned' and e.driver_id = p_rider;
$$;

create or replace function public.ops_rider_history(
  p_rider uuid, p_from date, p_to date, p_outcome text, p_before_at timestamptz, p_before_key text, p_limit int
)
returns table (
  row_key      text,
  order_id     uuid,
  shop         text,
  drop_area    text,
  outcome      text,
  accepted_at  timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  ended_at     timestamptz,
  distance_km  numeric,
  reason       text,
  cancelled_by text,
  proof        text,
  item_count   int,
  order_value  int
)
language sql stable security definer set search_path = public as $$
  select h.*
    from public._rider_history_rows(p_rider) h
   where (p_from is null or (h.ended_at at time zone 'Asia/Kolkata')::date >= p_from)
     and (p_to   is null or (h.ended_at at time zone 'Asia/Kolkata')::date <= p_to)
     and (p_outcome is null or h.outcome = p_outcome)
     and (p_before_at is null or (h.ended_at, h.row_key) < (p_before_at, p_before_key))
   order by h.ended_at desc, h.row_key desc
   limit least(greatest(coalesce(p_limit, 50), 1), 5000);
$$;

create or replace function public.ops_rider_history_totals(p_rider uuid, p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'delivered',  count(*) filter (where h.outcome = 'delivered'),
    'failed',     count(*) filter (where h.outcome = 'failed'),
    'cancelled',  count(*) filter (where h.outcome = 'cancelled'),
    'reassigned', count(*) filter (where h.outcome = 'reassigned'))
    from public._rider_history_rows(p_rider) h
   where (p_from is null or (h.ended_at at time zone 'Asia/Kolkata')::date >= p_from)
     and (p_to   is null or (h.ended_at at time zone 'Asia/Kolkata')::date <= p_to);
$$;

revoke execute on function public.ops_rider_list_facts(uuid[], timestamptz) from public, anon, authenticated;
revoke execute on function public._rider_history_rows(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.ops_rider_history(uuid, date, date, text, timestamptz, text, int) from public, anon, authenticated;
revoke execute on function public.ops_rider_history_totals(uuid, date, date) from public, anon, authenticated;
grant execute on function public.ops_rider_list_facts(uuid[], timestamptz) to service_role;
grant execute on function public.ops_rider_history(uuid, date, date, text, timestamptz, text, int) to service_role;
grant execute on function public.ops_rider_history_totals(uuid, date, date) to service_role;

commit;
