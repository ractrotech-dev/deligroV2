// Shared base for the Phase 7 proofs (0160+): finance-base.mjs, the abridged
// coupon, banner and menu tables 0160–0162 touch (0006/0014/0031/0041 in
// substance), then the real 0064 (marketing requests, coupon start dates) and
// 0155 (manager_can_see_restaurant).
// Needs: npm i --no-save @electric-sql/pglite@0.2.17
import { financeBase, harness, readMigration, id, IDS } from "./finance-base.mjs";

export { harness, readMigration, id, IDS };

export async function growthBase() {
  const base = await financeBase();
  const { db, ZA, ZB } = base;
  const { R1, R2 } = IDS;
  await db.exec(`
    alter table public.restaurants add column if not exists offer text, add column if not exists offer_expires_at timestamptz,
      add column if not exists slug text;
    alter table public.orders add column if not exists coupon_code text;
    create function public.promo_amount_text(n numeric) returns text language sql immutable as $$
      select case when n = trunc(n) then trunc(n)::text else n::text end $$;
    create function public.recompute_order_total(oid uuid) returns void language plpgsql security definer set search_path = public as $$
    begin
      update public.orders o set total = greatest(0, coalesce((select sum(qty * price) from public.order_items where order_id = oid), 0)
        + o.delivery_fee + o.tax_amount - o.discount) where o.id = oid;
    end; $$;

    create table public.menu_items (id uuid primary key default gen_random_uuid(), restaurant_id uuid not null references public.restaurants,
      name text not null, price integer not null, available boolean not null default true,
      approval_status text not null default 'approved', hidden_by_ops boolean not null default false);

    create table public.coupons (code text primary key, kind text not null check (kind in ('percent','flat')), value numeric(10,2) not null,
      min_order numeric(10,2) not null default 0, max_discount numeric(10,2), active boolean not null default true,
      expires_at timestamptz, created_at timestamptz not null default now(), max_per_customer integer default 1, max_redemptions integer,
      restaurant_id uuid references public.restaurants, funded_by text not null default 'platform'
        check (funded_by in ('platform','vendor')), label text, created_by uuid);
    create table public.coupon_redemptions (id uuid primary key default gen_random_uuid(), code text not null,
      order_id uuid not null unique references public.orders on delete cascade, customer_id uuid not null references public.profiles,
      discount integer not null check (discount >= 0), created_at timestamptz not null default now());
    alter table public.coupons enable row level security;
    create policy "coupons — admin all" on public.coupons for all using (public.is_admin()) with check (public.is_admin());
    create policy "coupons — vendor read" on public.coupons for select using (restaurant_id is not null and public.owns_restaurant(restaurant_id));
    create policy "coupons — vendor update" on public.coupons for update
      using (restaurant_id is not null and public.owns_restaurant(restaurant_id))
      with check (restaurant_id is not null and public.owns_restaurant(restaurant_id) and funded_by = 'vendor');
    alter table public.coupon_redemptions enable row level security;

    create table public.banners (id uuid primary key default gen_random_uuid(), name text not null, headline text not null,
      description text not null default '', cta_label text not null default 'Explore',
      kind text not null default 'internal' check (kind in ('internal','sponsored')),
      status text not null default 'draft' check (status in ('draft','active','paused','archived')),
      target_type text not null default 'food', target_value text, placements text[] not null default '{}',
      image_url text, sponsor_name text, target_zones text[] not null default '{}',
      starts_at timestamptz, ends_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table public.banner_events (id bigint generated always as identity primary key,
      banner_id uuid not null references public.banners on delete cascade, kind text not null, placement text, city text,
      created_at timestamptz not null default now());
    alter table public.banners enable row level security;
    alter table public.banner_events enable row level security;

    update public.restaurants set zone_id = '${ZA}' where id = '${R1}';
    update public.restaurants set zone_id = '${ZB}' where id = '${R2}';
  `);
  await db.exec(readMigration("0064_growth_support.sql"));
  await db.exec(readMigration("0155_manager_finance_reads.sql"));
  return base;
}
