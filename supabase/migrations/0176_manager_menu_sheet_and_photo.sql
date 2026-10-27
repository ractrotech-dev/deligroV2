-- 0176 — Manager: a shop's menu from a sheet, and replacing a wrong dish photo.
--
-- Spec: docs/superpowers/specs/2026-10-27-manager-menu-sheet-and-photo-replace-design.md
--
-- * ops_bulk_menu_apply: the rows of a manager's menu sheet (already planned by
--   src/lib/bulk/menu-plan.ts) written in one audited call. Dishes go live at
--   once, except what the restricted-category rules hold for a vendor too: a
--   new restricted dish waits for approval, and a price / discount / category
--   change on one is held exactly as guard_menu_item_moderation holds it.
-- * ops_replace_listing_photo: a manager puts a new photo on a dish (an upload
--   or the Deligro photo library). It counts as reviewed, and an open
--   "wrong image" flag on the dish is resolved.
-- * menu_items.submitted_by: who left a dish waiting for approval through the
--   sheet. ops_decide_listing refuses an approval by that same person.
--
-- Rollback:
--   drop function if exists public.ops_bulk_menu_apply(uuid, uuid, jsonb, jsonb, text, text);
--   drop function if exists public.ops_replace_listing_photo(uuid, uuid, text, uuid, text, bigint, text);
--   drop trigger if exists guard_menu_item_submitted_by on public.menu_items;
--   drop function if exists public.guard_menu_item_submitted_by();
--   -- re-run ops_decide_listing from 0146_manager_products.sql
--   alter table public.menu_items drop column if exists submitted_by;

begin;

-- 1. Who submitted a held dish -----------------------------------------------------------
alter table public.menu_items
  add column if not exists submitted_by uuid references public.profiles (id) on delete set null;

comment on column public.menu_items.submitted_by is
  'The manager whose menu sheet left this dish waiting for approval; that manager may not approve it. Cleared by a decision.';

-- Only the ops RPCs set it: a vendor's own edit (row-level security lets the
-- owner write the row) keeps whatever was there, so a vendor cannot block a
-- manager from approving, or clear the mark.
create or replace function public.guard_menu_item_submitted_by()
returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if public.menu_moderation_trusted() then
    return new;
  end if;
  new.submitted_by := case when tg_op = 'UPDATE' then old.submitted_by end;
  return new;
end;
$$;

drop trigger if exists guard_menu_item_submitted_by on public.menu_items;
create trigger guard_menu_item_submitted_by
  before insert or update on public.menu_items
  for each row execute function public.guard_menu_item_submitted_by();

