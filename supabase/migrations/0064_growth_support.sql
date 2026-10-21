-- 0064 — Partner app: offers that start later, marketing requests, support
-- tickets, an in-app notification inbox and announcements (requirements §6,
-- §9, §12, §13).
--
-- STATUS: PENDING APPROVAL. Not applied anywhere. Validated in an in-process
-- Postgres (scripts/qa/sql/migration-0064.mjs); run it on staging first.
-- Design: docs/superpowers/specs/2026-10-21-vendor-app-design.md.
--
-- Shared tables. `support_tickets` / `support_messages` are created in the
-- exact shape the Rider plan (its 0087) and the Manager branch (0143) use, with
-- `create table if not exists` and `drop policy if exists`, so whichever of the
-- three is applied first creates them and the others converge. 0143 later
-- widens the status check (adds 'escalated') and adds its manager columns.
-- `user_notifications` and `announcements` follow the Rider plan's shape
-- without its `*_hi` columns: the Partner and Rider apps are both English-only.
--
-- Security changes (docs/SECURITY_AUDIT.md applies):
--   * coupons.starts_at: a code is refused before it starts, by price_coupon()
--     — the one function both preview and redemption use. The shop badge
--     (refresh_restaurant_offer) ignores codes that haven't started;
--     refresh_due_offers() (service role, called by the dispatch sweep) puts the
--     badge up once they do.
--   * marketing_requests, marketing_request_updates: RLS on; the shop's owner
--     and admins read; no client writes — the vendor and admin routes write
--     with the service role behind their role checks.
--   * support_tickets, support_messages: RLS on; a requester reads their own
--     tickets and only the non-internal messages; admins read all. No client
--     writes. Private bucket `support-attachments` (5 MB, jpeg/png, no storage
--     policies: read through signed URLs the server mints).
--   * user_notifications: the user reads their own rows and may update only
--     `read_at` (column grant + policy). Inserted only by the server.
--   * announcements: readable by signed-in users whose role matches the
--     audience while live; written only by admins (service role).
--
-- Rollback:
--   drop function if exists public.refresh_due_offers();
--   -- re-run price_coupon() and refresh_restaurant_offer() from 0041_vendor_coupons.sql
--   alter table public.coupons drop constraint if exists coupons_window, drop column if exists starts_at;
--   drop table if exists public.marketing_request_updates, public.marketing_requests;
--   drop table if exists public.announcements, public.user_notifications;
--   -- and, only if neither the Rider 0087 nor the Manager 0143 has been applied:
--   drop table if exists public.support_messages; drop table if exists public.support_tickets;
--   delete from storage.buckets where id = 'support-attachments';

-- 1. Offers that start later ---------------------------------------------------
alter table public.coupons add column if not exists starts_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.coupons'::regclass and conname = 'coupons_window') then
    alter table public.coupons add constraint coupons_window
      check (starts_at is null or expires_at is null or starts_at < expires_at);
  end if;
end $$;

comment on column public.coupons.starts_at is
  'When the code starts working (null = straight away). price_coupon() refuses it before then.';

