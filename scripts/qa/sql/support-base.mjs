// The setup the vendor/support proofs share: manager-base.mjs, the restaurant
// columns 0017–0056 add (abridged), the tables 0145 extends, then 0142, 0064 §3
// (support tickets) and 0143. supportBase() also applies 0145.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17
import { managerBase, readMigration, IDS } from "./manager-base.mjs";

export async function preamble0145(db) {
  const { R1, R2 } = IDS;
// The restaurant columns 0017–0056 add (abridged), the 0017 status ↔ approved
// sync, and the tables 0145 extends.
  await db.exec(`
  create type public.vendor_status as enum ('pending', 'active', 'inactive', 'suspended');
  alter table public.restaurants
    add column if not exists slug text unique, add column if not exists approved boolean not null default false,
    add column if not exists status public.vendor_status not null default 'pending',
    add column if not exists lat double precision, add column if not exists lng double precision,
    add column if not exists created_at timestamptz not null default now(),
    add column if not exists description text, add column if not exists category text, add column if not exists image_url text,
    add column if not exists is_open boolean not null default true,
    add column if not exists owner_name text, add column if not exists owner_mobile text, add column if not exists owner_alt_mobile text,
    add column if not exists owner_email text, add column if not exists owner_phone_verified boolean not null default false,
    add column if not exists password_reset_at timestamptz, add column if not exists commission_pct numeric(5,2),
    add column if not exists min_order integer not null default 0, add column if not exists delivery_available boolean not null default true,
    add column if not exists self_pickup boolean not null default false, add column if not exists opening_time time,
    add column if not exists closing_time time, add column if not exists weekly_off text[] not null default '{}',
    add column if not exists address text, add column if not exists landmark text, add column if not exists pincode text,
    add column if not exists upi_id text, add column if not exists bank_account_name text, add column if not exists bank_name text,
    add column if not exists bank_account_number text, add column if not exists bank_ifsc text,
    add column if not exists fssai_number text, add column if not exists gst_number text, add column if not exists pan_number text,
    add column if not exists tc_accepted_at timestamptz, add column if not exists tc_accepted_by uuid, add column if not exists tc_version text,
    add column if not exists accept_cod boolean default true, add column if not exists accept_online boolean default true,
    add column if not exists cod_max_order integer, add column if not exists other_charges_per_order integer default 0,
    add column if not exists settlement_cycle text, add column if not exists rating numeric, add column if not exists rating_count integer default 0,
    add column if not exists rating_sum integer default 0, add column if not exists promoted boolean default false,
    add column if not exists sort_position integer;
  alter table public.restaurants alter column id set default gen_random_uuid();
  update public.restaurants set slug = 'spice-hub', status = 'active', approved = true, lat = 21.7, lng = 81.5 where id = '${R1}';
  update public.restaurants set slug = 'saja-dhaba', status = 'pending' where id = '${R2}';
  create function public.sync_restaurant_status() returns trigger language plpgsql as $$
  begin new.approved := (new.status = 'active'); return new; end; $$;
  create trigger sync_restaurant_status before insert or update on public.restaurants
    for each row execute function public.sync_restaurant_status();
  alter table public.restaurants enable row level security;
  create policy "restaurants — owner manage" on public.restaurants for all
    using (owner_id = auth.uid() or public.is_admin()) with check (owner_id = auth.uid() or public.is_admin());

  create table public.vendor_documents (id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references public.restaurants on delete cascade,
    doc_type text not null check (doc_type in ('fssai','gst','pan','bank_proof','shop_license','other')),
    storage_path text not null, file_name text not null, uploaded_by uuid, created_at timestamptz not null default now());
  alter table public.vendor_documents enable row level security;
  create policy "vendor_documents — read" on public.vendor_documents for select using (public.owns_restaurant(restaurant_id) or public.is_admin());

  create table public.reviews (id uuid primary key default gen_random_uuid(), order_id uuid, user_id uuid,
    restaurant_id uuid not null references public.restaurants, rating int not null, comment text, created_at timestamptz default now());
  alter table public.reviews enable row level security;
  create table public.review_replies (id uuid primary key default gen_random_uuid(), review_id uuid not null unique references public.reviews,
    author_id uuid not null, reply_text text not null, created_at timestamptz default now());
  alter table public.review_replies enable row level security;
  create table public.store_holidays (id uuid primary key default gen_random_uuid(), restaurant_id uuid not null references public.restaurants,
    starts_on date not null, ends_on date not null, note text);
  alter table public.store_holidays enable row level security;
  create table public.menu_items (id uuid primary key default gen_random_uuid(), restaurant_id uuid not null references public.restaurants,
    name text not null, description text, price integer not null, veg boolean default true, available boolean default true, category text);

  grant all on all tables in schema public to anon, authenticated, service_role;
`);
  await db.exec(readMigration("0142_manager_orders_live.sql"));
  {
  const m0064 = readMigration("0064_growth_support.sql").replace(/\r\n/g, "\n");
  const start = m0064.indexOf("-- 3. Support tickets");
  const end = m0064.indexOf("-- 4. Notification inbox");
  if (start < 0 || end < 0) throw new Error("0064 section markers not found");
  await db.exec(m0064.slice(start, end));
  }
  await db.exec(readMigration("0143_support_tickets_ops.sql"));
// ops_vendor_dues reads 0144`s pricing helpers, which this base does not load;
// its arithmetic is proven against vendorEarnings() by scripts/qa/ops-sql-parity.ts.
}

/** manager-base + preamble0145 + 0145 — the starting point for 0165+. */
export async function supportBase() {
  const { db, ZA, ZB } = await managerBase();
  await preamble0145(db);
  await db.exec("set check_function_bodies = off");
  await db.exec(readMigration("0145_manager_vendors.sql"));
  await db.exec("grant select on all tables in schema public to authenticated;");
  return { db, ZA, ZB };
}
