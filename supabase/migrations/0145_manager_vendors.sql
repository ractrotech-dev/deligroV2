-- 0145 — Manager vendors: the `rejected` status, status provenance, document
-- review, zone-scoped manager reads, the ticket ↔ shop link, and the audited
-- RPCs managers (and admins) use to decide vendors, review documents, onboard a
-- shop and work a ticket thread.
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0145.mjs); run it on staging first.
-- Depends on 0017 (vendor_status), 0019 (vendor_documents), 0033 (reviews,
-- review_replies), 0062 (store_holidays), 0064 (support tickets), 0141 (zones,
-- staff_zones, _ops_log, manager_can_see_zone), 0142 (ops_require_staff,
-- _ops_replayed, _ops_set_actor), 0143 (ticket manager extensions).
-- Plan: docs/superpowers/plans/2026-10-21-manager-app-phase-4-vendors-products.md.
--
-- Security changes (docs/SECURITY_AUDIT.md applies):
--   * `restaurants.status_reason`, `status_changed_by`, `status_changed_at`:
--     not granted to anon/authenticated (restaurants is column-allowlisted since
--     0022), admin-only in lock_restaurant_privileged_fields().
--   * `vendor_documents.status`, `remarks`, `reviewed_by`, `reviewed_at`: the
--     table is readable by the shop owner and admins (0019) and now by the
--     zone's managers; writes stay service role / admin.
--   * New permissive SELECT policies for managers, each through the shop's zone:
--     restaurants, vendor_documents, reviews, review_replies, store_holidays.
--   * `support_tickets.restaurant_id`: derived by trigger, never trusted from the
--     writer.
--   * Every ops_* function here is service_role only and re-checks the actor's
--     zone in the database (ops_require_staff).
--
-- Rollback (an enum value cannot be dropped: `rejected` stays on vendor_status;
-- move any rejected shop back to 'pending' first):
--   drop function if exists public.ops_set_vendor_status(uuid, uuid, text, public.vendor_status, text, boolean, text);
--   drop function if exists public.ops_review_vendor_document(uuid, uuid, text, text, text);
--   drop function if exists public.ops_add_vendor_document(uuid, uuid, text, text, text, text);
--   drop function if exists public.ops_onboard_vendor(uuid, uuid, uuid, jsonb, jsonb, text);
--   drop function if exists public.ops_add_ticket_message(uuid, uuid, text, boolean, text);
--   drop function if exists public.ops_set_ticket_status(uuid, uuid, text, text, text);
--   drop function if exists public._ops_vendor_state(uuid);
--   drop trigger if exists zz_stamp_ticket_restaurant on public.support_tickets;
--   drop function if exists public.stamp_ticket_restaurant();
--   alter table public.support_tickets drop column if exists restaurant_id;
--   drop policy if exists "restaurants — manager read" on public.restaurants;
--   drop policy if exists "vendor_documents — manager read" on public.vendor_documents;
--   drop policy if exists "reviews — manager read" on public.reviews;
--   drop policy if exists "review_replies — manager read" on public.review_replies;
--   drop policy if exists "store_holidays — manager read" on public.store_holidays;
--   alter table public.vendor_documents drop column if exists status, drop column if exists remarks,
--     drop column if exists reviewed_by, drop column if exists reviewed_at;
--   alter table public.restaurants drop column if exists status_reason,
--     drop column if exists status_changed_by, drop column if exists status_changed_at;
--   -- then re-run lock_restaurant_privileged_fields() from 0141.

-- Must run outside the transaction below: a new enum value cannot be used in
-- the transaction that adds it. Nothing below uses it at creation time.
alter type public.vendor_status add value if not exists 'rejected';

begin;

-- 1. Status provenance ------------------------------------------------------------
alter table public.restaurants
  add column if not exists status_reason     text,
  add column if not exists status_changed_by uuid references public.profiles (id) on delete set null,
  add column if not exists status_changed_at timestamptz;

comment on column public.restaurants.status_reason is
  'Why the shop was last approved, rejected, suspended or reactivated. Admin / ops only.';

