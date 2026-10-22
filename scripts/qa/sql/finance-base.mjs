// Shared base for the Phase 6 finance proofs (0155+): manager-base.mjs, the
// abridged money tables those proofs need (vendor_settlements + lines from
// 0028/0034, settlement_corrections from 0048, payments from 0025, the refund
// provenance columns from 0026), then the real 0142, 0150, 0151 and 0152.
// Needs: npm i --no-save @electric-sql/pglite@0.2.17
import { managerBase, readMigration, id, IDS } from "./manager-base.mjs";

export { readMigration, id, IDS };

export async function financeBase() {
  const base = await managerBase();
  const { db, ZA } = base;
  const M2 = id(20); // a second zone-A manager: the checker
  await db.exec(`
    alter table public.profiles add column if not exists phone text;
    alter table public.cod_handovers add column if not exists from_user uuid, add column if not exists to_user uuid,
      add column if not exists handover_date date not null default current_date, add column if not exists note text;
    create or replace function public.lock_role() returns trigger language plpgsql security definer set search_path = public as $$
    begin return new; end; $$;
    insert into public.profiles (id, role, full_name) values ('${M2}','manager','Meera');

    alter table public.orders add column if not exists delivery_fee integer not null default 0,
      add column if not exists tax_amount integer not null default 0, add column if not exists discount integer not null default 0,
      add column if not exists discount_funded_by text, add column if not exists delivered_at timestamptz;
    alter table public.restaurants add column if not exists commission_pct numeric(5,2),
      add column if not exists other_charges_per_order integer not null default 0,
      add column if not exists settlement_cycle text not null default 'weekly';
    alter table public.refunds add column if not exists provider_refund_id text, add column if not exists settled_at timestamptz;

    create type public.vendor_settlement_status as enum ('draft', 'paid', 'void');
    create type public.settlement_kind as enum ('batch', 'instant');
    create table public.vendor_settlements (
      id uuid primary key default gen_random_uuid(),
      restaurant_id uuid not null references public.restaurants (id) on delete restrict,
      period_start timestamptz not null, period_end timestamptz not null,
      food_gross integer not null default 0, commission integer not null default 0,
      commission_gst integer not null default 0, other_charges integer not null default 0,
      refunds_recovered integer not null default 0, net_payable integer not null default 0,
      status public.vendor_settlement_status not null default 'draft', kind public.settlement_kind not null default 'batch',
      paid_at timestamptz, paid_by uuid references public.profiles (id), payment_ref text, notes text,
      created_at timestamptz not null default now(), created_by uuid references public.profiles (id),
      voided_at timestamptz, voided_by uuid references public.profiles (id),
      constraint vendor_settlements_period_check check (period_end > period_start));
    drop table public.vendor_settlement_orders;
    create table public.vendor_settlement_orders (
      id uuid primary key default gen_random_uuid(),
      settlement_id uuid not null references public.vendor_settlements (id) on delete cascade,
      order_id uuid not null unique references public.orders (id) on delete restrict,
      food_gross integer not null default 0, commission integer not null default 0,
      commission_gst integer not null default 0, other_charges integer not null default 0,
      refund_recovered integer not null default 0, vendor_net integer not null default 0,
      contribution integer not null default 0, order_total integer not null default 0, payment_method text);
    create type public.correction_status as enum ('outstanding', 'applied', 'voided');
    create table public.settlement_corrections (
      id uuid primary key default gen_random_uuid(),
      restaurant_id uuid not null references public.restaurants (id), order_id uuid not null references public.orders (id),
      refund_id uuid references public.refunds (id), original_settlement_id uuid not null references public.vendor_settlements (id),
      applied_settlement_id uuid references public.vendor_settlements (id) on delete set null,
      amount integer not null check (amount > 0), reason text,
      status public.correction_status not null default 'outstanding',
      created_by uuid not null references public.profiles (id), created_at timestamptz not null default now(), applied_at timestamptz);
    create table public.payments (
      id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders (id) on delete cascade,
      provider text not null default 'razorpay', provider_order_id text not null, provider_payment_id text,
      amount_paise integer not null default 0, status text not null default 'pending',
      error_code text, error_description text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());

    -- What 0001/0028/0048/0025 already grant and allow, abridged.
    alter table public.vendor_settlements enable row level security;
    create policy "vendor_settlements — admin read" on public.vendor_settlements for select using (public.is_admin());
    alter table public.vendor_settlement_orders enable row level security;
    create policy "vendor_settlement_orders — admin read" on public.vendor_settlement_orders for select using (public.is_admin());
    alter table public.settlement_corrections enable row level security;
    create policy "settlement_corrections — admin read" on public.settlement_corrections for select using (public.is_admin());
    alter table public.refunds enable row level security;
    create policy "refunds — read" on public.refunds for select using (
      public.is_admin() or exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));
    create policy "refunds — admin decide" on public.refunds for update using (public.is_admin()) with check (public.is_admin());
    alter table public.payments enable row level security;
    create policy "payments — read" on public.payments for select using (
      public.is_admin() or exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));
    revoke insert, update, delete on public.payments from anon, authenticated;
    revoke insert, update, delete on public.vendor_settlements, public.vendor_settlement_orders, public.settlement_corrections
      from anon, authenticated;
  `);
  await db.exec(readMigration("0142_manager_orders_live.sql"));
  await db.exec(readMigration("0150_rider_tables_converge.sql"));
  await db.exec(readMigration("0151_manager_riders.sql"));
  await db.exec(`delete from public.staff_zones where user_id = '${M2}'; insert into public.staff_zones (user_id, zone_id) values ('${M2}','${ZA}');`);
  await db.exec(readMigration("0152_payment_requests_cash_exceptions.sql"));
  return { ...base, M2 };
}

/** Run SQL as a role (and auth.uid), capturing the error instead of throwing. */
export function harness(db) {
  let passed = 0, failed = 0;
  const ok = (n, c, extra) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}${!c && extra ? `\n         ${extra}` : ""}`); };
  async function as(role, uid, sql) {
    const claims = role === "service_role" ? { role: "service_role" } : {};
    await db.exec(`set role ${role}; select set_config('test.uid','${uid ?? ""}',false); select set_config('test.jwt','${JSON.stringify(claims)}',false);`);
    try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
    catch (e) { return { ok: false, msg: String(e.message), detail: e.detail }; }
    finally { await db.exec("reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);"); }
  }
  const fails = (r, re) => !r.ok && re.test(r.msg);
  const srv = (sql) => as("service_role", null, sql);
  const one = async (sql) => (await db.query(sql)).rows[0];
  const done = () => { console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); };
  return { ok, as, fails, srv, one, done };
}
