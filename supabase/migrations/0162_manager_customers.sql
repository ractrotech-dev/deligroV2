-- ============================================================
-- 0162 — Customers for managers: scoped reads, contact reveal, suspension
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL. Not applied to any database. Runs after 0151
-- (profiles.account_status and its lock in lock_role) and 0142 (ops helpers).
--
--   * A manager's session reads its own profile only (0023's blanket read and the
--     scoped read that replaced it are dropped): customers, riders and shop
--     owners come through the server, scoped and permissioned, so a phone number
--     is never one REST call away.
--   * ops_lookup_caller(actor, phone): the phone desk's lookup (a first-time caller
--     has no order yet). Service role only; returns name, is-staff and account
--     status — never the id — and writes an audit row (last four digits).
--   * ops_log_order_contact_view(actor, order): the customer's number on an active
--     order, audited once per manager per order; a finished order shows none.
--   * ops_search_customer_by_phone / ops_reveal_customer_contact: audited,
--     scoped; the contact itself is never written into the audit row.
--   * ops_revoke_customer_sessions: ends a suspended customer's live sessions
--     (with the Auth ban the app applies, so a token stops working at once).
--   * ops_set_customer_account: suspend / restrict / reactivate a customer,
--     with a reason, audited (0151's columns).
--   * guard_order_customer_status: no order is created for a customer whose
--     account is not active — every path, the service role included.
--   * ops_customer_list / ops_retention: the list and the retention summary and
--     cohorts, computed in SQL over the scope's zones (no row cap to truncate them).
--
-- Rollback:
--   drop trigger if exists guard_order_customer_status on public.orders;
--   drop function if exists public.guard_order_customer_status(), public.ops_retention(uuid[], timestamptz, timestamptz, integer),
--     public.ops_customer_list(uuid[], text, text, text, text, uuid, integer, uuid[]),
--     public.ops_set_customer_account(uuid, uuid, text, text, text, text),
--     public.ops_reveal_customer_contact(uuid, uuid, text, text, text),
--     public.ops_search_customer_by_phone(uuid, text, text), public.ops_lookup_caller(uuid, text), public.ops_log_order_contact_view(uuid, uuid), public.ops_revoke_customer_sessions(uuid, uuid),
--     public._ops_require_customer(uuid, uuid);
--   -- and re-create 0141/0162's scoped profiles read from the previous migration if it is wanted back.
--   drop policy if exists "profiles — manager scoped read" on public.profiles;
--   create policy "profiles — manager read" on public.profiles for select using (public.is_manager());
-- ============================================================

begin;

create index if not exists orders_customer_created_idx on public.orders (customer_id, created_at);

-- 1. A manager's session reads its own profile and nobody else's ---------------------------
-- 0023's blanket read let a manager read every profile; the scoped version that
-- replaced it still let one read an in-scope customer's phone (and every staff
-- member's) straight from the REST API — round the permission and the audit row of
-- ops_reveal_customer_contact. Every manager screen reads people through the server
-- (service role, scoped and permissioned), so a session needs nothing but its own
-- row, which 0001's "own profile — read" already gives.
drop policy if exists "profiles — manager read" on public.profiles;
drop policy if exists "profiles — manager scoped read" on public.profiles;
drop function if exists public.manager_can_see_customer(uuid);

-- 2. The phone desk -------------------------------------------------------------------
-- A first-time caller has no order yet, so no scoped read could find them; this
-- answers the desk's one question (who is this, staff or not, can they order) and
-- nothing else — never an id, never a phone. Service role only, for a manager or
-- admin actor; the server action behind it needs manager.phone_orders and rate-limits.
-- Every lookup is an audit row that records the last four digits only.
drop function if exists public.ops_lookup_caller(text);
create or replace function public.ops_lookup_caller(p_actor uuid, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p         record;
  role_name text;
  hit       boolean;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select pr.role::text into role_name from public.profiles pr where pr.id = p_actor;
  if role_name is null or role_name not in ('admin', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_phone is null or p_phone !~ '^\+[0-9]{10,15}$' then
    return null;
  end if;
  select full_name, role::text as role, account_status into p from public.profiles where phone = p_phone limit 1;
  hit := found;
  perform public._ops_log(p_actor, 'customer.phone_search', 'customer', null, null, null, null,
    jsonb_build_object('phone_last4', right(p_phone, 4), 'results', case when hit then 1 else 0 end, 'via', 'phone_desk'), null);
  if not hit then
    return null;
  end if;
  return jsonb_build_object('name', nullif(trim(p.full_name), ''), 'is_staff', p.role <> 'customer', 'status', p.account_status);
end;
$$;
revoke execute on function public.ops_lookup_caller(uuid, text) from public, anon, authenticated;
grant execute on function public.ops_lookup_caller(uuid, text) to service_role;

-- The customer's number on an order in flight is a live need (the rider is at the
-- door, the kitchen is waiting): a manager with manager.call_customer sees it, and
-- the first time they do, it is an audit row — once per manager per order, never
-- for a finished order. Returns whether the number may be shown.
create or replace function public.ops_log_order_contact_view(p_actor uuid, p_order uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  o record;
begin
  select ord.zone_id, ord.status::text as status into o from public.orders ord where ord.id = p_order;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, o.zone_id);
  if o.status in ('delivered', 'cancelled') then
    return false;
  end if;
  if not exists (select 1 from public.ops_audit_log l
                  where l.action = 'order.contact_view' and l.actor_id = p_actor and l.entity_id = p_order::text) then
    perform public._ops_log(p_actor, 'order.contact_view', 'order', p_order::text, o.zone_id, 'Calling about active order',
      null, null, null);
  end if;
  return true;
end;
$$;
revoke execute on function public.ops_log_order_contact_view(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ops_log_order_contact_view(uuid, uuid) to service_role;

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

-- A suspended customer's live sessions end with the suspension: a ban in Supabase Auth
-- stops refresh tokens, and this removes the sessions themselves so an access token
-- already issued stops working at the next refresh check instead of at expiry. Same
-- scope rule as every other write here (admin: any customer; manager: one who ordered
-- in their zones). Service role only; returns how many sessions were removed.
create or replace function public.ops_revoke_customer_sessions(p_actor uuid, p_customer uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  perform public._ops_require_customer(p_actor, p_customer);
  delete from auth.sessions where user_id = p_customer;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.ops_revoke_customer_sessions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ops_revoke_customer_sessions(uuid, uuid) to service_role;

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
  -- The candidates first (ids, status, name), THEN their orders: a phone-search or a name
  -- narrows to a handful of customers before any order is read, instead of aggregating
  -- every order in the scope and filtering afterwards.
  with cand as (
    select p.id, p.full_name, p.phone, p.account_status, p.created_at
      from public.profiles p
     where p.role::text = 'customer'
       and (p_ids is null or p.id = any (p_ids))
       and (p_status is null or p.account_status = p_status)
       and (p_q is null or p_q = ''
            or (p_q ~* '^[0-9a-f]{8,}$' and replace(p.id::text, '-', '') like lower(p_q) || '%')
            or (p_q ~* '^[0-9a-f-]{36}$' and p.id::text = lower(p_q))
            or (char_length(p_q) >= 2 and p.full_name ilike '%' || replace(replace(p_q, '%', ''), '_', '') || '%'))
  ), scoped as (
    select o.customer_id,
           count(*) filter (where o.status <> 'cancelled' and public.ops_counts_as_order(o.payment_method, o.payment_status))::integer as n,
           coalesce(sum(o.total) filter (where o.status <> 'cancelled' and public.ops_counts_as_order(o.payment_method, o.payment_status)), 0)::integer as s,
           max(o.created_at) as last_at,
           array_agg(distinct o.zone_id) filter (where o.zone_id is not null) as zones
      from public.orders o
     where o.customer_id in (select c.id from cand c) and (p_zones is null or o.zone_id = any (p_zones))
     group by o.customer_id
  ), rows as (
    select c.id, c.full_name, c.phone, c.account_status, c.created_at as member_since,
           s.n as orders, s.s as spent, s.last_at as last_order_at, s.zones as zone_ids,
           case coalesce(p_sort, 'recent')
             when 'orders' then lpad(s.n::text, 10, '0')
             when 'spend' then lpad(s.s::text, 12, '0')
             else to_char(s.last_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS') end as sort_key
      from scoped s join cand c on c.id = s.customer_id
  )
  select r.id, r.full_name, r.phone, r.account_status, r.member_since, r.orders, r.spent, r.last_order_at, r.zone_ids, r.sort_key
    from rows r
   where p_after_key is null or (r.sort_key, r.id) < (p_after_key, p_after_id)
   order by r.sort_key desc, r.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 101);
$$;

-- Retention (§10.6) for the scope over [p_from, p_to), computed in SQL so it is exact
-- however many customers there are (an API row cap would silently truncate a
-- per-customer listing). The maths is src/lib/metrics/customers.ts's, which
-- scripts/qa/manager-retention-sql.ts holds this to: JavaScript's rounding
-- (floor(x + 0.5)), IST months, a customer's cohort = the IST month of their first
-- counted order ever, rN = share whose second order came within N days of the
-- first, null until every member could have reached N days.
create or replace function public.ops_retention(p_zones uuid[], p_from timestamptz, p_to timestamptz, p_months integer default 6)
returns jsonb
language sql stable security definer set search_path = public as $$
  with o as (
    select o.customer_id, o.created_at, o.total,
           row_number() over (partition by o.customer_id order by o.created_at, o.id) as rn
      from public.orders o
     where o.customer_id is not null and o.status <> 'cancelled'
       and public.ops_counts_as_order(o.payment_method, o.payment_status)
       and (p_zones is null or o.zone_id = any (p_zones))
       and o.created_at < p_to
  ), f as (
    select o.customer_id,
           min(o.created_at) filter (where o.rn = 1) as first_at,
           min(o.created_at) filter (where o.rn = 2) as second_at,
           (count(*) filter (where o.created_at >= p_from))::integer as n_in,
           coalesce(sum(o.total) filter (where o.created_at >= p_from), 0)::bigint as spent_in
      from o group by o.customer_id
  ), s as (
    select count(*)::integer as customers,
           (count(*) filter (where f.first_at >= p_from))::integer as new_c,
           (count(*) filter (where f.n_in >= 2))::integer as rep,
           coalesce(sum(f.n_in), 0)::bigint as orders,
           coalesce(sum(f.spent_in), 0)::bigint as spent
      from f where f.n_in > 0
  ), months as (
    select to_char(m, 'YYYY-MM') as cohort, ((m + interval '1 month') at time zone 'Asia/Kolkata') as month_end
      from (select date_trunc('month', (p_to - interval '1 second') at time zone 'Asia/Kolkata') - k * interval '1 month' as m
              from generate_series(0, least(greatest(coalesce(p_months, 6), 1), 24) - 1) k) x
  ), coh as (
    select mo.cohort, mo.month_end,
           count(f.customer_id)::integer as members,
           (count(f.customer_id) filter (where f.second_at is not null and f.second_at - f.first_at <= interval '30 days'))::integer as w30,
           (count(f.customer_id) filter (where f.second_at is not null and f.second_at - f.first_at <= interval '60 days'))::integer as w60,
           (count(f.customer_id) filter (where f.second_at is not null and f.second_at - f.first_at <= interval '90 days'))::integer as w90
      from months mo
      left join f on to_char(f.first_at at time zone 'Asia/Kolkata', 'YYYY-MM') = mo.cohort
     group by mo.cohort, mo.month_end
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'customers', s.customers,
      'newCustomers', s.new_c,
      'returningCustomers', s.customers - s.new_c,
      'repeatRate', case when s.customers > 0 then floor(s.rep::float8 / s.customers * 1000 + 0.5) / 10 else 0 end,
      'ordersPerCustomer', case when s.customers > 0 then floor(s.orders::float8 / s.customers * 10 + 0.5) / 10 else 0 end,
      'aovPerCustomer', case when s.orders > 0 then floor(s.spent::float8 / s.orders + 0.5) else 0 end),
    'cohorts', (select coalesce(jsonb_agg(jsonb_build_object(
        'cohort', c.cohort, 'customers', c.members,
        'r30', case when c.month_end + interval '30 days' > p_to then null when c.members = 0 then 0 else floor(c.w30::float8 / c.members * 1000 + 0.5) / 10 end,
        'r60', case when c.month_end + interval '60 days' > p_to then null when c.members = 0 then 0 else floor(c.w60::float8 / c.members * 1000 + 0.5) / 10 end,
        'r90', case when c.month_end + interval '90 days' > p_to then null when c.members = 0 then 0 else floor(c.w90::float8 / c.members * 1000 + 0.5) / 10 end
      ) order by c.cohort), '[]'::jsonb) from coh c))
    from s;
$$;

revoke execute on function public.ops_search_customer_by_phone(uuid, text, text),
  public.ops_reveal_customer_contact(uuid, uuid, text, text, text),
  public.ops_set_customer_account(uuid, uuid, text, text, text, text),
  public.ops_customer_list(uuid[], text, text, text, text, uuid, integer, uuid[]),
  public.ops_retention(uuid[], timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.ops_search_customer_by_phone(uuid, text, text),
  public.ops_reveal_customer_contact(uuid, uuid, text, text, text),
  public.ops_set_customer_account(uuid, uuid, text, text, text, text),
  public.ops_customer_list(uuid[], text, text, text, text, uuid, integer, uuid[]),
  public.ops_retention(uuid[], timestamptz, timestamptz, integer)
  to service_role;
revoke execute on function public.guard_order_customer_status() from public, anon, authenticated;

commit;