-- 0141's definition plus the three provenance columns. A shop owner holds
-- UPDATE on their own row; nothing a vendor writes may touch approval, zone,
-- money terms, ranking or who decided their status.
create or replace function public.lock_restaurant_privileged_fields()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if public.is_admin()
     or coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin')
     or current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  if new.approved          is distinct from old.approved
  or new.status            is distinct from old.status
  or new.owner_id          is distinct from old.owner_id
  or new.commission_pct    is distinct from old.commission_pct
  or new.zone_id           is distinct from old.zone_id
  or new.status_reason     is distinct from old.status_reason
  or new.status_changed_by is distinct from old.status_changed_by
  or new.status_changed_at is distinct from old.status_changed_at then
    raise exception 'approval, ownership, commission and zone are admin-only';
  end if;

  if new.accept_cod              is distinct from old.accept_cod
  or new.accept_online           is distinct from old.accept_online
  or new.cod_max_order           is distinct from old.cod_max_order
  or new.other_charges_per_order is distinct from old.other_charges_per_order
  or new.settlement_cycle        is distinct from old.settlement_cycle then
    raise exception 'payment rules and settlement terms are admin-only';
  end if;

  -- 0056: ranking and reputation are not the shop's to set.
  if new.rating               is distinct from old.rating
  or new.rating_count         is distinct from old.rating_count
  or new.rating_sum           is distinct from old.rating_sum
  or new.promoted             is distinct from old.promoted
  or new.sort_position        is distinct from old.sort_position
  or new.owner_phone_verified is distinct from old.owner_phone_verified then
    raise exception 'ranking, rating and verification are admin-only';
  end if;

  return new;
end;
$$;

