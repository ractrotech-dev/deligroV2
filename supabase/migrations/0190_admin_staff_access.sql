-- ============================================================
-- 0190 — Admin can stop a manager, start them again, and end their sessions
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL — not applied to any database.
-- Deploy order: … → 0141 → 0151 → … → 0185 → 0190.
--
-- Riders already had this (0151 ops_set_rider_account); managers had nothing, so
-- Admin → Team could create a manager but never stop one.
--
--   * ops_admin_set_staff_account: active ⇄ suspended on a MANAGER's account, with
--     its audit row, in one transaction. Admin only, service role only. Refuses
--     yourself and any admin, so the last admin can never be stopped this way. The
--     server bans the account in Supabase Auth alongside it.
--   * ops_revoke_staff_sessions: ends a manager's or rider's sessions (a stop, a
--     password reset). The same shape as 0162 / 0181's.
--   * is_manager(): a stopped manager is no longer one to RLS, so a token issued
--     before the stop cannot read through PostgREST until it expires.
--
-- No grant to anon or authenticated, no new column. A stopped manager's data is
-- not touched: their zones and switches are all still there when they start again.
--
-- Rollback:
--   drop function if exists public.ops_admin_set_staff_account(uuid, uuid, text, text, text, text);
--   drop function if exists public.ops_revoke_staff_sessions(uuid, uuid);
--   then re-run 0023's is_manager().
-- ============================================================

begin;

create or replace function public.is_manager()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role = 'manager' and account_status = 'active' from public.profiles where id = auth.uid()),
    false
  );
$$;

create or replace function public.ops_admin_set_staff_account(
  p_actor uuid, p_user uuid, p_decision text, p_expected text, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  role_name text;
  cur       text;
  target    text;
  v_reason constant text := trim(coalesce(p_reason, ''));
begin
  perform public.ops_require_admin(p_actor);
  if p_user = p_actor then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['staff.stop', 'staff.start'], p_user::text);
    return jsonb_build_object('status', (select p.account_status from public.profiles p where p.id = p_user), 'replayed', true);
  end if;
  select p.role::text, p.account_status into role_name, cur from public.profiles p where p.id = p_user for update;
  -- Managers only. Riders go through ops_set_rider_account, which also takes them
  -- offline and refuses during a delivery; admins are never stopped from here.
  if role_name is distinct from 'manager' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_expected is null or cur <> p_expected then
    raise exception 'stale' using errcode = '40001';
  end if;
  target := case
    when p_decision = 'stop' and cur = 'active' then 'suspended'
    when p_decision = 'start' and cur = 'suspended' then 'active'
  end;
  if target is null then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  update public.profiles
     set account_status = target, status_reason = v_reason, status_changed_by = p_actor, status_changed_at = now()
   where id = p_user;
  perform public._ops_log(
    p_actor, case p_decision when 'stop' then 'staff.stop' else 'staff.start' end, 'staff', p_user::text, null, v_reason,
    jsonb_build_object('account', cur), jsonb_build_object('account', target), p_client_action_id);
  return jsonb_build_object('status', target, 'replayed', false);
end;
$$;
revoke execute on function public.ops_admin_set_staff_account(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.ops_admin_set_staff_account(uuid, uuid, text, text, text, text) to service_role;

create or replace function public.ops_revoke_staff_sessions(p_actor uuid, p_user uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  perform public.ops_require_admin(p_actor);
  if not exists (select 1 from public.profiles p where p.id = p_user and p.role::text in ('manager', 'driver')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from auth.sessions where user_id = p_user;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.ops_revoke_staff_sessions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ops_revoke_staff_sessions(uuid, uuid) to service_role;

commit;
