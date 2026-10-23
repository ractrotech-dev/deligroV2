-- ============================================================
-- 0162 — Customers for managers: scoped reads, contact reveal, suspension
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL. Not applied to any database. Runs after 0151
-- (profiles.account_status and its lock in lock_role) and 0142 (ops helpers).
--
--   * manager_can_see_customer(id): admin, or a manager holding the zone of at
--     least one of the customer's orders. 0023's blanket "profiles — manager
--     read" is replaced by a scoped policy: self, customers as above, riders
--     the manager shares a zone with (0141), owners of shops in scope.
--   * ops_lookup_caller(phone): the phone desk's lookup (a first-time caller
--     has no order yet, so the policy above would hide them). Manager/admin
--     only; returns name, is-staff and account status — never the id.
--   * ops_search_customer_by_phone / ops_reveal_customer_contact: audited,
--     scoped; the contact itself is never written into the audit row.
--   * ops_set_customer_account: suspend / restrict / reactivate a customer,
--     with a reason, audited (0151's columns).
--   * guard_order_customer_status: no order is created for a customer whose
--     account is not active — every path, the service role included.
--   * ops_customer_list / ops_customer_order_facts: the list and the
--     retention facts, computed in SQL over the scope's zones.
--
-- Rollback:
--   drop trigger if exists guard_order_customer_status on public.orders;
--   drop function if exists public.guard_order_customer_status(), public.ops_customer_order_facts(uuid[], timestamptz, timestamptz),
--     public.ops_customer_list(uuid[], text, text, text, text, uuid, integer, uuid[]),
--     public.ops_set_customer_account(uuid, uuid, text, text, text, text),
--     public.ops_reveal_customer_contact(uuid, uuid, text, text, text),
--     public.ops_search_customer_by_phone(uuid, text, text), public.ops_lookup_caller(text),
--     public._ops_require_customer(uuid, uuid), public.manager_can_see_customer(uuid);
--   drop policy if exists "profiles — manager scoped read" on public.profiles;
--   create policy "profiles — manager read" on public.profiles for select using (public.is_manager());
-- ============================================================

begin;

create index if not exists orders_customer_created_idx on public.orders (customer_id, created_at);

-- 1. Who a manager may see ----------------------------------------------------------
create or replace function public.manager_can_see_customer(p_customer uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or (p_customer is not null
          and exists (select 1 from public.profiles me where me.id = auth.uid() and me.role = 'manager')
          and exists (select 1 from public.orders o
                        join public.staff_zones sz on sz.zone_id = o.zone_id and sz.user_id = auth.uid()
                       where o.customer_id = p_customer));
$$;
revoke execute on function public.manager_can_see_customer(uuid) from public, anon;
grant execute on function public.manager_can_see_customer(uuid) to authenticated, service_role;

drop policy if exists "profiles — manager read" on public.profiles;
drop policy if exists "profiles — manager scoped read" on public.profiles;
create policy "profiles — manager scoped read" on public.profiles for select
  using (
    id = auth.uid()
    or (public.is_manager() and (
          (role::text = 'customer' and public.manager_can_see_customer(id))
       or (role::text = 'driver' and public.manager_can_see_rider(id))
       or (role::text = 'restaurant' and exists (select 1 from public.restaurants r
                                                 where r.owner_id = profiles.id and public.manager_can_see_restaurant(r.id)))
       or (role::text in ('manager', 'admin')))));

-- 2. The phone desk -------------------------------------------------------------------
create or replace function public.ops_lookup_caller(p_phone text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  p record;
begin
  if not (public.is_admin() or public.is_manager()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_phone is null or p_phone !~ '^\+[0-9]{10,15}$' then
    return null;
  end if;
  select full_name, role::text as role, account_status into p from public.profiles where phone = p_phone limit 1;
  if not found then
    return null;
  end if;
  return jsonb_build_object('name', nullif(trim(p.full_name), ''), 'is_staff', p.role <> 'customer', 'status', p.account_status);
end;
$$;
revoke execute on function public.ops_lookup_caller(text) from public, anon;
grant execute on function public.ops_lookup_caller(text) to authenticated, service_role;

-- 3. Audited contact ---------------------------------------------------------------------
-- The actor may act on this customer: admin, or a manager holding a zone the
-- customer ordered in. Returns that zone (for the audit row).
create or replace function public._ops_require_customer(p_actor uuid, p_customer uuid)
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  role_name text;
  zone      uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select p.role::text into role_name from public.profiles p where p.id = p_actor;
  if role_name = 'admin' then
    select o.zone_id into zone from public.orders o where o.customer_id = p_customer order by o.created_at desc limit 1;
    return zone;
  end if;
  if role_name = 'manager' then
    select o.zone_id into zone
      from public.orders o join public.staff_zones sz on sz.zone_id = o.zone_id and sz.user_id = p_actor
     where o.customer_id = p_customer order by o.created_at desc limit 1;
    if zone is not null then
      return zone;
    end if;
  end if;
  raise exception 'forbidden' using errcode = '42501';
end;
$$;
revoke execute on function public._ops_require_customer(uuid, uuid) from public, anon, authenticated, service_role;

-- Phone search: the ids of in-scope customers with that number, and one audit
-- row that records the last four digits only.
create or replace function public.ops_search_customer_by_phone(p_actor uuid, p_phone text, p_client_action_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  role_name text;
  ids       jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select p.role::text into role_name from public.profiles p where p.id = p_actor;
  if role_name not in ('admin', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_phone is null or p_phone !~ '^\+[0-9]{10,15}$' then
    raise exception 'bad_request' using errcode = '22023', detail = 'phone';
  end if;
  select coalesce(jsonb_agg(p.id), '[]') into ids
    from public.profiles p
   where p.phone = p_phone and p.role::text = 'customer'
     and (role_name = 'admin' or exists (select 1 from public.orders o
                                          join public.staff_zones sz on sz.zone_id = o.zone_id and sz.user_id = p_actor
                                         where o.customer_id = p.id));
  perform public._ops_log(p_actor, 'customer.phone_search', 'customer', null, null, null, null,
    jsonb_build_object('phone_last4', right(p_phone, 4), 'results', jsonb_array_length(ids)), p_client_action_id);
  return ids;
end;
$$;

create or replace function public.ops_reveal_customer_contact(
  p_actor uuid, p_customer uuid, p_reason text, p_note text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  zone  uuid;
  note  constant text := nullif(trim(coalesce(p_note, '')), '');
  phone text;
  email text;
begin
  zone := public._ops_require_customer(p_actor, p_customer);
  if coalesce(p_reason, '') not in ('order_issue', 'refund', 'complaint', 'delivery', 'other') then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_reason = 'other' and (note is null or char_length(note) not between 3 and 200) then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if not public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_log(p_actor, 'customer.contact_reveal', 'customer', p_customer::text, zone,
      p_reason || coalesce(': ' || note, ''), null, jsonb_build_object('reason', p_reason), p_client_action_id);
  else
    perform public._ops_replay_matches(p_client_action_id, array['customer.contact_reveal'], p_customer::text);
  end if;
  select p.phone into phone from public.profiles p where p.id = p_customer;
  if to_regclass('auth.users') is not null then
    execute 'select email from auth.users where id = $1' into email using p_customer;
  end if;
  return jsonb_build_object('phone', phone, 'email', email);
end;
$$;

-- 4. Suspend / restrict / reactivate ------------------------------------------------------
create or replace function public.ops_set_customer_account(
  p_actor uuid, p_customer uuid, p_action text, p_expected text, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  zone   uuid;
  cur    record;
  reason constant text := nullif(trim(coalesce(p_reason, '')), '');
  target text;
begin
  select id, role::text as role, account_status into cur from public.profiles where id = p_customer for update;
  if cur.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cur.role <> 'customer' then
    -- Checked before scope, so staff accounts are never reachable from here.
    perform public._ops_require_customer(p_actor, p_customer);
    raise exception 'not_a_customer' using errcode = '22023';
  end if;
  zone := public._ops_require_customer(p_actor, p_customer);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id,
      array['customer.suspend', 'customer.restrict', 'customer.reactivate'], p_customer::text);
    return jsonb_build_object('customer_id', p_customer, 'status', cur.account_status, 'replayed', true);
  end if;
  if reason is null or char_length(reason) < 3 or char_length(reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if coalesce(p_expected, '') <> cur.account_status then
    raise exception 'stale' using errcode = '40001', detail = cur.account_status;
  end if;
  target := case p_action when 'suspend' then 'suspended' when 'restrict' then 'restricted' when 'reactivate' then 'active' end;
  if target is null or target = cur.account_status then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  update public.profiles
     set account_status = target, status_reason = reason, status_changed_by = p_actor, status_changed_at = now()
   where id = p_customer;
  perform public._ops_log(p_actor, 'customer.' || p_action, 'customer', p_customer::text, zone, reason,
    jsonb_build_object('status', cur.account_status), jsonb_build_object('status', target), p_client_action_id);
  return jsonb_build_object('customer_id', p_customer, 'status', target, 'replayed', false);
end;
$$;

-- 5. No order for an account that isn't active ---------------------------------------------
create or replace function public.guard_order_customer_status()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.customer_id is not null
     and exists (select 1 from public.profiles p where p.id = new.customer_id and p.account_status <> 'active') then
    raise exception 'account_restricted' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_order_customer_status on public.orders;
create trigger guard_order_customer_status before insert on public.orders
  for each row execute function public.guard_order_customer_status();

-- 6. The list and the retention facts, in SQL ------------------------------------------------
-- p_zones null = every zone (admin). Counts non-cancelled, counted orders only
-- (ops_counts_as_order: unpaid online checkouts are not orders).
create or replace function public.ops_customer_list(
  p_zones uuid[], p_q text, p_status text, p_sort text, p_after_key text, p_after_id uuid, p_limit integer,
  p_ids uuid[] default null
)
returns table (id uuid, full_name text, phone text, account_status text, member_since timestamptz,
               orders integer, spent integer, last_order_at timestamptz, zone_ids uuid[], sort_key text)
language sql stable security definer set search_path = public as $$
  with scoped as (
    select o.customer_id,
           count(*) filter (where o.status <> 'cancelled' and public.ops_counts_as_order(o.payment_method, o.payment_status))::integer as n,
           coalesce(sum(o.total) filter (where o.status <> 'cancelled' and public.ops_counts_as_order(o.payment_method, o.payment_status)), 0)::integer as s,
           max(o.created_at) as last_at,
           array_agg(distinct o.zone_id) filter (where o.zone_id is not null) as zones
      from public.orders o
     where o.customer_id is not null and (p_zones is null or o.zone_id = any (p_zones))
     group by o.customer_id
  ), rows as (
    select p.id, p.full_name, p.phone, p.account_status, p.created_at as member_since,
           s.n as orders, s.s as spent, s.last_at as last_order_at, s.zones as zone_ids,
           case coalesce(p_sort, 'recent')
             when 'orders' then lpad(s.n::text, 10, '0')
             when 'spend' then lpad(s.s::text, 12, '0')
             else to_char(s.last_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS') end as sort_key
      from scoped s join public.profiles p on p.id = s.customer_id
     where p.role::text = 'customer'
       and (p_ids is null or p.id = any (p_ids))
       and (p_status is null or p.account_status = p_status)
       and (p_q is null or p_q = ''
            or (p_q ~* '^[0-9a-f]{8,}$' and replace(p.id::text, '-', '') like lower(p_q) || '%')
            or (p_q ~* '^[0-9a-f-]{36}$' and p.id::text = lower(p_q))
            or (char_length(p_q) >= 2 and p.full_name ilike '%' || replace(replace(p_q, '%', ''), '_', '') || '%'))
  )
  select r.id, r.full_name, r.phone, r.account_status, r.member_since, r.orders, r.spent, r.last_order_at, r.zone_ids, r.sort_key
    from rows r
   where p_after_key is null or (r.sort_key, r.id) < (p_after_key, p_after_id)
   order by r.sort_key desc, r.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 101);
$$;

-- Per customer: their first and second counted orders ever (within the zones),
-- and their orders and spend within the range.
create or replace function public.ops_customer_order_facts(p_zones uuid[], p_from timestamptz, p_to timestamptz)
returns table (customer_id uuid, first_order_at timestamptz, second_order_at timestamptz,
               orders_in_range integer, spent_in_range integer, last_order_at timestamptz)
language sql stable security definer set search_path = public as $$
  with o as (
    select o.customer_id, o.created_at, o.total,
           row_number() over (partition by o.customer_id order by o.created_at, o.id) as rn
      from public.orders o
     where o.customer_id is not null and o.status <> 'cancelled'
       and public.ops_counts_as_order(o.payment_method, o.payment_status)
       and (p_zones is null or o.zone_id = any (p_zones))
       and o.created_at < p_to
  )
  select o.customer_id,
         min(o.created_at) filter (where o.rn = 1),
         min(o.created_at) filter (where o.rn = 2),
         count(*) filter (where o.created_at >= p_from)::integer,
         coalesce(sum(o.total) filter (where o.created_at >= p_from), 0)::integer,
         max(o.created_at)
    from o
   group by o.customer_id
  having count(*) filter (where o.created_at >= p_from) > 0
      or min(o.created_at) filter (where o.rn = 1) >= p_to - interval '7 months';
$$;

revoke execute on function public.ops_search_customer_by_phone(uuid, text, text),
  public.ops_reveal_customer_contact(uuid, uuid, text, text, text),
  public.ops_set_customer_account(uuid, uuid, text, text, text, text),
  public.ops_customer_list(uuid[], text, text, text, text, uuid, integer, uuid[]),
  public.ops_customer_order_facts(uuid[], timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ops_search_customer_by_phone(uuid, text, text),
  public.ops_reveal_customer_contact(uuid, uuid, text, text, text),
  public.ops_set_customer_account(uuid, uuid, text, text, text, text),
  public.ops_customer_list(uuid[], text, text, text, text, uuid, integer, uuid[]),
  public.ops_customer_order_facts(uuid[], timestamptz, timestamptz)
  to service_role;
revoke execute on function public.guard_order_customer_status() from public, anon, authenticated;

commit;