-- 2. Document review ---------------------------------------------------------------
alter table public.vendor_documents
  add column if not exists status      text not null default 'pending',
  add column if not exists remarks     text,
  add column if not exists reviewed_by uuid references public.profiles (id) on delete set null,
  add column if not exists reviewed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.vendor_documents'::regclass
                  and conname = 'vendor_documents_status_check') then
    alter table public.vendor_documents add constraint vendor_documents_status_check
      check (status in ('pending', 'verified', 'rejected'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.vendor_documents'::regclass
                  and conname = 'vendor_documents_remarks_len') then
    alter table public.vendor_documents add constraint vendor_documents_remarks_len
      check (remarks is null or char_length(remarks) <= 500);
  end if;
end $$;

create index if not exists vendor_documents_status_idx on public.vendor_documents (restaurant_id, status);

-- 3. Manager reads, through the shop's zone -------------------------------------------
drop policy if exists "restaurants — manager read" on public.restaurants;
create policy "restaurants — manager read" on public.restaurants for select
  using (public.manager_can_see_zone(zone_id));

drop policy if exists "vendor_documents — manager read" on public.vendor_documents;
create policy "vendor_documents — manager read" on public.vendor_documents for select
  using (exists (select 1 from public.restaurants r
                  where r.id = restaurant_id and public.manager_can_see_zone(r.zone_id)));

drop policy if exists "reviews — manager read" on public.reviews;
create policy "reviews — manager read" on public.reviews for select
  using (exists (select 1 from public.restaurants r
                  where r.id = restaurant_id and public.manager_can_see_zone(r.zone_id)));

drop policy if exists "review_replies — manager read" on public.review_replies;
create policy "review_replies — manager read" on public.review_replies for select
  using (exists (select 1 from public.reviews rv join public.restaurants r on r.id = rv.restaurant_id
                  where rv.id = review_id and public.manager_can_see_zone(r.zone_id)));

drop policy if exists "store_holidays — manager read" on public.store_holidays;
create policy "store_holidays — manager read" on public.store_holidays for select
  using (exists (select 1 from public.restaurants r
                  where r.id = restaurant_id and public.manager_can_see_zone(r.zone_id)));

-- 4. Tickets ↔ shop -------------------------------------------------------------------
alter table public.support_tickets
  add column if not exists restaurant_id uuid references public.restaurants (id) on delete set null;
create index if not exists support_tickets_restaurant_idx on public.support_tickets (restaurant_id, created_at desc);

comment on column public.support_tickets.restaurant_id is
  'The shop a ticket concerns: its order''s shop, else the requesting vendor''s shop. Derived, never trusted from the writer.';

-- Named zz_ so it fires after 0143's stamp_ticket_zone: a vendor's ticket with no
-- order has no staff zone, so it takes the shop's zone here.
create or replace function public.stamp_ticket_restaurant()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.restaurant_id := null;
  if new.order_id is not null then
    select o.restaurant_id into new.restaurant_id from public.orders o where o.id = new.order_id;
  elsif exists (select 1 from public.profiles p where p.id = new.requester_id and p.role::text = 'restaurant') then
    select r.id into new.restaurant_id
      from public.restaurants r
     where r.owner_id = new.requester_id
     order by r.created_at, r.id
     limit 1;
  end if;
  -- A shop's ticket lives in the shop's zone, whatever the writer sent.
  if new.restaurant_id is not null then
    select r.zone_id into new.zone_id from public.restaurants r where r.id = new.restaurant_id;
  end if;
  return new;
end;
$$;
revoke all on function public.stamp_ticket_restaurant() from public;

drop trigger if exists zz_stamp_ticket_restaurant on public.support_tickets;
create trigger zz_stamp_ticket_restaurant
  before insert on public.support_tickets
  for each row execute function public.stamp_ticket_restaurant();

update public.support_tickets t
   set restaurant_id = o.restaurant_id
  from public.orders o
 where t.order_id = o.id and t.restaurant_id is null;
update public.support_tickets t
   set restaurant_id = (select r.id from public.restaurants r where r.owner_id = t.requester_id order by r.created_at, r.id limit 1)
 where t.restaurant_id is null and t.order_id is null
   and exists (select 1 from public.profiles p where p.id = t.requester_id and p.role::text = 'restaurant');
update public.support_tickets t
   set zone_id = r.zone_id
  from public.restaurants r
 where t.restaurant_id = r.id and t.zone_id is null;

-- 5. Vendor RPCs ----------------------------------------------------------------------
create or replace function public._ops_vendor_state(p_restaurant uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('restaurant_id', r.id, 'status', r.status::text)
    from public.restaurants r where r.id = p_restaurant;
$$;
revoke execute on function public._ops_vendor_state(uuid) from public, anon, authenticated, service_role;

-- approve  pending|rejected → active      reject     pending → rejected
-- suspend  active|inactive  → suspended   reactivate suspended|inactive → active
create or replace function public.ops_set_vendor_status(
  p_actor uuid, p_restaurant uuid, p_action text, p_expected public.vendor_status,
  p_reason text, p_override boolean, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r        record;
  reason   constant text := trim(coalesce(p_reason, ''));
  target   text;
  missing  text;
  override constant boolean := coalesce(p_override, false);
begin
  select id, status::text as status, zone_id, lat, lng into r
    from public.restaurants where id = p_restaurant for update;
  if r.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, r.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_vendor_state(p_restaurant);
  end if;
  if char_length(reason) < 3 or char_length(reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_expected is null or r.status <> p_expected::text then
    raise exception 'stale' using errcode = '40001';
  end if;

  target := case
    when p_action = 'approve'    and r.status in ('pending', 'rejected')   then 'active'
    when p_action = 'reject'     and r.status = 'pending'                  then 'rejected'
    when p_action = 'suspend'    and r.status in ('active', 'inactive')    then 'suspended'
    when p_action = 'reactivate' and r.status in ('suspended', 'inactive') then 'active'
  end;
  if target is null then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  if p_action in ('approve', 'reactivate') and (r.lat is null or r.lng is null) then
    raise exception 'needs_map_pin' using errcode = '22023';
  end if;

  if p_action = 'approve' then
    select string_agg(t, ',' order by ord) into missing
      from unnest(array['fssai', 'bank_proof']) with ordinality as req(t, ord)
     where not exists (select 1 from public.vendor_documents d
                        where d.restaurant_id = p_restaurant and d.doc_type = req.t and d.status = 'verified');
    if missing is not null and not override then
      raise exception 'documents_unverified' using errcode = '22023', detail = missing;
    end if;
  end if;

  perform public._ops_set_actor(p_actor, reason);
  update public.restaurants
     set status = target::public.vendor_status,
         status_reason = reason,
         status_changed_by = p_actor,
         status_changed_at = now()
   where id = p_restaurant;

  perform public._ops_log(
    p_actor, 'vendor.' || p_action, 'vendor', p_restaurant::text, r.zone_id, reason,
    jsonb_build_object('status', r.status),
    jsonb_build_object('status', target)
      || case when p_action = 'approve' and missing is not null
              then jsonb_build_object('documents_override', true, 'missing', missing) else '{}'::jsonb end,
    p_client_action_id);
  return public._ops_vendor_state(p_restaurant);
end;
$$;

create or replace function public.ops_review_vendor_document(
  p_actor uuid, p_document uuid, p_decision text, p_remarks text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d       record;
  v_remarks constant text := nullif(trim(coalesce(p_remarks, '')), '');
begin
  select vd.id, vd.restaurant_id, vd.doc_type, vd.status, r.zone_id into d
    from public.vendor_documents vd join public.restaurants r on r.id = vd.restaurant_id
   where vd.id = p_document
   for update of vd;
  if d.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, d.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('document_id', p_document, 'restaurant_id', d.restaurant_id);
  end if;
  if p_decision not in ('verified', 'rejected') then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if p_decision = 'rejected' and (v_remarks is null or char_length(v_remarks) < 3) then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if v_remarks is not null and char_length(v_remarks) > 500 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  update public.vendor_documents
     set status = p_decision, remarks = v_remarks, reviewed_by = p_actor, reviewed_at = now()
   where id = p_document;

  perform public._ops_log(
    p_actor, 'vendor.document.' || p_decision, 'vendor', d.restaurant_id::text, d.zone_id, v_remarks,
    jsonb_build_object('documentId', p_document, 'type', d.doc_type, 'status', d.status),
    jsonb_build_object('documentId', p_document, 'type', d.doc_type, 'status', p_decision),
    p_client_action_id);
  return jsonb_build_object('document_id', p_document, 'restaurant_id', d.restaurant_id);
end;
$$;

-- The file is already in storage (the server uploads it after the scope check);
-- this records it and logs the upload in one step.
create or replace function public.ops_add_vendor_document(
  p_actor uuid, p_restaurant uuid, p_type text, p_storage_path text, p_file_name text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  zone   uuid;
  doc_id uuid;
begin
  select zone_id into zone from public.restaurants where id = p_restaurant;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, zone);
  if public._ops_replayed(p_actor, p_client_action_id) then
    select (after ->> 'documentId')::uuid into doc_id
      from public.ops_audit_log where client_action_id = p_client_action_id and actor_id = p_actor;
    return jsonb_build_object('document_id', doc_id, 'restaurant_id', p_restaurant);
  end if;
  if p_type not in ('fssai', 'gst', 'pan', 'bank_proof', 'shop_license', 'other')
     or coalesce(trim(p_storage_path), '') = '' or coalesce(trim(p_file_name), '') = '' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  insert into public.vendor_documents (restaurant_id, doc_type, storage_path, file_name, uploaded_by)
  values (p_restaurant, p_type, p_storage_path, left(trim(p_file_name), 200), p_actor)
  returning id into doc_id;

  perform public._ops_log(
    p_actor, 'vendor.document.upload', 'vendor', p_restaurant::text, zone, null, null,
    jsonb_build_object('documentId', doc_id, 'type', p_type, 'fileName', p_file_name),
    p_client_action_id);
  return jsonb_build_object('document_id', doc_id, 'restaurant_id', p_restaurant);
end;
$$;

-- Onboarding. The auth user and profile are created by the server first (they
-- cannot share a transaction with SQL); this inserts the shop and its seed
-- menu and logs it. Managers can never set money terms or bank details: those
-- keys are honoured for an admin actor only.
create or replace function public.ops_onboard_vendor(
  p_actor uuid, p_owner uuid, p_zone uuid, p_shop jsonb, p_menu jsonb, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  role_name text;
  zone      uuid := p_zone;
  rid       uuid;
  slug_v    text;
  is_admin_actor boolean;
  s         constant jsonb := coalesce(p_shop, '{}'::jsonb);
begin
  if zone is null then
    zone := public.default_zone_id();
  end if;
  role_name := public.ops_require_staff(p_actor, zone);
  is_admin_actor := role_name = 'admin';

  if public._ops_replayed(p_actor, p_client_action_id) then
    select (after ->> 'restaurantId')::uuid into rid
      from public.ops_audit_log where client_action_id = p_client_action_id and actor_id = p_actor;
    return jsonb_build_object('restaurant_id', rid,
                              'slug', (select slug from public.restaurants where id = rid));
  end if;

  if p_owner is null or not exists (select 1 from public.profiles where id = p_owner) then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  slug_v := nullif(trim(s ->> 'slug'), '');
  if slug_v is null or coalesce(trim(s ->> 'name'), '') = '' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  insert into public.restaurants (
    owner_id, slug, name, description, category, image_url, is_open, status, zone_id,
    owner_name, owner_mobile, owner_alt_mobile, owner_email, owner_phone_verified,
    password_reset_at, commission_pct, min_order, delivery_available, self_pickup,
    opening_time, closing_time, weekly_off, address, landmark, pincode, lat, lng,
    upi_id, bank_account_name, bank_name, bank_account_number, bank_ifsc,
    fssai_number, gst_number, pan_number, tc_accepted_at, tc_accepted_by, tc_version
  ) values (
    p_owner, slug_v, trim(s ->> 'name'), s ->> 'description', s ->> 'category', s ->> 'image_url', true,
    'pending', zone,
    s ->> 'owner_name', s ->> 'owner_mobile', s ->> 'owner_alt_mobile', s ->> 'owner_email',
    case when is_admin_actor then coalesce((s ->> 'owner_phone_verified')::boolean, false) else false end,
    case when (s ->> 'password_issued')::boolean then now() end,
    case when is_admin_actor then least(100, greatest(0, (s ->> 'commission_pct')::numeric)) end,
    greatest(0, coalesce((s ->> 'min_order')::integer, 0)),
    coalesce((s ->> 'delivery_available')::boolean, true),
    coalesce((s ->> 'self_pickup')::boolean, false),
    nullif(s ->> 'opening_time', '')::time, nullif(s ->> 'closing_time', '')::time,
    coalesce(array(select jsonb_array_elements_text(coalesce(s -> 'weekly_off', '[]'::jsonb))), '{}'),
    s ->> 'address', s ->> 'landmark', s ->> 'pincode',
    (s ->> 'lat')::double precision, (s ->> 'lng')::double precision,
    case when is_admin_actor then s ->> 'upi_id' end,
    case when is_admin_actor then s ->> 'bank_account_name' end,
    case when is_admin_actor then s ->> 'bank_name' end,
    case when is_admin_actor then s ->> 'bank_account_number' end,
    case when is_admin_actor then s ->> 'bank_ifsc' end,
    s ->> 'fssai_number',
    case when is_admin_actor then s ->> 'gst_number' end,
    case when is_admin_actor then s ->> 'pan_number' end,
    now(), p_actor, s ->> 'tc_version'
  )
  returning id into rid;

  insert into public.menu_items (restaurant_id, name, description, price, veg, available, category)
  select rid, trim(m ->> 'name'), m ->> 'description',
         greatest(0, coalesce((m ->> 'price')::integer, 0)),
         coalesce((m ->> 'veg')::boolean, true), coalesce((m ->> 'available')::boolean, true),
         nullif(trim(m ->> 'category'), '')
    from jsonb_array_elements(coalesce(p_menu, '[]'::jsonb)) m
   where coalesce(trim(m ->> 'name'), '') <> '';

  perform public._ops_log(
    p_actor, 'vendor.onboard', 'vendor', rid::text, zone, null, null,
    jsonb_build_object('restaurantId', rid, 'slug', slug_v, 'name', trim(s ->> 'name'), 'ownerId', p_owner,
                       'menuItems', jsonb_array_length(coalesce(p_menu, '[]'::jsonb))),
    p_client_action_id);
  return jsonb_build_object('restaurant_id', rid, 'slug', slug_v);
end;
$$;

-- 6. Ticket thread RPCs (role-generic; Phase 8 extends) --------------------------------
create or replace function public.ops_add_ticket_message(
  p_actor uuid, p_ticket uuid, p_body text, p_internal boolean, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t         record;
  role_name text;
  body      constant text := trim(coalesce(p_body, ''));
  internal_ constant boolean := coalesce(p_internal, false);
  mid       uuid;
begin
  select id, zone_id, status, first_response_at into t
    from public.support_tickets where id = p_ticket for update;
  if t.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  role_name := public.ops_require_staff(p_actor, t.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('ticket_id', p_ticket);
  end if;
  if char_length(body) < 1 or char_length(body) > 4000 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if t.status = 'closed' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  insert into public.support_messages (ticket_id, author_id, author_role, body, internal)
  values (p_ticket, p_actor, role_name, body, internal_)
  returning id into mid;

  update public.support_tickets
     set first_response_at = case when not internal_ and first_response_at is null then now() else first_response_at end,
         status = case when not internal_ and status = 'open' then 'in_progress' else status end,
         updated_at = now()
   where id = p_ticket;

  perform public._ops_log(
    p_actor, 'ticket.message', 'ticket', p_ticket::text, t.zone_id, null, null,
    jsonb_build_object('messageId', mid, 'internal', internal_), p_client_action_id);
  return jsonb_build_object('ticket_id', p_ticket, 'message_id', mid);
end;
$$;

create or replace function public.ops_set_ticket_status(
  p_actor uuid, p_ticket uuid, p_status text, p_resolution text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t          record;
  v_resolution constant text := nullif(trim(coalesce(p_resolution, '')), '');
begin
  select id, zone_id, status into t from public.support_tickets where id = p_ticket for update;
  if t.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, t.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('ticket_id', p_ticket, 'status', t.status);
  end if;
  if p_status not in ('in_progress', 'waiting_on_requester', 'resolved', 'closed') or t.status = 'closed' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if p_status in ('resolved', 'closed')
     and (v_resolution is null or char_length(v_resolution) < 3 or char_length(v_resolution) > 1000) then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  update public.support_tickets
     set status = p_status,
         resolution = case when p_status in ('resolved', 'closed') then v_resolution else support_tickets.resolution end,
         resolved_at = case when p_status in ('resolved', 'closed') then coalesce(resolved_at, now()) else null end,
         updated_at = now()
   where id = p_ticket;

  perform public._ops_log(
    p_actor, 'ticket.status', 'ticket', p_ticket::text, t.zone_id, v_resolution,
    jsonb_build_object('status', t.status), jsonb_build_object('status', p_status), p_client_action_id);
  return jsonb_build_object('ticket_id', p_ticket, 'status', p_status);
end;
$$;

revoke execute on function public.ops_set_vendor_status(uuid, uuid, text, public.vendor_status, text, boolean, text) from public, anon, authenticated;
revoke execute on function public.ops_review_vendor_document(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_add_vendor_document(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.ops_onboard_vendor(uuid, uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke execute on function public.ops_add_ticket_message(uuid, uuid, text, boolean, text) from public, anon, authenticated;
revoke execute on function public.ops_set_ticket_status(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.ops_set_vendor_status(uuid, uuid, text, public.vendor_status, text, boolean, text) to service_role;
grant execute on function public.ops_review_vendor_document(uuid, uuid, text, text, text) to service_role;
grant execute on function public.ops_add_vendor_document(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.ops_onboard_vendor(uuid, uuid, uuid, jsonb, jsonb, text) to service_role;
grant execute on function public.ops_add_ticket_message(uuid, uuid, text, boolean, text) to service_role;
grant execute on function public.ops_set_ticket_status(uuid, uuid, text, text, text) to service_role;

commit;
