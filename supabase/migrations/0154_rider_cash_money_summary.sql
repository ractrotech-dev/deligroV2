-- 0154 — A rider's cash position and money summary, summed in SQL.
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0154.mjs); run it on staging first.
-- Depends on 0047 (cod_handovers), 0150 (rider ledger), 0152 (_rider_payout_preview).
-- Plan: docs/superpowers/plans/2026-10-21-manager-app-phase-5-riders.md (S3, rider detail).
--
-- Why: "cash still to deposit" is everything the rider ever collected minus
-- everything they ever handed over (§5.14), and "pending pay" is every unpaid
-- ledger row (§5.13). Both grow for the life of the rider; summing them here
-- keeps the rider detail one bounded call instead of a lifetime of rows.
--
-- Security: service_role only; the routes authorise and scope first.
--
-- Rollback:
--   drop function if exists public.ops_rider_cash_position(uuid, date);
--   drop function if exists public.ops_rider_money_summary(uuid);

begin;

-- p_today is the IST calendar day the "today" figures are for.
create or replace function public.ops_rider_cash_position(p_rider uuid, p_today date)
returns jsonb
language sql stable security definer set search_path = public as $$
  with collected as (
    select coalesce(sum(d.cod_collected_amount), 0)::int as total,
           coalesce(sum(d.cod_collected_amount) filter (
             where (d.cod_collected_at at time zone 'Asia/Kolkata')::date = p_today), 0)::int as today
      from public.deliveries d
     where d.driver_id = p_rider and d.cod_collected_amount is not null
  ), deposited as (
    select coalesce(sum(h.amount), 0)::int as total,
           coalesce(sum(h.amount) filter (where h.handover_date = p_today), 0)::int as today
      from public.cod_handovers h
     where h.leg = 'rider_to_manager' and h.from_user = p_rider
  )
  select jsonb_build_object(
    'collected_today', c.today,
    'deposited_today', d.today,
    'collected_total', c.total,
    'deposited_total', d.total,
    'pending_deposit', greatest(c.total - d.total, 0))
    from collected c, deposited d;
$$;

create or replace function public.ops_rider_money_summary(p_rider uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'pending', public._rider_payout_preview(p_rider, (now() at time zone 'Asia/Kolkata')::date + 36500),
    'paid_total', coalesce((select sum(p.amount) from public.rider_payouts p where p.driver_id = p_rider), 0));
$$;

revoke execute on function public.ops_rider_cash_position(uuid, date) from public, anon, authenticated;
revoke execute on function public.ops_rider_money_summary(uuid) from public, anon, authenticated;
grant execute on function public.ops_rider_cash_position(uuid, date) to service_role;
grant execute on function public.ops_rider_money_summary(uuid) to service_role;

commit;