-- 2. Approving: never your own sheet's dish -------------------------------------------------
create or replace function public.ops_decide_listing(
  p_actor uuid, p_item uuid, p_decision text, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  z      record;
  m      record;
  reason constant text := nullif(trim(coalesce(p_reason, '')), '');
  target text;
begin
  select * into z from public._ops_item_zone(p_item);
  if z.restaurant_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, z.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    return jsonb_build_object('item_id', p_item);
  end if;
  select approval_status, price, pending_price, submitted_by into m from public.menu_items where id = p_item for update;
  if p_decision not in ('approve', 'reject') or m.approval_status <> 'pending' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  -- Four eyes: the manager whose sheet held the dish cannot wave it through.
  if p_decision = 'approve' and m.submitted_by = p_actor then
    raise exception 'self_approval' using errcode = '42501';
  end if;
  if p_decision = 'reject' and (reason is null or char_length(reason) < 3) then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if reason is not null and char_length(reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  target := case when p_decision = 'approve' or m.pending_price is not null then 'approved' else 'rejected' end;
  perform set_config('deligro.ops_moderation', 'on', true);
  perform public._ops_set_actor(p_actor, reason);
  update public.menu_items
     set approval_status = target,
         price = case when p_decision = 'approve' and pending_price is not null then pending_price else price end,
         pending_price = null,
         approval_note = reason,
         submitted_by = null,
         moderated_by = p_actor,
         moderated_at = now()
   where id = p_item;
  perform set_config('deligro.ops_moderation', '', true);
  perform public._ops_log(p_actor, 'product.' || p_decision, 'product', p_item::text, z.zone_id, reason,
                          jsonb_build_object('approvalStatus', m.approval_status, 'price', m.price, 'pendingPrice', m.pending_price),
                          jsonb_build_object('approvalStatus', target), p_client_action_id);
  return jsonb_build_object('item_id', p_item, 'approval_status', target);
end;
$$;

-- 3. A manager's menu sheet ---------------------------------------------------------------
-- p_updates: [{"id": <dish>, "patch": {column: value}}]; p_inserts: [{column: value}].
-- Each row is written on its own: a row that fails (a dish of another shop, a
-- column outside the list, a value the table refuses) is reported by its index
-- and the rest still land. Stock counts are not set here on an existing dish
-- (ops_adjust_stock does that, with its stale check); a new dish may start with one.
create or replace function public.ops_bulk_menu_apply(
  p_actor uuid, p_restaurant uuid, p_updates jsonb, p_inserts jsonb, p_filename text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  zone      uuid;
  patch_ok  constant text[] := array['name', 'category', 'price', 'discount_price', 'description', 'veg', 'available',
                                     'popular', 'bestseller', 'image_url', 'image_library_id', 'external_id', 'low_stock_at'];
  insert_ok constant text[] := patch_ok || array['stock_qty'];
  updates   constant jsonb := coalesce(p_updates, '[]'::jsonb);
  inserts   constant jsonb := coalesce(p_inserts, '[]'::jsonb);
  fname     constant text := left(nullif(trim(coalesce(p_filename, '')), ''), 200);
  created   integer := 0;
  updated   integer := 0;
  held      integer := 0;
  errors    jsonb := '[]'::jsonb;
  result    jsonb;
  u         jsonb;
  p         jsonb;
  i         integer;
  cur       public.menu_items%rowtype;
  nr        public.menu_items%rowtype;
  was_live  boolean;
  now_r     boolean;
  was_r     boolean;
  hold      boolean;
begin
  select r.zone_id into zone from public.restaurants r where r.id = p_restaurant;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, zone);
  if public._ops_replayed(p_actor, p_client_action_id) then
    select after - 'filename' into result from public.ops_audit_log
     where client_action_id = p_client_action_id and actor_id = p_actor;
    return result;
  end if;
  if jsonb_typeof(updates) <> 'array' or jsonb_typeof(inserts) <> 'array'
     or jsonb_array_length(updates) > 200 or jsonb_array_length(inserts) > 200 then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  perform set_config('deligro.ops_moderation', 'on', true);
  perform public._ops_set_actor(p_actor, 'Menu sheet' || coalesce(' ' || fname, ''));

  for i in 0 .. jsonb_array_length(updates) - 1 loop
    u := updates -> i;
    begin
      p := u -> 'patch';
      if jsonb_typeof(p) <> 'object' or exists (select 1 from jsonb_object_keys(p) k where k <> all (patch_ok)) then
        raise exception 'bad_row';
      end if;
      select * into cur from public.menu_items
       where id = (u ->> 'id')::uuid and restaurant_id = p_restaurant
       for update;
      if not found then
        raise exception 'bad_row';
      end if;
      nr := jsonb_populate_record(cur, p);
      hold := false;

      -- The vendor's restricted-category rules (guard_menu_item_moderation), applied here
      -- because this trusted write skips that guard.
      was_live := cur.approval_status = 'approved' or (cur.approval_status = 'pending' and cur.pending_price is not null);
      now_r := public.is_restricted_category(nr.category);
      was_r := public.is_restricted_category(cur.category);
      if nr.category is distinct from cur.category then
        nr.pending_price := null;
        if now_r then
          nr.approval_status := 'pending';
          nr.approval_note := 'Moved to the restricted category ' || btrim(nr.category);
          hold := true;
        elsif was_r and cur.approval_status <> 'rejected' then
          nr.approval_status := 'pending';
          nr.approval_note := 'Moved out of the restricted category ' || btrim(cur.category);
          hold := true;
        end if;
      elsif now_r and was_live then
        if nr.discount_price is distinct from cur.discount_price then
          nr.price := case when nr.price is distinct from cur.price then nr.price else coalesce(cur.pending_price, nr.price) end;
          nr.pending_price := null;
          nr.approval_status := 'pending';
          nr.approval_note := 'Discount price changed';
          hold := true;
        elsif nr.price is distinct from cur.price then
          nr.pending_price := nr.price;
          nr.price := cur.price;
          nr.approval_status := 'pending';
          hold := true;
        end if;
      end if;
      if not hold and cur.approval_status = 'rejected'
         and (nr.name, nr.price, nr.discount_price, nr.category, nr.description, nr.image_url)
             is distinct from (cur.name, cur.price, cur.discount_price, cur.category, cur.description, cur.image_url) then
        nr.approval_status := 'pending';
        hold := true;
      end if;
      if hold then
        nr.submitted_by := p_actor;
        held := held + 1;
      end if;

      update public.menu_items
         set name = nr.name, category = nr.category, price = nr.price, discount_price = nr.discount_price,
             description = nr.description, veg = nr.veg, available = nr.available, popular = nr.popular,
             bestseller = nr.bestseller, image_url = nr.image_url, image_library_id = nr.image_library_id,
             external_id = nr.external_id, low_stock_at = nr.low_stock_at,
             approval_status = nr.approval_status, approval_note = nr.approval_note,
             pending_price = nr.pending_price, submitted_by = nr.submitted_by
       where id = cur.id;
      updated := updated + 1;
    exception when others then
      errors := errors || jsonb_build_object('kind', 'update', 'index', i);
    end;
  end loop;

  for i in 0 .. jsonb_array_length(inserts) - 1 loop
    p := inserts -> i;
    begin
      if jsonb_typeof(p) <> 'object' or exists (select 1 from jsonb_object_keys(p) k where k <> all (insert_ok)) then
        raise exception 'bad_row';
      end if;
      nr := jsonb_populate_record(null::public.menu_items, p);
      if nullif(btrim(coalesce(nr.name, '')), '') is null or nr.price is null then
        raise exception 'bad_row';
      end if;
      hold := public.is_restricted_category(nr.category);
      insert into public.menu_items
        (restaurant_id, name, category, price, discount_price, description, veg, available, popular, bestseller,
         image_url, image_library_id, external_id, stock_qty, low_stock_at, approval_status, submitted_by)
      values
        (p_restaurant, nr.name, nr.category, nr.price, nr.discount_price, nr.description, coalesce(nr.veg, true),
         coalesce(nr.available, true), coalesce(nr.popular, false), coalesce(nr.bestseller, false),
         nr.image_url, nr.image_library_id, nr.external_id, nr.stock_qty, nr.low_stock_at,
         case when hold then 'pending' else 'approved' end, case when hold then p_actor end);
      created := created + 1;
      if hold then
        held := held + 1;
      end if;
    exception when others then
      errors := errors || jsonb_build_object('kind', 'insert', 'index', i);
    end;
  end loop;

  perform set_config('deligro.ops_moderation', '', true);
  result := jsonb_build_object('created', created, 'updated', updated, 'held', held, 'errors', errors);
  perform public._ops_log(p_actor, 'product.bulk_menu', 'restaurant', p_restaurant::text, zone, null, null,
                          result || jsonb_build_object('filename', fname), p_client_action_id);
  return result;
end;
$$;

-- 4. Replacing a dish photo ----------------------------------------------------------------
-- p_review_change: the queued vendor photo the manager was looking at, if any.
-- It is marked reviewed when it still is unreviewed; a later vendor photo in
-- between does not stop the replace (the manager's photo is the newest anyway).
create or replace function public.ops_replace_listing_photo(
  p_actor uuid, p_item uuid, p_image_url text, p_library_id uuid, p_source text, p_review_change bigint,
  p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  z        record;
  was      text;
  url      constant text := nullif(trim(coalesce(p_image_url, '')), '');
  resolved integer := 0;
  result   jsonb;
begin
  select * into z from public._ops_item_zone(p_item);
  if z.restaurant_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, z.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    select jsonb_build_object('item_id', p_item, 'resolved_flags', coalesce((after ->> 'resolvedFlags')::integer, 0))
      into result from public.ops_audit_log where client_action_id = p_client_action_id and actor_id = p_actor;
    return result;
  end if;
  if p_source is null or p_source not in ('upload', 'library')
     or url is null or char_length(url) > 2000 or url !~ '^https://'
     or (p_source = 'library' and p_library_id is null) then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  select image_url into was from public.menu_items where id = p_item for update;
  perform set_config('deligro.ops_moderation', 'on', true);
  perform public._ops_set_actor(p_actor, 'Photo replaced');
  update public.menu_items
     set image_url = url,
         image_library_id = case when p_source = 'library' then p_library_id end
   where id = p_item;
  perform set_config('deligro.ops_moderation', '', true);

  if p_review_change is not null then
    insert into public.listing_image_reviews (change_id, menu_item_id, outcome, note, reviewed_by)
    select c.id, c.menu_item_id, 'ok', 'replaced', p_actor
      from public.menu_item_changes c
     where c.id = p_review_change and c.menu_item_id = p_item and c.field = 'image_url'
       and not exists (select 1 from public.listing_image_reviews v where v.change_id = c.id);
  end if;

  update public.listing_flags
     set status = 'resolved', resolution = 'Photo replaced by Deligro', resolved_by = p_actor, resolved_at = now()
   where menu_item_id = p_item and reason = 'wrong_image' and status = 'open';
  get diagnostics resolved = row_count;

  perform public._ops_log(p_actor, 'product.photo_replace', 'product', p_item::text, z.zone_id, null,
                          jsonb_build_object('imageUrl', was),
                          jsonb_build_object('imageUrl', url, 'source', p_source, 'libraryId', p_library_id,
                                             'resolvedFlags', resolved),
                          p_client_action_id);
  return jsonb_build_object('item_id', p_item, 'resolved_flags', resolved);
end;
$$;

revoke execute on function public.guard_menu_item_submitted_by() from public;
revoke execute on function public.ops_bulk_menu_apply(uuid, uuid, jsonb, jsonb, text, text) from public, anon, authenticated;
revoke execute on function public.ops_replace_listing_photo(uuid, uuid, text, uuid, text, bigint, text) from public, anon, authenticated;
revoke execute on function public.ops_decide_listing(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.ops_bulk_menu_apply(uuid, uuid, jsonb, jsonb, text, text) to service_role;
grant execute on function public.ops_replace_listing_photo(uuid, uuid, text, uuid, text, bigint, text) to service_role;
grant execute on function public.ops_decide_listing(uuid, uuid, text, text, text) to service_role;

commit;
