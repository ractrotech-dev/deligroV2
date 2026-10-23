-- ============================================================
-- 0160 — Marketing for managers: requests decided once, campaigns, tracking
-- ------------------------------------------------------------
-- STATUS: PENDING APPROVAL. Not applied to any database. Deploy order:
-- 0061 → 0063 → 0064 → 0081 … 0087 → 0141 … 0158 → 0160. Needs 0064
-- (marketing_requests, marketing_request_updates) and 0142 (ops_require_staff,
-- _ops_set_actor, _ops_replayed, _ops_log).
--
-- What it adds:
--   * marketing_requests (0064's table — this does NOT create a second one):
--     zone_id (stamped from the shop, never from a writer), source
--     ('vendor' | 'ops' — a manager recording a request after a phone call),
--     menu_item_ids, proposed_offer, attachment_path, decided_by/at,
--     campaign_id, offer_code, and the kind 'other'. A zone-scoped manager
--     read policy on it and on its timeline. marketing_request_updates may now
--     carry actor_role 'manager' and 'system' (the scheduler).
--   * campaigns (+ campaign_vendors, campaign_items, campaign_events): the
--     scheduled promotion a request turns into, or one Deligro runs itself.
--     Customer-facing effects are computed from the window at read time; the
--     stored status only records what happened.
--   * banner_events.customer_id, for attribution of banner clicks.
--   * Audited RPCs (service role only; each re-checks the actor's zone and
--     writes its change and its ops_audit_log row in one transaction):
--     ops_create_marketing_request, ops_decide_marketing_request,
--     ops_progress_marketing_request, ops_create_campaign, ops_update_campaign,
--     ops_campaign_action, ops_sync_campaign_states (scheduler, no actor).
--   * _ops_create_offer_internal: a stub here, replaced by 0161's real body.
--
-- Kinds: 0064 stores featured / banner / discount_offer / festival_campaign /
-- sponsored_product; campaigns store featured_store / banner / seasonal /
-- sponsored_product. src/lib/ops/marketing-contract.ts translates.
--
-- Rollback:
--   drop function if exists public.ops_sync_campaign_states(timestamptz), public.ops_campaign_action(uuid, uuid, text, text, text),
--     public.ops_update_campaign(uuid, uuid, timestamptz, jsonb, text, text), public.ops_create_campaign(uuid, jsonb, text),
--     public.ops_progress_marketing_request(uuid, uuid, text, text, text),
--     public.ops_decide_marketing_request(uuid, uuid, text, text, text, jsonb, jsonb, text),
--     public.ops_create_marketing_request(uuid, uuid, text, text, text, date, date, integer, uuid[], jsonb, text),
--     public._ops_create_offer_internal(uuid, jsonb, uuid), public._ops_campaign_create(uuid, jsonb),
--     public._ops_campaign_offer_apply(uuid, uuid, text), public._ops_campaign_request_check(uuid, uuid, uuid[], text, integer, text, uuid),
--     public._ops_campaign_validate(jsonb, uuid, boolean), public._ops_campaign_sync_banner(uuid),
--     public._ops_campaign_state(uuid, boolean), public._ops_marketing_request_state(uuid, boolean),
--     public._ops_marketing_kind(text), public.stamp_marketing_request_zone(), public.campaign_zone(uuid);
--   drop table if exists public.campaign_events, public.campaign_items, public.campaign_vendors, public.campaigns;
--   alter table public.banner_events drop column if exists customer_id;
--   alter table public.marketing_requests drop column if exists zone_id, drop column if exists source,
--     drop column if exists menu_item_ids, drop column if exists proposed_offer, drop column if exists attachment_path,
--     drop column if exists decided_by, drop column if exists decided_at, drop column if exists campaign_id,
--     drop column if exists offer_code;
--   -- and restore 0064's kind and actor_role checks.
-- ============================================================

begin;

-- 1. marketing_requests: what the manager side needs ---------------------------
alter table public.marketing_requests
  add column if not exists zone_id         uuid references public.delivery_zones (id) on delete set null,
  add column if not exists source          text not null default 'vendor',
  add column if not exists menu_item_ids   uuid[] not null default '{}',
  add column if not exists proposed_offer  jsonb,
  add column if not exists attachment_path text,
  add column if not exists decided_by      uuid references public.profiles (id) on delete set null,
  add column if not exists decided_at      timestamptz,
  add column if not exists campaign_id     uuid,
  add column if not exists offer_code      text;

alter table public.marketing_requests drop constraint if exists marketing_requests_kind_check;
alter table public.marketing_requests add constraint marketing_requests_kind_check
  check (kind in ('featured', 'banner', 'discount_offer', 'festival_campaign', 'sponsored_product', 'other'));
alter table public.marketing_requests drop constraint if exists marketing_requests_source_check;
alter table public.marketing_requests add constraint marketing_requests_source_check
  check (source in ('vendor', 'ops'));
alter table public.marketing_requests drop constraint if exists marketing_requests_items_check;
alter table public.marketing_requests add constraint marketing_requests_items_check
  check (cardinality(menu_item_ids) <= 20);

alter table public.marketing_request_updates drop constraint if exists marketing_request_updates_actor_role_check;
alter table public.marketing_request_updates add constraint marketing_request_updates_actor_role_check
  check (actor_role in ('vendor', 'admin', 'manager', 'system'));

create index if not exists marketing_requests_zone_status_idx on public.marketing_requests (zone_id, status, created_at desc);

-- The zone is the shop's, always: a writer cannot file a request into another zone.
create or replace function public.stamp_marketing_request_zone()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select r.zone_id into new.zone_id from public.restaurants r where r.id = new.restaurant_id;
  return new;
end;
$$;
drop trigger if exists stamp_marketing_request_zone on public.marketing_requests;
create trigger stamp_marketing_request_zone before insert or update on public.marketing_requests
  for each row execute function public.stamp_marketing_request_zone();

update public.marketing_requests m set zone_id = r.zone_id
  from public.restaurants r where r.id = m.restaurant_id and m.zone_id is distinct from r.zone_id;

drop policy if exists "marketing_requests — manager read" on public.marketing_requests;
create policy "marketing_requests — manager read" on public.marketing_requests for select
  using (public.is_manager() and public.manager_can_see_zone(zone_id));
drop policy if exists "marketing_request_updates — manager read" on public.marketing_request_updates;
create policy "marketing_request_updates — manager read" on public.marketing_request_updates for select
  using (public.is_manager() and exists (
    select 1 from public.marketing_requests m where m.id = request_id and public.manager_can_see_zone(m.zone_id)));

-- 2. Campaigns -------------------------------------------------------------------
create table if not exists public.campaigns (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('featured_store', 'banner', 'seasonal', 'sponsored_product')),
  title            text not null check (char_length(btrim(title)) between 3 and 80),
  zone_id          uuid not null references public.delivery_zones (id) on delete restrict,
  restaurant_id    uuid references public.restaurants (id) on delete cascade,
  status           text not null default 'approved' check (status in ('approved', 'in_progress', 'completed', 'cancelled')),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  budget           integer check (budget is null or budget between 0 and 10000000),
  funded_by        text not null check (funded_by in ('vendor', 'deligro', 'shared')),
  vendor_share_pct smallint,
  slot_position    smallint check (slot_position is null or slot_position between 1 and 10),
  banner_id        uuid references public.banners (id) on delete set null,
  offer_code       text references public.coupons (code) on delete set null on update cascade,
  request_id       uuid references public.marketing_requests (id) on delete set null,
  notes            text check (notes is null or char_length(notes) <= 1000),
  created_by       uuid not null references public.profiles (id) on delete restrict,
  cancelled_reason text,
  cancelled_by     uuid references public.profiles (id) on delete set null,
  cancelled_at     timestamptz,
  -- A seasonal campaign's code runs for the campaign's window. What the code's
  -- window was before the link is kept here, so cancelling puts it back.
  offer_prev_starts_at  timestamptz,
  offer_prev_expires_at timestamptz,
  offer_window_saved    boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint campaigns_window check (ends_at > starts_at),
  constraint campaigns_share check ((funded_by = 'shared') = (vendor_share_pct is not null and vendor_share_pct between 1 and 99)),
  constraint campaigns_slot check ((kind = 'featured_store') = (slot_position is not null))
);
create index if not exists campaigns_zone_window_idx on public.campaigns (zone_id, starts_at, ends_at);
create index if not exists campaigns_status_idx on public.campaigns (status, ends_at);
create index if not exists campaigns_restaurant_idx on public.campaigns (restaurant_id, starts_at desc);
create index if not exists campaigns_created_idx on public.campaigns (created_at desc, id desc);

