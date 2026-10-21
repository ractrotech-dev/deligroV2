-- 0151 — Manager riders: account status, zone-scoped reads, and the audited
-- RPCs managers (and admins) use to verify, suspend, take offline, review
-- documents of, onboard and adjust riders (§5.2, §5.3, §5.13).
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0151.mjs); run it on staging first.
-- Depends on 0003 (lock_role), 0081 (rider_status, rider_shifts, rider_profiles),
-- 0141 (staff_zones, _ops_log, manager_can_see_rider), 0142 (ops_require_staff,
-- _ops_replayed, _ops_set_actor, _ops_rider_ineligible, orders.short_code),
-- 0150 (rider ledger, documents, cash, ratings).
-- Plan: docs/superpowers/plans/2026-10-21-manager-app-phase-5-riders.md (S2).
--
-- Security changes (docs/SECURITY_AUDIT.md applies):
--   * profiles.account_status / status_reason / status_changed_by /
--     status_changed_at: readable as profiles already are; writable only by
--     admins and the service role (lock_role() re-declared with them).
--   * rider_can_work(): what stops a suspended or rejected rider working — used
--     by _ops_rider_ineligible (assign / reassign / dispatch SQL) and mirrored
--     in TypeScript (src/lib/dispatch/eligibility.ts riderIneligibility).
--   * New permissive SELECT policies for managers, through the rider's zones
--     (manager_can_see_rider): rider ledger, ratings (customer_id stays
--     ungranted), deposits, disputes, documents, change requests. Never any
--     policy on rider_payout_accounts*.
--   * Every ops_* function is service_role only and re-checks the actor's zone
--     against the rider's zones in the database.
--
-- Rollback:
--   drop function if exists public.ops_set_rider_verification(uuid, uuid, text, text, text, boolean, text);
--   drop function if exists public.ops_set_rider_account(uuid, uuid, text, text, text, text);
--   drop function if exists public.ops_force_rider_offline(uuid, uuid, text, text);
--   drop function if exists public.ops_review_rider_document(uuid, uuid, text, text, text);
--   drop function if exists public.ops_onboard_rider(uuid, uuid, uuid, jsonb, text);
--   drop function if exists public.ops_add_rider_adjustment(uuid, uuid, text, numeric, text, date, uuid, text);
--   drop function if exists public.ops_require_staff_for_rider(uuid, uuid);
--   drop function if exists public._ops_rider_state(uuid, boolean);
--   drop function if exists public._ops_rider_offline(uuid);
--   drop function if exists public._ops_rider_active_codes(uuid);
--   drop policy if exists "<table> — manager read" on public.<table>;  -- for each table in §4
--   then re-run 0142's _ops_rider_ineligible and 0003's lock_role();
--   drop function if exists public.rider_can_work(uuid);
--   alter table public.profiles drop column if exists account_status, drop column if exists status_reason,
--     drop column if exists status_changed_by, drop column if exists status_changed_at;

begin;

-- ============================================================
-- 1 — Account status (generic: Phase 7 uses it for customers)
-- ============================================================
alter table public.profiles
  add column if not exists account_status    text not null default 'active',
  add column if not exists status_reason     text,
  add column if not exists status_changed_by uuid references public.profiles (id) on delete set null,
  add column if not exists status_changed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_account_status_check') then
    alter table public.profiles
      add constraint profiles_account_status_check check (account_status in ('active', 'suspended', 'restricted'));
  end if;
end $$;

comment on column public.profiles.account_status is
  'active | suspended | restricted. Changed only through audited ops RPCs (or by an admin). A suspended rider cannot go online or be dispatched (rider_can_work).';

-- 0003's lock_role(), plus the account-status columns: a person can edit their
-- own profile row (0001 "own profile — update") but never their own status.
create or replace function public.lock_role()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin()
     and coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    if new.role is distinct from old.role then
      raise exception 'role can only be changed by an admin';
    end if;
    if new.account_status    is distinct from old.account_status
       or new.status_reason     is distinct from old.status_reason
       or new.status_changed_by is distinct from old.status_changed_by
       or new.status_changed_at is distinct from old.status_changed_at then
      raise exception 'account status can only be changed by staff';
    end if;
  end if;
  return new;
end;
$$;

-- ============================================================
-- 2 — Who may work
-- ============================================================
create or replace function public.rider_can_work(p_rider uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.account_status = 'active' from public.profiles p where p.id = p_rider), false)
     and coalesce((select rp.verification_status <> 'rejected' from public.rider_profiles rp where rp.driver_id = p_rider), true);
