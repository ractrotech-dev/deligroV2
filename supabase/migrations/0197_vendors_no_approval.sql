-- 0197 — Vendors have no review or approval step (owner's decision, 2026-11-04).
--
-- Vendors cannot sign themselves up: only an admin or a manager can add a shop,
-- so there is nothing to review. A shop an admin or manager adds is live at once.
-- The one condition left is 0050's: a shop cannot be live without a map pin. An
-- unpinned shop stays `inactive` until someone pins it and switches it on.
--
-- This migration:
--   1. Moves every shop out of the review states. `pending` shops with a pin go
--      live; `pending` shops without one become `inactive`, because 0050 refuses
--      anything else. `rejected` shops become `inactive`: somebody declined them,
--      so they stay off until somebody switches them on.
--   2. Stops those two states coming back (CHECK), and fixes the default.
--   3. ops_onboard_vendor creates a live shop (or inactive, with no pin).
--   4. ops_set_vendor_status loses approve and reject and the required-documents
--      check. ops_admin_set_vendor_status refuses the two old states.
--   5. Drops ops_review_vendor_document. Documents stay on file (upload, open,
--      delete); nobody verifies or rejects them any more. `vendor_documents.status`,
--      `remarks`, `reviewed_by` and `reviewed_at` keep their old values as history.
--
-- Not changed: `restaurants.approved` stays. The 0017 trigger keeps it equal to
-- `status = 'active'`, and the customer feed and RLS read it, so it now simply
-- means "live". Rider verification and dish moderation are separate and untouched.
--
-- Security (docs/SECURITY_AUDIT.md): no column, grant or RLS policy changes. Shop
-- creation stays as it was: `restaurants` INSERT needs is_admin() (0024) and
-- ops_onboard_vendor runs for the service role only, with the actor's staff role
-- and zone checked in the database (0145).
--
-- The enum keeps `pending` and `rejected`: Postgres cannot drop an enum value.
-- Old audit rows (`vendor.approve`, `vendor.reject`) stay as history.
--
-- Rollback: re-run section 5 of 0145 for the functions and 0017's
-- sync_restaurant_status(), then
--   alter table public.restaurants drop constraint restaurants_status_no_review;
--   alter table public.restaurants alter column status set default 'pending';
-- The shops moved in step 1 can be found by their status_reason.

begin;

-- 1. Existing shops ------------------------------------------------------------
-- `approved` follows through the 0017 trigger; 0050's trigger guards the pin.
update public.restaurants
   set status = case when lat is not null and lng is not null
                     then 'active'::public.vendor_status
                     else 'inactive'::public.vendor_status end,
       status_reason = case when lat is not null and lng is not null
                            then 'Approved when the review step was removed'
                            else 'Approved when the review step was removed. Off until it has a map pin.' end,
       status_changed_at = now()
 where status = 'pending';

update public.restaurants
   set status = 'inactive',
       status_reason = 'Was rejected before the review step was removed. Off until someone switches it on.',
       status_changed_at = now()
 where status = 'rejected';

-- 2. The review states cannot come back -----------------------------------------
alter table public.restaurants alter column status set default 'inactive';

alter table public.restaurants drop constraint if exists restaurants_status_no_review;
alter table public.restaurants add constraint restaurants_status_no_review
  check (status in ('active', 'inactive', 'suspended'));

-- 0017's trigger with the insert rule changed. It runs before the CHECK, so a
-- writer that still sends `pending` lands on a real state, and `approved = true`
-- with no status still means live.
create or replace function public.sync_restaurant_status()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status in ('pending', 'rejected') or (new.status = 'inactive' and new.approved) then
      new.status := case when new.approved then 'active'::vendor_status else 'inactive'::vendor_status end;
    end if;
    new.approved := (new.status = 'active');
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      new.approved := (new.status = 'active');
    elsif new.approved is distinct from old.approved then
      -- Legacy path: only `approved` was set. Move status to match.
      new.status := case
        when new.approved then 'active'::vendor_status
        when old.status = 'active' then 'inactive'::vendor_status
        else old.status
      end;
      new.approved := (new.status = 'active');
    end if;
  end if;
  return new;
end;
$$;

-- 3. A shop an admin or manager adds is live -------------------------------------
-- Otherwise 0145's definition. Managers still cannot set money terms or bank details.
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
    case when (s ->> 'lat') is not null and (s ->> 'lng') is not null
         then 'active'::public.vendor_status else 'inactive'::public.vendor_status end,
    zone,
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

-- 4. Status changes ---------------------------------------------------------------
-- suspend  active|inactive  → suspended   reactivate suspended|inactive → active
-- The signature keeps p_override (now ignored) so a server deployed before or
-- after this migration can still call it.
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
    when p_action = 'suspend'    and r.status in ('active', 'inactive')    then 'suspended'
    when p_action = 'reactivate' and r.status in ('suspended', 'inactive') then 'active'
  end;
  if target is null then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  if p_action = 'reactivate' and (r.lat is null or r.lng is null) then
    raise exception 'needs_map_pin' using errcode = '22023';
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
    jsonb_build_object('status', target),
    p_client_action_id);
  return public._ops_vendor_state(p_restaurant);
end;
$$;

create or replace function public.ops_admin_set_vendor_status(
  p_actor uuid, p_restaurant uuid, p_status public.vendor_status, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r      record;
  reason constant text := coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Changed in the admin console');
begin
  select id, status::text as status, zone_id, lat, lng into r
    from public.restaurants where id = p_restaurant for update;
  if r.id is null or public.ops_require_staff(p_actor, r.zone_id) <> 'admin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if public._ops_replayed(p_actor, p_client_action_id) then
    return public._ops_vendor_state(p_restaurant);
  end if;
  if p_status is null or p_status::text in ('pending', 'rejected') then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if r.status = p_status::text then
    return public._ops_vendor_state(p_restaurant);
  end if;
  if p_status::text = 'active' and (r.lat is null or r.lng is null) then
    raise exception 'needs_map_pin' using errcode = '22023';
  end if;

  perform public._ops_set_actor(p_actor, reason);
  update public.restaurants
     set status = p_status, status_reason = reason, status_changed_by = p_actor, status_changed_at = now()
   where id = p_restaurant;
  perform public._ops_log(
    p_actor, 'vendor.status', 'vendor', p_restaurant::text, r.zone_id, reason,
    jsonb_build_object('status', r.status), jsonb_build_object('status', p_status::text), p_client_action_id);
  return public._ops_vendor_state(p_restaurant);
end;
$$;

-- 5. Nobody reviews documents any more --------------------------------------------
drop function if exists public.ops_review_vendor_document(uuid, uuid, text, text, text);

commit;