-- 0041's price_coupon(), plus the start check.
create or replace function public.price_coupon(
  c        public.coupons,
  subtotal integer,
  rid      uuid,
  customer uuid
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  amount     integer;
  used_by_me integer;
  used_total integer;
begin
  if not c.active then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  -- 0064: not live yet.
  if c.starts_at is not null and c.starts_at > now() then
    return jsonb_build_object('ok', false, 'error', 'not_started');
  end if;
  if c.expires_at is not null and c.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  if c.restaurant_id is not null and c.restaurant_id is distinct from rid then
    return jsonb_build_object('ok', false, 'error', 'wrong_restaurant');
  end if;

  if subtotal < c.min_order then
    return jsonb_build_object(
      'ok', false, 'error', 'min_order', 'minOrder', c.min_order::integer);
  end if;

  if customer is not null and c.max_per_customer is not null then
    select count(*) into used_by_me from public.coupon_redemptions r
      where r.code = c.code and r.customer_id = customer;
    if used_by_me >= c.max_per_customer then
      return jsonb_build_object('ok', false, 'error', 'already_used');
    end if;
  end if;

  if c.max_redemptions is not null then
    select count(*) into used_total from public.coupon_redemptions r
      where r.code = c.code;
    if used_total >= c.max_redemptions then
      return jsonb_build_object('ok', false, 'error', 'exhausted');
    end if;
  end if;

  amount := case
    when c.kind = 'percent' then round(subtotal * c.value / 100.0)
    else round(c.value)
  end;
  if c.max_discount is not null then
    amount := least(amount, round(c.max_discount));
  end if;
  amount := greatest(0, least(amount, subtotal));

  return jsonb_build_object(
    'ok', true,
    'code', c.code,
    'discount', amount,
    'fundedBy', c.funded_by);
end;
$$;

revoke all on function public.price_coupon(public.coupons, integer, uuid, uuid)
  from public, anon, authenticated;

-- 0041's refresh_restaurant_offer(), counting only codes that have started.
create or replace function public.refresh_restaurant_offer(rid uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  c public.coupons%rowtype;
  txt text;
begin
  if rid is null then return; end if;

  select * into c
    from public.coupons
   where restaurant_id = rid
     and active
     and (starts_at is null or starts_at <= now())
     and (expires_at is null or expires_at > now())
     and (max_redemptions is null
          or max_redemptions > (select count(*) from public.coupon_redemptions r
                                 where r.code = coupons.code))
   order by
     (kind = 'percent' and max_discount is null) desc,
     coalesce(max_discount, value) desc,
     created_at desc
   limit 1;

  if not found then
    update public.restaurants
       set offer = null, offer_expires_at = null
     where id = rid;
    return;
  end if;

  txt := case c.kind
    when 'percent' then
      public.promo_amount_text(c.value) || '% OFF'
      || case when c.max_discount is not null
              then ' up to ₹' || public.promo_amount_text(c.max_discount)
              else '' end
    else
      '₹' || public.promo_amount_text(c.value) || ' OFF'
  end
  || case when c.min_order > 0
          then ' over ₹' || public.promo_amount_text(c.min_order)
          else '' end;

  update public.restaurants
     set offer = txt, offer_expires_at = c.expires_at
   where id = rid;
end;
$$;

revoke all on function public.refresh_restaurant_offer(uuid) from public, anon, authenticated;

-- Shops with a code that started in the last day get their badge recomputed.
-- Nothing fires at the moment a code starts, so the dispatch sweep calls this.
create or replace function public.refresh_due_offers()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select distinct restaurant_id from public.coupons
     where restaurant_id is not null and active
       and starts_at between now() - interval '1 day' and now()
  loop
    perform public.refresh_restaurant_offer(r.restaurant_id);
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.refresh_due_offers() from public, anon, authenticated;
grant execute on function public.refresh_due_offers() to service_role;

-- 2. Marketing requests --------------------------------------------------------
create table if not exists public.marketing_requests (
  id            uuid primary key default gen_random_uuid(),
  number        bigint generated always as identity unique,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  requested_by  uuid not null references public.profiles (id) on delete restrict,
  kind          text not null check (kind in ('banner', 'featured', 'discount_offer', 'social_media', 'push_campaign', 'other')),
  title         text not null check (char_length(btrim(title)) between 3 and 120),
  details       text not null check (char_length(details) <= 2000),
  budget        integer check (budget is null or budget between 0 and 10000000),
  starts_on     date,
  ends_on       date,
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'in_progress', 'completed', 'rejected', 'cancelled')),
  admin_remarks text check (admin_remarks is null or char_length(admin_remarks) <= 1000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint marketing_requests_window check (starts_on is null or ends_on is null or ends_on >= starts_on)
);

create index if not exists marketing_requests_restaurant_idx on public.marketing_requests (restaurant_id, created_at desc);
create index if not exists marketing_requests_status_idx on public.marketing_requests (status, created_at desc);

-- Every status change and remark, in order: the request's timeline.
create table if not exists public.marketing_request_updates (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.marketing_requests (id) on delete cascade,
  status     text not null,
  remarks    text check (remarks is null or char_length(remarks) <= 1000),
  actor_id   uuid references public.profiles (id) on delete set null,
  actor_role text not null check (actor_role in ('vendor', 'admin')),
  created_at timestamptz not null default now()
);

create index if not exists marketing_request_updates_request_idx on public.marketing_request_updates (request_id, created_at);

alter table public.marketing_requests enable row level security;
alter table public.marketing_request_updates enable row level security;

drop policy if exists "marketing_requests — owner read" on public.marketing_requests;
create policy "marketing_requests — owner read" on public.marketing_requests for select
  using (public.owns_restaurant(restaurant_id) or public.is_admin());

drop policy if exists "marketing_request_updates — owner read" on public.marketing_request_updates;
create policy "marketing_request_updates — owner read" on public.marketing_request_updates for select
  using (exists (
    select 1 from public.marketing_requests m
     where m.id = request_id and (public.owns_restaurant(m.restaurant_id) or public.is_admin())));

revoke all on public.marketing_requests, public.marketing_request_updates from anon, authenticated;
grant select on public.marketing_requests, public.marketing_request_updates to authenticated;
grant select, insert, update, delete on public.marketing_requests, public.marketing_request_updates to service_role;

-- 3. Support tickets (the shared 0087 shape) ------------------------------------
create table if not exists public.support_tickets (
  id              uuid primary key default gen_random_uuid(),
  number          bigint generated always as identity unique,
  requester_id    uuid not null references public.profiles (id) on delete cascade,
  requester_role  text not null,
  category        text not null,
  priority        text not null default 'normal' check (priority in ('normal', 'high', 'emergency')),
  subject         text not null,
  order_id        uuid references public.orders (id) on delete set null,
  cash_dispute_id uuid,
  lat             double precision,
  lng             double precision,
  status          text not null default 'open'
                  check (status in ('open', 'in_progress', 'waiting_on_requester', 'resolved', 'closed')),
  assigned_to     uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

create index if not exists support_tickets_requester_idx on public.support_tickets (requester_id, created_at desc);
create index if not exists support_tickets_status_idx on public.support_tickets (status, created_at desc);
create index if not exists support_tickets_order_idx on public.support_tickets (order_id);

create table if not exists public.support_messages (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references public.support_tickets (id) on delete cascade,
  author_id   uuid not null references public.profiles (id) on delete cascade,
  author_role text not null,
  body        text not null check (char_length(body) <= 4000),
  attachments text[] not null default '{}' check (cardinality(attachments) <= 4),
  internal    boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists support_messages_ticket_idx on public.support_messages (ticket_id, created_at);

comment on table public.support_tickets is
  'Support and incident tickets from riders, vendors, customers and ops. Written only through the server (service role).';
comment on column public.support_messages.internal is
  'Staff-only note. Never shown to the requester.';

alter table public.support_tickets  enable row level security;
alter table public.support_messages enable row level security;

drop policy if exists "support_tickets — requester read" on public.support_tickets;
create policy "support_tickets — requester read" on public.support_tickets for select
  using (requester_id = auth.uid() or public.is_admin());

drop policy if exists "support_messages — requester read" on public.support_messages;
create policy "support_messages — requester read" on public.support_messages for select
  using (
    public.is_admin()
    or (not internal and exists (
      select 1 from public.support_tickets t where t.id = ticket_id and t.requester_id = auth.uid()))
  );

revoke all on public.support_tickets, public.support_messages from anon, authenticated;
grant select on public.support_tickets, public.support_messages to authenticated;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('support-attachments', 'support-attachments', false, 5242880, array['image/jpeg', 'image/png'])
    on conflict (id) do nothing;
  end if;
end $$;

-- 4. Notification inbox ----------------------------------------------------------
create table if not exists public.user_notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null,
  category   text not null,
  title      text not null check (char_length(title) <= 200),
  body       text not null check (char_length(body) <= 1000),
  data       jsonb not null default '{}',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_notifications_user_idx on public.user_notifications (user_id, created_at desc);
create index if not exists user_notifications_unread_idx on public.user_notifications (user_id) where read_at is null;

alter table public.user_notifications enable row level security;

drop policy if exists "user_notifications — own read" on public.user_notifications;
create policy "user_notifications — own read" on public.user_notifications for select
  using (user_id = auth.uid());
drop policy if exists "user_notifications — own mark read" on public.user_notifications;
create policy "user_notifications — own mark read" on public.user_notifications for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.user_notifications from anon, authenticated;
grant select on public.user_notifications to authenticated;
grant update (read_at) on public.user_notifications to authenticated;
grant select, insert, update, delete on public.user_notifications to service_role;

-- 5. Announcements ---------------------------------------------------------------
create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  audience   text not null check (audience in ('rider', 'vendor', 'manager', 'all')),
  title      text not null check (char_length(btrim(title)) between 3 and 120),
  body       text not null check (char_length(body) <= 2000),
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint announcements_window check (ends_at is null or ends_at > starts_at)
);

create index if not exists announcements_live_idx on public.announcements (audience, starts_at desc);

-- Which audience a signed-in user belongs to: a shop owner is a vendor whatever
-- their profile role says (0017 lets a customer account own a shop).
create or replace function public.announcement_audience_of(uid uuid)
returns text
language sql stable security definer set search_path = public as $$
  select case
    when p.role = 'driver' then 'rider'
    when p.role = 'manager' then 'manager'
    when p.role = 'restaurant' or exists (select 1 from public.restaurants r where r.owner_id = uid) then 'vendor'
    else 'customer'
  end
  from public.profiles p where p.id = uid
$$;
revoke all on function public.announcement_audience_of(uuid) from public, anon;
grant execute on function public.announcement_audience_of(uuid) to authenticated, service_role;

alter table public.announcements enable row level security;

drop policy if exists "announcements — audience read" on public.announcements;
create policy "announcements — audience read" on public.announcements for select
  using (
    public.is_admin()
    or (starts_at <= now() and (ends_at is null or ends_at > now())
        and (audience = 'all' and public.announcement_audience_of(auth.uid()) <> 'customer'
             or audience = public.announcement_audience_of(auth.uid())))
  );

revoke all on public.announcements from anon, authenticated;
grant select on public.announcements to authenticated;
grant select, insert, update, delete on public.announcements to service_role;
