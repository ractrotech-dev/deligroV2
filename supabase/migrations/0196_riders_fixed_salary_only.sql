-- ============================================================
-- 0196 — Riders get a fixed salary only: nothing awards incentives or bonuses
-- ------------------------------------------------------------
-- STATUS: APPLIED 2026-11-05 to the Supabase project ending akxv, with 0190-0201 as one transaction.
-- Deploy order: … → 0083 → 0084 → 0194 → 0195 → 0196.
--
-- docs/RULE-BOOK.md, "Money": riders get a fixed salary only, paid outside the app and
-- recorded in it. No incentives, bonuses, targets or extra pay.
--
--   * The award_rider_incentives trigger (0083), the one thing that awarded incentives,
--     is dropped, and so is its function. No cron job ever awarded them.
--   * Every incentive rule is switched off. Rules are never deleted: a rule that
--     paid a rider stays on record (rider_incentive_awards.rule_id is RESTRICT).
--   * A new `bonus` entry on rider_adjustments is refused. Old bonus rows are not
--     touched and can still be paid: a CHECK would refuse the update that attaches
--     them to a payout, so this is an insert trigger.
--
-- Kept on purpose, so old ledger rows and paid history stay readable and correct:
--   rider_incentive_rules, rider_incentive_awards, their rows, and their part in
--   _rider_payout_preview, ops_rider_ledger_totals and the statements. An unpaid old
--   award is still money owed. rider_daily_target and rider_weekly_target (0084) stay
--   as columns nothing reads; dropping them can wait until no old build asks for them.
--
-- Rollback:
--   re-run the award_rider_incentives function and its trigger from 0083, then
--   drop trigger if exists refuse_new_rider_bonus on public.rider_adjustments;
--   drop function if exists public.refuse_new_rider_bonus();
--   and switch back on whichever rules should be on: this migration does not record which were.
-- ============================================================

begin;

drop trigger if exists award_rider_incentives on public.rider_earnings;
drop function if exists public.award_rider_incentives();

update public.rider_incentive_rules set active = false where active;

comment on table public.rider_incentive_rules is
  'Retired by 0196: riders get a fixed salary only. Kept so old awards still name their rule. Nothing reads these to award anything.';
comment on table public.rider_incentive_awards is
  'Retired by 0196: no new rows are written. Old rows stay part of what a rider is owed and of paid history.';
comment on column public.platform_settings.rider_daily_target is
  'Retired by 0196: nothing reads this.';
comment on column public.platform_settings.rider_weekly_target is
  'Retired by 0196: nothing reads this.';

create or replace function public.refuse_new_rider_bonus()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.kind = 'bonus' then
    raise exception 'rider_bonus_retired'
      using errcode = 'check_violation',
            detail = 'Riders get a fixed salary only. Use salary, adjustment or deduction.';
  end if;
  return new;
end;
$$;

drop trigger if exists refuse_new_rider_bonus on public.rider_adjustments;
create trigger refuse_new_rider_bonus
  before insert on public.rider_adjustments
  for each row execute function public.refuse_new_rider_bonus();

commit;