create table if not exists public.campaign_vendors (
  campaign_id   uuid not null references public.campaigns (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  primary key (campaign_id, restaurant_id)
);
create index if not exists campaign_vendors_restaurant_idx on public.campaign_vendors (restaurant_id);

create table if not exists public.campaign_items (
  campaign_id  uuid not null references public.campaigns (id) on delete cascade,
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  primary key (campaign_id, menu_item_id)
);
create index if not exists campaign_items_item_idx on public.campaign_items (menu_item_id);

create table if not exists public.campaign_events (
  id           bigint generated always as identity primary key,
  campaign_id  uuid not null references public.campaigns (id) on delete cascade,
  kind         text not null check (kind in ('impression', 'click')),
  customer_id  uuid references public.profiles (id) on delete set null,
  menu_item_id uuid,
  created_at   timestamptz not null default now()
);
create index if not exists campaign_events_campaign_idx on public.campaign_events (campaign_id, kind, created_at);
create index if not exists campaign_events_customer_idx on public.campaign_events (customer_id, created_at)
  where customer_id is not null;

comment on table public.campaigns is
  'A scheduled promotion (featured store slot, banner, seasonal push, sponsored dishes). Customer surfaces read the window, not status. 0160.';
comment on table public.campaign_events is
  'Impressions and clicks of campaign surfaces, written only by the server track route (service role). 0160.';

create or replace function public.campaign_zone(p_campaign uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select zone_id from public.campaigns where id = p_campaign;
$$;
revoke execute on function public.campaign_zone(uuid) from public, anon;
grant execute on function public.campaign_zone(uuid) to authenticated, service_role;

alter table public.campaigns enable row level security;
alter table public.campaign_vendors enable row level security;
alter table public.campaign_items enable row level security;
alter table public.campaign_events enable row level security;

drop policy if exists "campaigns — staff read" on public.campaigns;
create policy "campaigns — staff read" on public.campaigns for select
  using (public.is_admin() or (public.is_manager() and public.manager_can_see_zone(zone_id)));
drop policy if exists "campaigns — vendor read" on public.campaigns;
create policy "campaigns — vendor read" on public.campaigns for select
  using (public.owns_restaurant(restaurant_id));
drop policy if exists "campaign_vendors — staff read" on public.campaign_vendors;
create policy "campaign_vendors — staff read" on public.campaign_vendors for select
  using (public.is_admin() or (public.is_manager() and public.manager_can_see_zone(public.campaign_zone(campaign_id))));
drop policy if exists "campaign_items — staff read" on public.campaign_items;
create policy "campaign_items — staff read" on public.campaign_items for select
  using (public.is_admin() or (public.is_manager() and public.manager_can_see_zone(public.campaign_zone(campaign_id))));
drop policy if exists "campaign_events — staff read" on public.campaign_events;
create policy "campaign_events — staff read" on public.campaign_events for select
  using (public.is_admin() or (public.is_manager() and public.manager_can_see_zone(public.campaign_zone(campaign_id))));

revoke all on public.campaigns, public.campaign_vendors, public.campaign_items, public.campaign_events from anon, authenticated;
grant select on public.campaigns, public.campaign_vendors, public.campaign_items, public.campaign_events to authenticated;
grant select, insert, update, delete on public.campaigns, public.campaign_vendors, public.campaign_items, public.campaign_events
  to service_role;

-- Banner clicks carry the signed-in customer, for 24 h attribution.
alter table public.banner_events add column if not exists customer_id uuid references public.profiles (id) on delete set null;
create index if not exists banner_events_banner_kind_created_idx on public.banner_events (banner_id, kind, created_at);
create index if not exists banner_events_customer_idx on public.banner_events (customer_id, created_at)
  where customer_id is not null;

-- Buckets: banner art is public (the storefront shows it); request attachments
-- are private. Writes are the server's (service role) only.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('banner-images', 'banner-images', true, 2097152, array['image/jpeg', 'image/png'])
      on conflict (id) do nothing;
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('marketing-attachments', 'marketing-attachments', false, 5242880,
              array['image/jpeg', 'image/png', 'application/pdf'])
      on conflict (id) do nothing;
  end if;
end $$;

-- 3. Helpers ----------------------------------------------------------------------
-- 0064 kind → campaign kind (null = no campaign: discount_offer, other).
create or replace function public._ops_marketing_kind(p_kind text)
returns text
language sql immutable as $$
  select case p_kind
    when 'featured' then 'featured_store'
    when 'banner' then 'banner'
    when 'festival_campaign' then 'seasonal'
    when 'sponsored_product' then 'sponsored_product'
  end;
$$;

create or replace function public._ops_marketing_request_state(p_request uuid, p_replayed boolean default false)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('request_id', m.id, 'status', m.status, 'campaign_id', m.campaign_id,
                            'offer_code', m.offer_code, 'replayed', p_replayed)
    from public.marketing_requests m where m.id = p_request;
$$;
revoke execute on function public._ops_marketing_request_state(uuid, boolean) from public, anon, authenticated, service_role;

create or replace function public._ops_campaign_state(p_campaign uuid, p_replayed boolean default false)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('campaign_id', c.id, 'status', c.status, 'updated_at', c.updated_at, 'replayed', p_replayed)
    from public.campaigns c where c.id = p_campaign;
$$;
revoke execute on function public._ops_campaign_state(uuid, boolean) from public, anon, authenticated, service_role;

-- A timeline row for a request (0064's table), in the caller's transaction.
create or replace function public._ops_marketing_note(p_request uuid, p_status text, p_remarks text, p_actor uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  r text;
begin
  select case p.role::text when 'restaurant' then 'vendor' when 'admin' then 'admin' when 'manager' then 'manager' else 'system' end
    into r from public.profiles p where p.id = p_actor;
  insert into public.marketing_request_updates (request_id, status, remarks, actor_id, actor_role)
  values (p_request, p_status, left(nullif(trim(p_remarks), ''), 1000), p_actor, coalesce(r, 'system'));
end;
$$;
revoke execute on function public._ops_marketing_note(uuid, text, text, uuid) from public, anon, authenticated, service_role;

-- Validate a CampaignInput (jsonb, the contract's camelCase keys). Raises the
-- contract's error codes; returns nothing. p_existing = the campaign being
-- edited (excluded from the slot check), null when creating.
create or replace function public._ops_campaign_validate(p_in jsonb, p_existing uuid, p_check_start boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  k          constant text := p_in ->> 'kind';
  zone       constant uuid := nullif(p_in ->> 'zoneId', '')::uuid;
  starts     constant timestamptz := (p_in ->> 'startsAt')::timestamptz;
  ends       constant timestamptz := (p_in ->> 'endsAt')::timestamptz;
  funded     constant text := p_in ->> 'fundedBy';
  share      constant integer := nullif(p_in ->> 'vendorSharePct', '')::integer;
  slot       constant integer := nullif(p_in ->> 'slotPosition', '')::integer;
  vendors    uuid[];
  items      uuid[];
  n_vendors  integer;
  bad        integer;
begin
  select coalesce(array_agg(v::uuid), '{}') into vendors from jsonb_array_elements_text(coalesce(p_in -> 'vendorIds', '[]')) v;
  select coalesce(array_agg(v::uuid), '{}') into items from jsonb_array_elements_text(coalesce(p_in -> 'itemIds', '[]')) v;
  n_vendors := cardinality(vendors);

  if k is null or k not in ('featured_store', 'banner', 'seasonal', 'sponsored_product') then
    raise exception 'bad_request' using errcode = '22023', detail = 'kind';
  end if;
  if char_length(btrim(coalesce(p_in ->> 'title', ''))) not between 3 and 80 then
    raise exception 'bad_request' using errcode = '22023', detail = 'title';
  end if;
  if zone is null or not exists (select 1 from public.delivery_zones z where z.id = zone) then
    raise exception 'bad_request' using errcode = '22023', detail = 'zoneId';
  end if;
  if starts is null or ends is null or ends <= starts or ends > starts + interval '180 days' then
    raise exception 'bad_request' using errcode = '22023', detail = 'endsAt';
  end if;
  if p_check_start and starts < now() - interval '5 minutes' then
    raise exception 'bad_request' using errcode = '22023', detail = 'startsAt';
  end if;
  if funded is null or funded not in ('vendor', 'deligro', 'shared') then
    raise exception 'bad_request' using errcode = '22023', detail = 'fundedBy';
  end if;
  if (funded = 'shared') <> (share is not null and share between 1 and 99) then
    raise exception 'bad_request' using errcode = '22023', detail = 'vendorSharePct';
  end if;
  if (p_in ->> 'budget') is not null and (p_in ->> 'budget')::numeric not between 0 and 10000000 then
    raise exception 'bad_request' using errcode = '22023', detail = 'budget';
  end if;
  if (k = 'featured_store') <> (slot is not null) or (slot is not null and slot not between 1 and 10) then
    raise exception 'bad_request' using errcode = '22023', detail = 'slotPosition';
  end if;
  if (k in ('featured_store', 'sponsored_product') and n_vendors <> 1)
     or (k = 'banner' and n_vendors > 1) or (k = 'seasonal' and n_vendors > 50) then
    raise exception 'bad_request' using errcode = '22023', detail = 'vendorIds';
  end if;
  if (k = 'sponsored_product' and cardinality(items) not between 1 and 20)
     or (k <> 'sponsored_product' and cardinality(items) > 0) then
    raise exception 'bad_request' using errcode = '22023', detail = 'itemIds';
  end if;
  if k in ('banner', 'seasonal') then
    if p_in -> 'banner' is null or jsonb_typeof(p_in -> 'banner') <> 'object'
       or char_length(btrim(coalesce(p_in #>> '{banner,headline}', ''))) not between 1 and 60
       or char_length(coalesce(p_in #>> '{banner,description}', '')) > 140
       or char_length(btrim(coalesce(p_in #>> '{banner,ctaLabel}', ''))) not between 1 and 20
       or coalesce(p_in #>> '{banner,targetType}', '') not in ('restaurant', 'product', 'category', 'food', 'external') then
      raise exception 'bad_request' using errcode = '22023', detail = 'banner';
    end if;
  end if;

  -- Every vendor must be a shop in the campaign's zone; every dish one of the vendor's.
  select count(*) into bad from unnest(vendors) v
   where not exists (select 1 from public.restaurants r where r.id = v and r.zone_id = zone);
  if bad > 0 then
    raise exception 'out_of_scope' using errcode = '42501', detail = 'vendorIds';
  end if;
  select count(*) into bad from unnest(items) i
   where not exists (select 1 from public.menu_items mi where mi.id = i and mi.restaurant_id = vendors[1]);
  if bad > 0 then
    raise exception 'out_of_scope' using errcode = '42501', detail = 'itemIds';
  end if;

  -- One featured slot per zone at a time. The advisory lock serialises two
  -- managers picking the same slot at the same moment.
  if k = 'featured_store' then
    perform pg_advisory_xact_lock(hashtextextended('featured-slot:' || zone::text, 0));
    if exists (select 1 from public.campaigns c
                where c.kind = 'featured_store' and c.zone_id = zone and c.slot_position = slot
                  and c.status in ('approved', 'in_progress')
                  and c.starts_at < ends and c.ends_at > starts
                  and (p_existing is null or c.id <> p_existing)) then
      raise exception 'slot_taken' using errcode = '23505',
        detail = (select c.id::text from public.campaigns c
                   where c.kind = 'featured_store' and c.zone_id = zone and c.slot_position = slot
                     and c.status in ('approved', 'in_progress') and c.starts_at < ends and c.ends_at > starts
                     and (p_existing is null or c.id <> p_existing) limit 1);
    end if;
  end if;
end;
$$;
revoke execute on function public._ops_campaign_validate(jsonb, uuid, boolean) from public, anon, authenticated, service_role;

-- Keep the campaign's banner (if it owns one) in step with the campaign.
create or replace function public._ops_campaign_sync_banner(p_campaign uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  c record;
begin
  select cp.*, z.slug as zone_slug, r.name as shop_name into c
    from public.campaigns cp
    join public.delivery_zones z on z.id = cp.zone_id
    left join public.restaurants r on r.id = cp.restaurant_id
   where cp.id = p_campaign;
  if c.banner_id is null then return; end if;
  update public.banners
     set starts_at = c.starts_at, ends_at = c.ends_at,
         status = case when c.status in ('completed', 'cancelled') then 'archived' else 'active' end,
         kind = case when c.funded_by in ('vendor', 'shared') then 'sponsored' else 'internal' end,
         sponsor_name = case when c.funded_by in ('vendor', 'shared') then c.shop_name end,
         target_zones = array[c.zone_slug], updated_at = now()
   where id = c.banner_id;
end;
$$;
revoke execute on function public._ops_campaign_sync_banner(uuid) from public, anon, authenticated, service_role;

-- 0161 replaces this with the real offer writer.
create or replace function public._ops_create_offer_internal(p_actor uuid, p_terms jsonb, p_request uuid)
returns text
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'offers_not_ready' using errcode = '0A000';
end;
$$;
revoke execute on function public._ops_create_offer_internal(uuid, jsonb, uuid) from public, anon, authenticated, service_role;

-- A seasonal campaign's linked code: 'link' (take over the code's window, after
-- checking the code is wholly inside the campaign's zone), 'sync' (the campaign's
-- dates moved), 'restore' (put the original window back), 'expire' (the campaign
-- was ended early). Each change is audited as offer.update. 0161 replaces this
-- with the real body; here, no code can be linked yet.
create or replace function public._ops_campaign_offer_apply(p_actor uuid, p_campaign uuid, p_action text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.campaigns where id = p_campaign and offer_code is not null) then
    raise exception 'offers_not_ready' using errcode = '0A000';
  end if;
end;
$$;
revoke execute on function public._ops_campaign_offer_apply(uuid, uuid, text) from public, anon, authenticated, service_role;

-- A request may back a campaign only when it is in the campaign's zone, is
-- approved (or being worked), is for the same kind of promotion and the same
-- shop, and has not been used already. A campaign the vendor pays for (wholly
-- or in part) also needs a request at all, and stays within the request's budget:
-- a vendor pays only for what it asked for, once. p_campaign = the campaign being
-- edited (its own link is not "already used"), null when creating. The request row
-- is locked, so two managers cannot both spend one consent.
create or replace function public._ops_campaign_request_check(
  p_req uuid, p_zone uuid, p_vendors uuid[], p_kind text, p_budget integer, p_funded text, p_campaign uuid
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  req  record;
  paid constant boolean := p_funded in ('vendor', 'shared');
begin
  if p_req is null then
    if paid then
      raise exception 'consent_required' using errcode = '42501';
    end if;
    return;
  end if;
  select id, restaurant_id, zone_id, kind, status, budget, campaign_id into req
    from public.marketing_requests where id = p_req for update;
  if req.id is null or req.zone_id is distinct from p_zone then
    raise exception 'out_of_scope' using errcode = '42501', detail = 'requestId';
  end if;
  if req.status not in ('approved', 'in_progress')
     or (req.campaign_id is not null and req.campaign_id is distinct from p_campaign)
     or public._ops_marketing_kind(req.kind) is distinct from p_kind
     or cardinality(p_vendors) <> 1 or p_vendors[1] <> req.restaurant_id then
    if paid then
      raise exception 'consent_required' using errcode = '42501';
    end if;
    raise exception 'bad_request' using errcode = '22023', detail = 'requestId';
  end if;
  if paid and req.budget is not null and (p_budget is null or p_budget > req.budget) then
    raise exception 'consent_required' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function public._ops_campaign_request_check(uuid, uuid, uuid[], text, integer, text, uuid)
  from public, anon, authenticated, service_role;

-- Insert a validated campaign and everything it owns. The caller has checked
-- the actor's zone and handled replay; the request and consent are checked here.
create or replace function public._ops_campaign_create(p_actor uuid, p_in jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  k        constant text := p_in ->> 'kind';
  zone     constant uuid := (p_in ->> 'zoneId')::uuid;
  funded   constant text := p_in ->> 'fundedBy';
  req_id   constant uuid := nullif(p_in ->> 'requestId', '')::uuid;
  vendors  uuid[];
  new_id   uuid;
  ban_id   uuid;
  v_code   text := nullif(upper(trim(coalesce(p_in ->> 'offerCode', ''))), '');
  starts   constant timestamptz := (p_in ->> 'startsAt')::timestamptz;
  ends     constant timestamptz := (p_in ->> 'endsAt')::timestamptz;
begin
  select coalesce(array_agg(v::uuid), '{}') into vendors from jsonb_array_elements_text(coalesce(p_in -> 'vendorIds', '[]')) v;

  -- The request (if any) is this zone's, approved, of this kind, for this shop and
  -- unused; a vendor-funded campaign needs one and stays within its budget.
  perform public._ops_campaign_request_check(req_id, zone, vendors, k, nullif(p_in ->> 'budget', '')::integer, funded, null);

  if v_code is not null and k <> 'seasonal' then
    raise exception 'bad_request' using errcode = '22023', detail = 'offerCode';
  end if;

  insert into public.campaigns (kind, title, zone_id, restaurant_id, starts_at, ends_at, budget, funded_by, vendor_share_pct,
                                slot_position, offer_code, request_id, notes, created_by,
                                status)
  values (k, btrim(p_in ->> 'title'), zone,
          case when k in ('featured_store', 'sponsored_product', 'banner') then vendors[1] end,
          starts, ends, nullif(p_in ->> 'budget', '')::integer, funded, nullif(p_in ->> 'vendorSharePct', '')::smallint,
          nullif(p_in ->> 'slotPosition', '')::smallint, v_code, req_id, nullif(btrim(coalesce(p_in ->> 'notes', '')), ''), p_actor,
          case when starts <= now() then 'in_progress' else 'approved' end)
  returning id into new_id;

  insert into public.campaign_vendors (campaign_id, restaurant_id) select new_id, v from unnest(vendors) v;
  insert into public.campaign_items (campaign_id, menu_item_id)
    select new_id, i::uuid from jsonb_array_elements_text(coalesce(p_in -> 'itemIds', '[]')) i;

  if k in ('banner', 'seasonal') then
    insert into public.banners (name, headline, description, cta_label, target_type, target_value, placements, image_url, status)
    values (btrim(p_in ->> 'title'), btrim(p_in #>> '{banner,headline}'), coalesce(p_in #>> '{banner,description}', ''),
            btrim(p_in #>> '{banner,ctaLabel}'), p_in #>> '{banner,targetType}', nullif(p_in #>> '{banner,targetValue}', ''),
            coalesce((select array_agg(x) from jsonb_array_elements_text(p_in #> '{banner,placements}') x), array['home_top']),
            nullif(p_in #>> '{banner,imageUrl}', ''), 'active')
    returning id into ban_id;
    update public.campaigns set banner_id = ban_id where id = new_id;
    perform public._ops_campaign_sync_banner(new_id);
  end if;

  -- A seasonal campaign's linked code runs for the campaign's window (checked,
  -- remembered and audited by the apply step).
  if v_code is not null then
    perform public._ops_campaign_offer_apply(p_actor, new_id, 'link');
  end if;

  return new_id;
end;
$$;
revoke execute on function public._ops_campaign_create(uuid, jsonb) from public, anon, authenticated, service_role;

-- 4. Requests --------------------------------------------------------------------
-- A manager records a request for a vendor (after a phone call).
create or replace function public.ops_create_marketing_request(
  p_actor uuid, p_restaurant uuid, p_type text, p_title text, p_details text,
  p_preferred_start date, p_preferred_end date, p_budget integer, p_items uuid[], p_proposed_offer jsonb,
  p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  zone  uuid;
  new_id uuid;
  db_kind constant text := case p_type when 'featured_store' then 'featured' when 'seasonal' then 'festival_campaign' else p_type end;
begin
  select zone_id into zone from public.restaurants where id = p_restaurant;
  if zone is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, zone);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['marketing.request_create'], null);
    select entity_id::uuid into new_id from public.ops_audit_log where client_action_id = p_client_action_id;
    return public._ops_marketing_request_state(new_id, true);
  end if;
  if db_kind is null or db_kind not in ('featured', 'banner', 'discount_offer', 'festival_campaign', 'sponsored_product', 'other') then
    raise exception 'bad_request' using errcode = '22023', detail = 'type';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 3 and 120 then
    raise exception 'bad_request' using errcode = '22023', detail = 'title';
  end if;
  if char_length(coalesce(p_details, '')) > 2000 then
    raise exception 'bad_request' using errcode = '22023', detail = 'details';
  end if;
  if p_preferred_start is not null and p_preferred_end is not null and p_preferred_end < p_preferred_start then
    raise exception 'bad_request' using errcode = '22023', detail = 'preferredEnd';
  end if;
  if exists (select 1 from unnest(coalesce(p_items, '{}')) i
              where not exists (select 1 from public.menu_items mi where mi.id = i and mi.restaurant_id = p_restaurant)) then
    raise exception 'out_of_scope' using errcode = '42501', detail = 'itemIds';
  end if;
  if p_proposed_offer is not null and db_kind <> 'discount_offer' then
    raise exception 'bad_request' using errcode = '22023', detail = 'proposedOffer';
  end if;

  insert into public.marketing_requests (restaurant_id, requested_by, kind, title, details, budget, starts_on, ends_on,
                                         source, menu_item_ids, proposed_offer)
  values (p_restaurant, p_actor, db_kind, btrim(p_title), coalesce(p_details, ''), p_budget, p_preferred_start, p_preferred_end,
          'ops', coalesce(p_items, '{}'), p_proposed_offer)
  returning id into new_id;
  perform public._ops_marketing_note(new_id, 'pending', 'Recorded on the vendor''s behalf', p_actor);
  perform public._ops_log(p_actor, 'marketing.request_create', 'marketing_request', new_id::text, zone, null,
    null, jsonb_build_object('type', db_kind, 'title', btrim(p_title), 'source', 'ops'), p_client_action_id);
  return public._ops_marketing_request_state(new_id, false);
end;
$$;

-- Approve or reject a pending request. Approving a campaign type creates the
-- campaign in the same transaction; approving a discount offer creates the code.
create or replace function public.ops_decide_marketing_request(
  p_actor uuid, p_request uuid, p_decision text, p_expected text, p_remarks text,
  p_campaign jsonb, p_offer jsonb, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m         record;
  remarks   constant text := nullif(trim(coalesce(p_remarks, '')), '');
  ck        text;
  camp      jsonb;
  camp_id   uuid;
  v_code    text;
begin
  select * into m from public.marketing_requests where id = p_request for update;
  if m.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, m.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id,
      array['marketing.request_approve', 'marketing.request_reject'], p_request::text);
    return public._ops_marketing_request_state(p_request, true);
  end if;
  if p_decision not in ('approve', 'reject') then
    raise exception 'bad_request' using errcode = '22023', detail = 'decision';
  end if;
  if m.status <> coalesce(p_expected, '') or m.status <> 'pending' then
    raise exception 'stale' using errcode = '40001', detail = m.status;
  end if;
  if remarks is not null and char_length(remarks) > 1000 then
    raise exception 'bad_request' using errcode = '22023', detail = 'remarks';
  end if;

  if p_decision = 'reject' then
    if remarks is null or char_length(remarks) < 3 then
      raise exception 'reason_required' using errcode = '22023';
    end if;
    update public.marketing_requests
       set status = 'rejected', admin_remarks = remarks, decided_by = p_actor, decided_at = now(), updated_at = now()
     where id = p_request;
    perform public._ops_marketing_note(p_request, 'rejected', remarks, p_actor);
    perform public._ops_log(p_actor, 'marketing.request_reject', 'marketing_request', p_request::text, m.zone_id, remarks,
      jsonb_build_object('status', m.status), jsonb_build_object('status', 'rejected'), p_client_action_id);
    return public._ops_marketing_request_state(p_request, false);
  end if;

  -- Approve: the request is approved first, so the campaign's consent check sees it.
  update public.marketing_requests
     set status = 'approved', admin_remarks = remarks, decided_by = p_actor, decided_at = now(), updated_at = now()
   where id = p_request;

  -- The campaign (or code) may come with the approval, or later through
  -- ops_create_campaign / ops_upsert_offer naming this request.
  ck := public._ops_marketing_kind(m.kind);
  if ck is not null and p_campaign is not null then
    if jsonb_typeof(p_campaign) <> 'object' then
      raise exception 'bad_request' using errcode = '22023', detail = 'campaign';
    end if;
    -- A request backs a campaign for its own shop, in its own zone, whatever the body says.
    camp := p_campaign || jsonb_build_object('kind', ck, 'requestId', p_request, 'zoneId', m.zone_id,
                                              'vendorIds', jsonb_build_array(m.restaurant_id));
    perform public._ops_campaign_validate(camp, null, true);
    camp_id := public._ops_campaign_create(p_actor, camp);
    update public.marketing_requests
       set campaign_id = camp_id,
           status = case when (select starts_at from public.campaigns where id = camp_id) <= now() then 'in_progress' else 'approved' end
     where id = p_request;
  elsif m.kind = 'discount_offer' and p_offer is not null then
    if jsonb_typeof(p_offer) <> 'object' then
      raise exception 'bad_request' using errcode = '22023', detail = 'offer';
    end if;
    v_code := public._ops_create_offer_internal(p_actor,
      p_offer || jsonb_build_object('requestId', p_request, 'vendorIds', jsonb_build_array(m.restaurant_id)), p_request);
    update public.marketing_requests set offer_code = v_code where id = p_request;
  end if;

  perform public._ops_marketing_note(p_request, 'approved', remarks, p_actor);
  perform public._ops_log(p_actor, 'marketing.request_approve', 'marketing_request', p_request::text, m.zone_id, remarks,
    jsonb_build_object('status', m.status),
    jsonb_build_object('status', 'approved', 'campaign_id', camp_id, 'offer_code', v_code), p_client_action_id);
  return public._ops_marketing_request_state(p_request, false);
end;
$$;

-- A request with no campaign (type 'other', or approved without one) is moved
-- along by hand: approved → in_progress → completed.
create or replace function public.ops_progress_marketing_request(
  p_actor uuid, p_request uuid, p_status text, p_remarks text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m record;
  remarks constant text := nullif(trim(coalesce(p_remarks, '')), '');
begin
  select * into m from public.marketing_requests where id = p_request for update;
  if m.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, m.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['marketing.request_progress'], p_request::text);
    return public._ops_marketing_request_state(p_request, true);
  end if;
  if m.campaign_id is not null
     or not ((m.status = 'approved' and p_status = 'in_progress') or (m.status = 'in_progress' and p_status = 'completed')) then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  update public.marketing_requests set status = p_status, admin_remarks = coalesce(remarks, admin_remarks), updated_at = now()
   where id = p_request;
  perform public._ops_marketing_note(p_request, p_status, remarks, p_actor);
  perform public._ops_log(p_actor, 'marketing.request_progress', 'marketing_request', p_request::text, m.zone_id, remarks,
    jsonb_build_object('status', m.status), jsonb_build_object('status', p_status), p_client_action_id);
  return public._ops_marketing_request_state(p_request, false);
end;
$$;

-- 5. Campaigns -------------------------------------------------------------------
create or replace function public.ops_create_campaign(p_actor uuid, p_input jsonb, p_client_action_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  zone constant uuid := nullif(p_input ->> 'zoneId', '')::uuid;
  new_id uuid;
begin
  if zone is null then
    raise exception 'bad_request' using errcode = '22023', detail = 'zoneId';
  end if;
  perform public.ops_require_staff(p_actor, zone);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['campaign.create'], null);
    select entity_id::uuid into new_id from public.ops_audit_log where client_action_id = p_client_action_id;
    return public._ops_campaign_state(new_id, true);
  end if;
  perform public._ops_campaign_validate(p_input, null, true);
  new_id := public._ops_campaign_create(p_actor, p_input);
  -- A campaign created from a request moves the request along with it.
  update public.marketing_requests
     set campaign_id = new_id,
         status = case when (select starts_at from public.campaigns where id = new_id) <= now() then 'in_progress' else status end,
         updated_at = now()
   where id = nullif(p_input ->> 'requestId', '')::uuid and campaign_id is null;
  perform public._ops_log(p_actor, 'campaign.create', 'campaign', new_id::text, zone, null, null,
    (select to_jsonb(c) - 'created_at' - 'updated_at' from public.campaigns c where c.id = new_id), p_client_action_id);
  return public._ops_campaign_state(new_id, false);
end;
$$;

-- Before start anything but kind and request; after start only the end, the
-- budget, the notes and the banner's words — with a reason.
create or replace function public.ops_update_campaign(
  p_actor uuid, p_campaign uuid, p_expected_updated_at timestamptz, p_changes jsonb, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c        record;
  before_j jsonb;
  started  boolean;
  reason   constant text := nullif(trim(coalesce(p_reason, '')), '');
  merged   jsonb;
  k        text;
  vendors  jsonb;
  items    jsonb;
  old_banner jsonb;
  varr     uuid[];
  new_code text;
begin
  select * into c from public.campaigns where id = p_campaign for update;
  if c.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, c.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['campaign.update'], p_campaign::text);
    return public._ops_campaign_state(p_campaign, true);
  end if;
  if p_expected_updated_at is null or c.updated_at <> p_expected_updated_at then
    raise exception 'stale' using errcode = '40001', detail = c.updated_at::text;
  end if;
  if c.status in ('completed', 'cancelled') or c.ends_at <= now() then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'bad_request' using errcode = '22023', detail = 'changes';
  end if;
  if p_changes ? 'kind' or p_changes ? 'requestId' then
    raise exception 'locked_field' using errcode = '22023', detail = case when p_changes ? 'kind' then 'kind' else 'requestId' end;
  end if;
  -- Only these fields can change at all. The zone, the kind, the request and who
  -- created it never do: a campaign cannot be moved out of the zone that was checked.
  for k in select jsonb_object_keys(p_changes) loop
    if k not in ('title', 'startsAt', 'endsAt', 'budget', 'notes', 'banner', 'vendorIds', 'itemIds', 'slotPosition',
                 'fundedBy', 'vendorSharePct', 'offerCode') then
      raise exception 'locked_field' using errcode = '22023', detail = k;
    end if;
  end loop;
  started := c.starts_at <= now();
  if started then
    for k in select jsonb_object_keys(p_changes) loop
      if k not in ('endsAt', 'budget', 'notes', 'banner') then
        raise exception 'locked_field' using errcode = '22023', detail = k;
      end if;
    end loop;
    if reason is null or char_length(reason) < 3 or char_length(reason) > 300 then
      raise exception 'reason_required' using errcode = '22023';
    end if;
  end if;

  before_j := to_jsonb(c) - 'created_at' - 'updated_at';
  select coalesce(jsonb_agg(restaurant_id), '[]') into vendors from public.campaign_vendors where campaign_id = p_campaign;
  select coalesce(jsonb_agg(menu_item_id), '[]') into items from public.campaign_items where campaign_id = p_campaign;
  select jsonb_build_object('headline', b.headline, 'description', b.description, 'ctaLabel', b.cta_label,
                            'targetType', b.target_type, 'targetValue', b.target_value,
                            'imageUrl', b.image_url, 'placements', to_jsonb(b.placements))
    into old_banner from public.banners b where b.id = c.banner_id;
  merged := jsonb_build_object(
    'kind', c.kind, 'title', c.title, 'zoneId', c.zone_id, 'vendorIds', vendors, 'itemIds', items,
    'startsAt', c.starts_at, 'endsAt', c.ends_at, 'budget', c.budget, 'fundedBy', c.funded_by,
    'vendorSharePct', c.vendor_share_pct, 'slotPosition', c.slot_position, 'offerCode', c.offer_code,
    'requestId', c.request_id, 'notes', c.notes, 'banner', old_banner) || (p_changes - 'banner');
  if p_changes ? 'banner' then
    merged := jsonb_set(merged, '{banner}', coalesce(old_banner, '{}'::jsonb) || coalesce(p_changes -> 'banner', '{}'::jsonb));
  end if;
  -- A start already past is kept as it is; a new start must not be in the past.
  perform public._ops_campaign_validate(merged, p_campaign, (not started) and p_changes ? 'startsAt');
  if started and (merged ->> 'endsAt')::timestamptz <= now() then
    raise exception 'bad_request' using errcode = '22023', detail = 'endsAt';
  end if;
  -- The edited campaign still has to satisfy its request and the vendor's consent
  -- (kind, shop, budget), and a vendor-funded campaign needs one.
  select coalesce(array_agg(v::uuid), '{}') into varr from jsonb_array_elements_text(coalesce(merged -> 'vendorIds', '[]')) v;
  perform public._ops_campaign_request_check(c.request_id, c.zone_id, varr, c.kind,
    nullif(merged ->> 'budget', '')::integer, merged ->> 'fundedBy', p_campaign);
  new_code := nullif(upper(trim(coalesce(merged ->> 'offerCode', ''))), '');
  if new_code is not null and c.kind <> 'seasonal' then
    raise exception 'bad_request' using errcode = '22023', detail = 'offerCode';
  end if;

  perform public._ops_set_actor(p_actor, reason);
  -- Leaving a code puts its original window back before the campaign forgets it.
  if c.offer_code is not null and new_code is distinct from c.offer_code then
    perform public._ops_campaign_offer_apply(p_actor, p_campaign, 'restore');
  end if;
  update public.campaigns
     set title = btrim(merged ->> 'title'),
         zone_id = (merged ->> 'zoneId')::uuid,
         restaurant_id = case when kind in ('featured_store', 'sponsored_product', 'banner')
                              then nullif(merged #>> '{vendorIds,0}', '')::uuid end,
         starts_at = (merged ->> 'startsAt')::timestamptz,
         ends_at = (merged ->> 'endsAt')::timestamptz,
         budget = nullif(merged ->> 'budget', '')::integer,
         funded_by = merged ->> 'fundedBy',
         vendor_share_pct = nullif(merged ->> 'vendorSharePct', '')::smallint,
         slot_position = nullif(merged ->> 'slotPosition', '')::smallint,
         offer_code = new_code,
         notes = nullif(btrim(coalesce(merged ->> 'notes', '')), ''),
         updated_at = now()
   where id = p_campaign;
  if p_changes ? 'vendorIds' then
    delete from public.campaign_vendors where campaign_id = p_campaign;
    insert into public.campaign_vendors (campaign_id, restaurant_id)
      select p_campaign, v::uuid from jsonb_array_elements_text(merged -> 'vendorIds') v;
  end if;
  if p_changes ? 'itemIds' then
    delete from public.campaign_items where campaign_id = p_campaign;
    insert into public.campaign_items (campaign_id, menu_item_id)
      select p_campaign, i::uuid from jsonb_array_elements_text(merged -> 'itemIds') i;
  end if;
  if c.banner_id is not null and p_changes ? 'banner' then
    update public.banners
       set headline = btrim(merged #>> '{banner,headline}'), description = coalesce(merged #>> '{banner,description}', ''),
           cta_label = btrim(merged #>> '{banner,ctaLabel}'), target_type = merged #>> '{banner,targetType}',
           target_value = nullif(merged #>> '{banner,targetValue}', ''),
           image_url = nullif(merged #>> '{banner,imageUrl}', ''),
           placements = coalesce((select array_agg(x) from jsonb_array_elements_text(merged #> '{banner,placements}') x), placements)
     where id = c.banner_id;
  end if;
  perform public._ops_campaign_sync_banner(p_campaign);
  -- A newly named code is checked and linked; an unchanged one follows the campaign's new dates.
  if new_code is not null then
    perform public._ops_campaign_offer_apply(p_actor, p_campaign,
      case when new_code is distinct from c.offer_code then 'link' else 'sync' end);
  end if;

  perform public._ops_log(p_actor, 'campaign.update', 'campaign', p_campaign::text, c.zone_id, reason, before_j,
    (select to_jsonb(x) - 'created_at' - 'updated_at' from public.campaigns x where x.id = p_campaign), p_client_action_id);
  return public._ops_campaign_state(p_campaign, false);
end;
$$;

-- cancel = before start; end_now = while running. Either archives the banner.
create or replace function public.ops_campaign_action(
  p_actor uuid, p_campaign uuid, p_action text, p_reason text, p_client_action_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c      record;
  reason constant text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into c from public.campaigns where id = p_campaign for update;
  if c.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.ops_require_staff(p_actor, c.zone_id);
  if public._ops_replayed(p_actor, p_client_action_id) then
    perform public._ops_replay_matches(p_client_action_id, array['campaign.cancel', 'campaign.end_now'], p_campaign::text);
    return public._ops_campaign_state(p_campaign, true);
  end if;
  if reason is null or char_length(reason) < 3 or char_length(reason) > 300 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  if p_action = 'cancel' then
    if c.status not in ('approved') or c.starts_at <= now() then
      raise exception 'invalid_transition' using errcode = '22023';
    end if;
    update public.campaigns
       set status = 'cancelled', cancelled_reason = reason, cancelled_by = p_actor, cancelled_at = now(), updated_at = now()
     where id = p_campaign;
    if c.request_id is not null then
      update public.marketing_requests
         set status = 'rejected', admin_remarks = left('Cancelled: ' || reason, 1000), updated_at = now()
       where id = c.request_id and status in ('approved', 'in_progress');
      if found then
        perform public._ops_marketing_note(c.request_id, 'rejected', 'Cancelled: ' || reason, p_actor);
      end if;
    end if;
    -- A linked code never ran for this campaign: it gets its own window back.
    perform public._ops_set_actor(p_actor, reason);
    perform public._ops_campaign_offer_apply(p_actor, p_campaign, 'restore');
  elsif p_action = 'end_now' then
    if c.status not in ('approved', 'in_progress') or c.starts_at > now() or c.ends_at <= now() then
      raise exception 'invalid_transition' using errcode = '22023';
    end if;
    update public.campaigns
       set status = 'completed', ends_at = now(), cancelled_reason = reason, cancelled_by = p_actor, cancelled_at = now(),
           updated_at = now()
     where id = p_campaign;
    if c.request_id is not null then
      update public.marketing_requests set status = 'completed', updated_at = now()
       where id = c.request_id and status in ('approved', 'in_progress');
      if found then
        perform public._ops_marketing_note(c.request_id, 'completed', 'Ended early: ' || reason, p_actor);
      end if;
    end if;
    perform public._ops_set_actor(p_actor, reason);
    perform public._ops_campaign_offer_apply(p_actor, p_campaign, 'expire');
  else
    raise exception 'bad_request' using errcode = '22023', detail = 'action';
  end if;

  perform public._ops_campaign_sync_banner(p_campaign);
  perform public._ops_log(p_actor, 'campaign.' || p_action, 'campaign', p_campaign::text, c.zone_id, reason,
    jsonb_build_object('status', c.status, 'ends_at', c.ends_at),
    (select jsonb_build_object('status', x.status, 'ends_at', x.ends_at) from public.campaigns x where x.id = p_campaign),
    p_client_action_id);
  return public._ops_campaign_state(p_campaign, false);
end;
$$;

-- The scheduler. Moves stored statuses (and linked requests) to match the
-- windows; customer surfaces never depend on it having run.
create or replace function public.ops_sync_campaign_states(p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  started uuid[];
  ended   uuid[];
  r       record;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('service_role', 'supabase_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with s as (
    update public.campaigns set status = 'in_progress', updated_at = now()
     where status = 'approved' and starts_at <= p_now and ends_at > p_now
    returning id)
  select coalesce(array_agg(id), '{}') into started from s;

  with e as (
    update public.campaigns set status = 'completed', updated_at = now()
     where status in ('approved', 'in_progress') and ends_at <= p_now
    returning id)
  select coalesce(array_agg(id), '{}') into ended from e;

  for r in
    update public.marketing_requests m set status = 'in_progress', updated_at = now()
      from public.campaigns c
     where c.id = m.campaign_id and c.id = any (started) and m.status = 'approved'
    returning m.id
  loop
    insert into public.marketing_request_updates (request_id, status, remarks, actor_id, actor_role)
    values (r.id, 'in_progress', 'Campaign started', null, 'system');
  end loop;

  for r in
    update public.marketing_requests m set status = 'completed', updated_at = now()
      from public.campaigns c
     where c.id = m.campaign_id and c.id = any (ended) and m.status in ('approved', 'in_progress')
    returning m.id
  loop
    insert into public.marketing_request_updates (request_id, status, remarks, actor_id, actor_role)
    values (r.id, 'completed', 'Campaign ended', null, 'system');
  end loop;

  update public.banners b set status = 'archived', updated_at = now()
    from public.campaigns c
   where c.banner_id = b.id and c.id = any (ended) and b.status <> 'archived';

  return jsonb_build_object('started', to_jsonb(started), 'ended', to_jsonb(ended));
end;
$$;

revoke execute on function public.ops_create_marketing_request(uuid, uuid, text, text, text, date, date, integer, uuid[], jsonb, text),
  public.ops_decide_marketing_request(uuid, uuid, text, text, text, jsonb, jsonb, text),
  public.ops_progress_marketing_request(uuid, uuid, text, text, text),
  public.ops_create_campaign(uuid, jsonb, text),
  public.ops_update_campaign(uuid, uuid, timestamptz, jsonb, text, text),
  public.ops_campaign_action(uuid, uuid, text, text, text),
  public.ops_sync_campaign_states(timestamptz)
  from public, anon, authenticated;
grant execute on function public.ops_create_marketing_request(uuid, uuid, text, text, text, date, date, integer, uuid[], jsonb, text),
  public.ops_decide_marketing_request(uuid, uuid, text, text, text, jsonb, jsonb, text),
  public.ops_progress_marketing_request(uuid, uuid, text, text, text),
  public.ops_create_campaign(uuid, jsonb, text),
  public.ops_update_campaign(uuid, uuid, timestamptz, jsonb, text, text),
  public.ops_campaign_action(uuid, uuid, text, text, text),
  public.ops_sync_campaign_states(timestamptz)
  to service_role;
revoke execute on function public._ops_marketing_kind(text) from public, anon, authenticated;

commit;