$$;
revoke execute on function public.rider_can_work(uuid) from public, anon;
grant execute on function public.rider_can_work(uuid) to authenticated, service_role;

-- 0142's rule with the Phase 5 check made static: suspended or rejected riders
-- are `suspended` (the picker's word for "cannot work"). Order of checks
-- unchanged (src/lib/dispatch/eligibility.ts riderIneligibility).
create or replace function public._ops_rider_ineligible(p_rider uuid, p_zone uuid, p_current uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  st public.rider_status%rowtype;
begin
  if not exists (select 1 from public.profiles p where p.id = p_rider and p.role::text = 'driver') then
    return 'offline';
  end if;
  select * into st from public.rider_status where driver_id = p_rider;
  if st.driver_id is null or not st.is_online then
    return 'offline';
  end if;
  if st.break_until is not null and st.break_until > now() then
    return 'on_break';
  end if;
  if st.last_fix_at is null
     or st.last_fix_at <= now() - interval '5 minutes'
     or st.last_fix_at >= now() + interval '5 minutes' then
    return 'stale_fix';
  end if;
  if not public.rider_can_work(p_rider) then
    return 'suspended';
  end if;
  if p_zone is null
     or not exists (select 1 from public.staff_zones sz where sz.user_id = p_rider and sz.zone_id = p_zone) then
    return 'out_of_zone';
  end if;
  if p_current is not null and p_current = p_rider then
    return 'current_rider';
  end if;
  return null;
end;
$$;
revoke execute on function public._ops_rider_ineligible(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ============================================================
-- 3 — Helpers
-- ============================================================

-- The actor may act on this rider: an admin always; a manager when they share
-- one of the rider's zones. Returns the zone used for the audit row (the first
-- shared zone; an admin gets the rider's first zone, or null). A rider with no
-- zone is admin-only (fail closed). service_role only, like ops_require_staff.
create or replace function public.ops_require_staff_for_rider(p_actor uuid, p_rider uuid)
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  role_name text;
  shared    uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_rider and p.role::text = 'driver') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select p.role::text into role_name from public.profiles p where p.id = p_actor;
  if role_name = 'admin' then
    return (select sz.zone_id from public.staff_zones sz where sz.user_id = p_rider order by sz.zone_id limit 1);
  end if;
  if role_name = 'manager' then
    select theirs.zone_id into shared
      from public.staff_zones theirs
      join public.staff_zones mine on mine.zone_id = theirs.zone_id and mine.user_id = p_actor
     where theirs.user_id = p_rider
     order by theirs.zone_id
     limit 1;
    if shared is not null then
      return shared;
    end if;
  end if;
  raise exception 'forbidden' using errcode = '42501';
end;
$$;
revoke execute on function public.ops_require_staff_for_rider(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ops_require_staff_for_rider(uuid, uuid) to service_role;

create or replace function public._ops_rider_state(p_rider uuid, p_replayed boolean default false)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'rider_id', p.id,
    'account', p.account_status,
    'verification', coalesce(rp.verification_status, 'unverified'),
    'rider_code', rp.rider_code,
    'replayed', coalesce(p_replayed, false)
  )
  from public.profiles p
  left join public.rider_profiles rp on rp.driver_id = p.id
  where p.id = p_rider;
$$;
revoke execute on function public._ops_rider_state(uuid, boolean) from public, anon, authenticated, service_role;

-- The short codes of the orders this rider is carrying right now, or null.
create or replace function public._ops_rider_active_codes(p_rider uuid)
returns text
language sql stable security definer set search_path = public as $$
  select string_agg(coalesce(o.short_code, upper(left(o.id::text, 8))), ',' order by d.assigned_at)
    from public.deliveries d
    join public.orders o on o.id = d.order_id
   where d.driver_id = p_rider and d.status in ('assigned', 'picked_up');
$$;
revoke execute on function public._ops_rider_active_codes(uuid) from public, anon, authenticated, service_role;

-- Take a rider out of service: offline, no break, the open shift ended by ops,
-- every offer still waiting on them released back to dispatch.
create or replace function public._ops_rider_offline(p_rider uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.rider_status
     set is_online = false, break_until = null, online_since = null, updated_at = now()
   where driver_id = p_rider;
  update public.rider_shifts
     set ended_at = now(), ended_by = 'ops'
   where driver_id = p_rider and ended_at is null;
  update public.deliveries
     set offered_driver_id = null, offered_at = null
   where offered_driver_id = p_rider and status = 'unassigned';
end;
$$;
revoke execute on function public._ops_rider_offline(uuid) from public, anon, authenticated, service_role;

-- ============================================================
-- 4 — Zone-scoped manager reads
-- ============================================================
do $$
declare
  t   text;
  pol record;
  ours constant text[] := array[
    'rider_earnings — read', 'rider_incentive_awards — read', 'rider_adjustments — read', 'rider_adjustments — admin write',
    'rider_payouts — read', 'rider_ratings — read', 'rider_ratings — customer insert', 'cash_deposits — read',
    'cash_disputes — read', 'rider_documents — read', 'rider_profile_change_requests — read'];
begin
  foreach t in array array['rider_earnings', 'rider_incentive_awards', 'rider_adjustments', 'rider_payouts',
                           'rider_ratings', 'cash_deposits', 'cash_disputes', 'rider_documents',
                           'rider_profile_change_requests'] loop
    -- A Rider-branch migration may have opened these to every manager; that is
    -- replaced by the zone rule below (whatever the policy was called).
    for pol in
      select policyname from pg_policies
       where schemaname = 'public' and tablename = t
         and policyname <> all (ours)
         and policyname <> t || ' — manager read'
         and (coalesce(qual, '') ilike '%manager%')
    loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('drop policy if exists %I on public.%I', t || ' — manager read', t);
    execute format(
      'create policy %I on public.%I for select using (public.manager_can_see_rider(driver_id))',
      t || ' — manager read', t);
  end loop;
end $$;

-- ============================================================
-- 5 — The audited rider RPCs
-- Common shape (0142): lock, re-check the zone, honour a replayed client action
-- id (returning replayed: true so the server fires no side effects), change,
-- log with before/after in the same transaction, return the current state.
-- ============================================================

-- approve  unverified|pending|rejected → verified  (aadhaar, driving_licence and
--          photo verified, unless p_override — recorded in the audit row)
-- reject   unverified|pending → rejected            (refused while on a delivery)
create or replace function public.ops_set_rider_verification(
  p_actor uuid, p_rider uuid, p_decision text, p_expected text, p_reason text, p_override boolean, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  zone     uuid;
  cur      text;
  target   text;
  missing  text;
  codes    text;
  v_reason   constant text := trim(coalesce(p_reason, ''));
  override constant boolean := coalesce(p_override, false);
begin
  zone := public.ops_require_staff_for_rider(p_actor, p_rider);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_rider_state(p_rider, true);
  end if;
  select coalesce(verification_status, 'unverified') into cur
    from public.rider_profiles where driver_id = p_rider for update;
  cur := coalesce(cur, 'unverified');
  if char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_expected is null or cur <> p_expected then
    raise exception 'stale' using errcode = '40001';
  end if;
  target := case
    when p_decision = 'approve' and cur in ('unverified', 'pending', 'rejected') then 'verified'
    when p_decision = 'reject'  and cur in ('unverified', 'pending')             then 'rejected'
  end;
  if target is null then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if p_decision = 'reject' then
    codes := public._ops_rider_active_codes(p_rider);
    if codes is not null then
      raise exception 'active_delivery' using errcode = '22023', detail = codes;
    end if;
  end if;
  if p_decision = 'approve' then
    select string_agg(t, ',' order by ord) into missing
      from unnest(array['aadhaar', 'driving_licence', 'photo']) with ordinality as req(t, ord)
     where not exists (select 1 from public.rider_documents d
                        where d.driver_id = p_rider and d.doc_type = req.t and d.status = 'verified');
    if missing is not null and not override then
      raise exception 'documents_unverified' using errcode = '22023', detail = missing;
    end if;
  end if;

  perform public._ops_set_actor(p_actor, v_reason);
  insert into public.rider_profiles (driver_id) values (p_rider) on conflict (driver_id) do nothing;
  update public.rider_profiles
     set verification_status = target,
         verified_at = case when target = 'verified' then now() else verified_at end,
         verified_by = case when target = 'verified' then p_actor else verified_by end,
         updated_at  = now()
   where driver_id = p_rider;
  if target = 'rejected' then
    perform public._ops_rider_offline(p_rider);
  end if;

  perform public._ops_log(
    p_actor, case when p_decision = 'approve' then 'rider.verify' else 'rider.reject' end,
    'rider', p_rider::text, zone, v_reason,
    jsonb_build_object('verification', cur),
    jsonb_build_object('verification', target)
      || case when p_decision = 'approve' and missing is not null
              then jsonb_build_object('documents_override', true, 'missing', missing) else '{}'::jsonb end,
    p_client_action_id);
  return public._ops_rider_state(p_rider, false);
end;
$$;

-- suspend    active → suspended   (refused while on a delivery; takes them offline)
-- reactivate suspended → active
create or replace function public.ops_set_rider_account(
  p_actor uuid, p_rider uuid, p_decision text, p_expected text, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  zone   uuid;
  cur    text;
  target text;
  codes  text;
  v_reason constant text := trim(coalesce(p_reason, ''));
begin
  zone := public.ops_require_staff_for_rider(p_actor, p_rider);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_rider_state(p_rider, true);
  end if;
  select account_status into cur from public.profiles where id = p_rider for update;
  if char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_expected is null or cur <> p_expected then
    raise exception 'stale' using errcode = '40001';
  end if;
  target := case
    when p_decision = 'suspend'    and cur = 'active'    then 'suspended'
    when p_decision = 'reactivate' and cur = 'suspended' then 'active'
  end;
  if target is null then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if target = 'suspended' then
    codes := public._ops_rider_active_codes(p_rider);
    if codes is not null then
      raise exception 'active_delivery' using errcode = '22023', detail = codes;
    end if;
  end if;

  perform public._ops_set_actor(p_actor, v_reason);
  update public.profiles
     set account_status = target, status_reason = v_reason, status_changed_by = p_actor, status_changed_at = now()
   where id = p_rider;
  if target = 'suspended' then
    perform public._ops_rider_offline(p_rider);
  end if;

  perform public._ops_log(
    p_actor, 'rider.' || p_decision, 'rider', p_rider::text, zone, v_reason,
    jsonb_build_object('account', cur), jsonb_build_object('account', target), p_client_action_id);
  return public._ops_rider_state(p_rider, false);
end;
$$;

-- An idle rider who is "online" but unreachable: offline now, offers released.
create or replace function public.ops_force_rider_offline(
  p_actor uuid, p_rider uuid, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  zone   uuid;
  was    boolean;
  codes  text;
  v_reason constant text := trim(coalesce(p_reason, ''));
begin
  zone := public.ops_require_staff_for_rider(p_actor, p_rider);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_rider_state(p_rider, true);
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  perform 1 from public.profiles where id = p_rider for update;
  codes := public._ops_rider_active_codes(p_rider);
  if codes is not null then
    raise exception 'active_delivery' using errcode = '22023', detail = codes;
  end if;
  select is_online into was from public.rider_status where driver_id = p_rider;

  perform public._ops_set_actor(p_actor, v_reason);
  perform public._ops_rider_offline(p_rider);
  perform public._ops_log(
    p_actor, 'rider.force_offline', 'rider', p_rider::text, zone, v_reason,
    jsonb_build_object('online', coalesce(was, false)), jsonb_build_object('online', false), p_client_action_id);
  return public._ops_rider_state(p_rider, false);
end;
$$;

-- verify | reject one pending document (remarks required to reject).
create or replace function public.ops_review_rider_document(
  p_actor uuid, p_document uuid, p_decision text, p_remarks text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  doc     public.rider_documents%rowtype;
  zone    uuid;
  v_remarks constant text := nullif(trim(coalesce(p_remarks, '')), '');
  target  text;
begin
  select * into doc from public.rider_documents where id = p_document for update;
  if doc.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  zone := public.ops_require_staff_for_rider(p_actor, doc.driver_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_rider_state(doc.driver_id, true) || jsonb_build_object('document_id', doc.id, 'status', doc.status);
  end if;
  target := case p_decision when 'verify' then 'verified' when 'reject' then 'rejected' end;
  if target is null then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if target = 'rejected' and (v_remarks is null or char_length(v_remarks) < 3 or char_length(v_remarks) > 500) then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if doc.status <> 'pending' then
    raise exception 'already_decided' using errcode = '22023';
  end if;

  perform public._ops_set_actor(p_actor, v_remarks);
  update public.rider_documents
     set status = target, remarks = v_remarks, reviewed_by = p_actor, reviewed_at = now()
   where id = p_document;
  perform public._ops_log(
    p_actor, 'rider.document.' || p_decision, 'rider_document', p_document::text, zone, v_remarks,
    jsonb_build_object('status', doc.status, 'type', doc.doc_type, 'riderId', doc.driver_id),
    jsonb_build_object('status', target, 'type', doc.doc_type, 'riderId', doc.driver_id),
    p_client_action_id);
  return public._ops_rider_state(doc.driver_id, false) || jsonb_build_object('document_id', doc.id, 'status', target);
end;
$$;

-- §5.2. The server has just created the login (auth cannot share a transaction
-- with SQL); this makes that account a pending rider in the manager's zone, with
-- their profile, in one step with the audit row. On failure the server deletes
-- the login again.
create or replace function public.ops_onboard_rider(
  p_actor uuid, p_user uuid, p_zone uuid, p_profile jsonb, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cur_role text;
  pr       jsonb := coalesce(p_profile, '{}'::jsonb);
  v_name   constant text := nullif(trim(coalesce(pr ->> 'fullName', '')), '');
  v_phone  constant text := nullif(trim(coalesce(pr ->> 'phone', '')), '');
begin
  perform public.ops_require_staff(p_actor, p_zone);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_rider_state(p_user, true);
  end if;
  select role::text into cur_role from public.profiles where id = p_user for update;
  if cur_role is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cur_role not in ('customer', 'driver') then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if v_name is null or char_length(v_name) > 80 then
    raise exception 'invalid_profile' using errcode = '22023', detail = 'fullName';
  end if;

  perform public._ops_set_actor(p_actor, 'Onboarded');
  update public.profiles
     set role = 'driver', full_name = v_name, phone = coalesce(v_phone, profiles.phone)
   where id = p_user;
  -- Exactly the chosen zone (0141's trigger put them in the default one).
  delete from public.staff_zones where user_id = p_user;
  insert into public.staff_zones (user_id, zone_id) values (p_user, p_zone);
  insert into public.rider_profiles (driver_id) values (p_user) on conflict (driver_id) do nothing;
  update public.rider_profiles
     set vehicle_type         = nullif(pr ->> 'vehicleType', ''),
         vehicle_owner        = coalesce(nullif(pr ->> 'vehicleOwner', ''), 'deligro'),
         vehicle_registration = nullif(trim(coalesce(pr ->> 'vehicleRegistration', '')), ''),
         licence_number       = nullif(trim(coalesce(pr ->> 'licenceNumber', '')), ''),
         licence_expires_on   = nullif(pr ->> 'licenceExpiresOn', '')::date,
         address_line         = nullif(trim(coalesce(pr ->> 'addressLine', '')), ''),
         pincode              = nullif(pr ->> 'pincode', ''),
         emergency_name       = nullif(trim(coalesce(pr ->> 'emergencyName', '')), ''),
         emergency_phone      = nullif(pr ->> 'emergencyPhone', ''),
         emergency_relation   = nullif(trim(coalesce(pr ->> 'emergencyRelation', '')), ''),
         verification_status  = 'pending',
         updated_at           = now()
   where driver_id = p_user;

  perform public._ops_log(
    p_actor, 'rider.onboard', 'rider', p_user::text, p_zone, null,
    jsonb_build_object('role', cur_role),
    jsonb_build_object('role', 'driver', 'zoneId', p_zone, 'verification', 'pending'),
    p_client_action_id);
  return public._ops_rider_state(p_user, false);
end;
$$;

-- bonus | deduction | adjustment, with a reason the rider can read. Salary goes
-- through maker–checker payment requests (0152), never here.
create or replace function public.ops_add_rider_adjustment(
  p_actor uuid, p_rider uuid, p_kind text, p_amount numeric, p_reason text, p_effective_on date,
  p_order uuid, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  zone   uuid;
  adj    uuid;
  v_reason constant text := trim(coalesce(p_reason, ''));
begin
  zone := public.ops_require_staff_for_rider(p_actor, p_rider);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_rider_state(p_rider, true);
  end if;
  if p_kind is null or p_kind not in ('bonus', 'deduction', 'adjustment') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if p_amount is null or p_amount = 0 or (p_kind <> 'adjustment' and p_amount < 0) or abs(p_amount) > 100000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_effective_on is null then
    raise exception 'invalid_date' using errcode = '22023';
  end if;
  perform 1 from public.profiles where id = p_rider for update;

  perform public._ops_set_actor(p_actor, v_reason);
  insert into public.rider_adjustments (driver_id, kind, amount, reason, order_id, effective_on, created_by)
  values (p_rider, p_kind, round(p_amount, 2), v_reason, p_order, p_effective_on, p_actor)
  returning id into adj;
  perform public._ops_log(
    p_actor, 'rider.adjustment', 'rider', p_rider::text, zone, v_reason, null,
    jsonb_build_object('adjustmentId', adj, 'kind', p_kind, 'amount', round(p_amount, 2), 'effectiveOn', p_effective_on),
    p_client_action_id);
  return public._ops_rider_state(p_rider, false) || jsonb_build_object('adjustment_id', adj);
end;
$$;

-- A document a manager uploads for a rider (§5.2), recorded with its audit row.
-- The file is already in the private rider-documents bucket (the server put it
-- there after checking its bytes); a previous document of the same type is
-- marked replaced. The raw number is kept for verification and never sent to
-- a signed-in client (column grants below); payloads carry number_masked.
create or replace function public.ops_add_rider_document(
  p_actor uuid, p_rider uuid, p_type text, p_number text, p_number_masked text, p_expires_on date,
  p_file_path text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  zone uuid;
  doc  uuid;
begin
  zone := public.ops_require_staff_for_rider(p_actor, p_rider);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('document_id',
      (select (after ->> 'documentId')::uuid from public.ops_audit_log where client_action_id = p_client_action_id),
      'replayed', true);
  end if;
  if p_type is null or p_type not in ('aadhaar', 'pan', 'driving_licence', 'vehicle_rc', 'insurance', 'puc', 'photo') then
    raise exception 'bad_type' using errcode = '22023';
  end if;
  if p_type in ('driving_licence', 'insurance', 'puc') and p_expires_on is null then
    raise exception 'expiry_required' using errcode = '22023';
  end if;
  if p_file_path is null or p_file_path not like p_rider::text || '/%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform 1 from public.profiles where id = p_rider for update;

  perform public._ops_set_actor(p_actor, null);
  update public.rider_documents set status = 'replaced'
   where driver_id = p_rider and doc_type = p_type and status <> 'replaced';
  insert into public.rider_documents (driver_id, doc_type, number, number_masked, file_path, expires_on, status)
  values (p_rider, p_type, nullif(trim(coalesce(p_number, '')), ''), p_number_masked, p_file_path, p_expires_on, 'pending')
  returning id into doc;
  perform public._ops_log(
    p_actor, 'rider.document.upload', 'rider', p_rider::text, zone, null, null,
    jsonb_build_object('documentId', doc, 'type', p_type, 'expiresOn', p_expires_on),
    p_client_action_id);
  return jsonb_build_object('document_id', doc, 'replayed', false);
end;
$$;

-- Raw identity numbers never reach a signed-in client: managers (through the
-- zone policy above) and riders read rider_documents and rider_profiles
-- without them; the server reads them with the service role and masks.
-- Column grants, as AGENTS.md rule 1 does for orders and restaurants: a column
-- added later stays invisible until granted on purpose.
revoke select on public.rider_documents from authenticated;
grant select (id, driver_id, doc_type, number_masked, file_path, expires_on, status, remarks, reviewed_by, reviewed_at,
              reminded_30_at, reminded_7_at, reminded_1_at, reminded_expired_at, created_at)
  on public.rider_documents to authenticated;
revoke select on public.rider_profiles from authenticated;
grant select (driver_id, rider_code, created_at, updated_at, address_line, city, pincode, vehicle_type, vehicle_owner,
              vehicle_registration, licence_expires_on, emergency_name, emergency_phone, emergency_relation,
              verification_status, verified_at, verified_by, notification_prefs, nav_app, language)
  on public.rider_profiles to authenticated;

revoke execute on function public.ops_add_rider_document(uuid, uuid, text, text, text, date, text, text) from public, anon, authenticated;
grant execute on function public.ops_add_rider_document(uuid, uuid, text, text, text, date, text, text) to service_role;

revoke execute on function public.ops_set_rider_verification(uuid, uuid, text, text, text, boolean, text) from public, anon, authenticated;
revoke execute on function public.ops_set_rider_account(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_force_rider_offline(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ops_review_rider_document(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_onboard_rider(uuid, uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function public.ops_add_rider_adjustment(uuid, uuid, text, numeric, text, date, uuid, text) from public, anon, authenticated;
grant execute on function public.ops_set_rider_verification(uuid, uuid, text, text, text, boolean, text) to service_role;
grant execute on function public.ops_set_rider_account(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.ops_force_rider_offline(uuid, uuid, text, text) to service_role;
grant execute on function public.ops_review_rider_document(uuid, uuid, text, text, text) to service_role;
grant execute on function public.ops_onboard_rider(uuid, uuid, uuid, jsonb, text) to service_role;
grant execute on function public.ops_add_rider_adjustment(uuid, uuid, text, numeric, text, date, uuid, text) to service_role;

commit;
