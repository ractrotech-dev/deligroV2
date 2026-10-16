import type { Metadata } from "next";
import Link from "next/link";
import { PhoneIncoming, Wallet } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { ManagerOrderBoard } from "@/components/manager/manager-order-board";
import {
  listActiveOrders,
  listRiders,
  type ManagerOrderRow,
  type ManagerRider,
} from "@/lib/data-access/manager-orders";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { staffFeatureOn } from "@/lib/features/guards.server";

export const metadata: Metadata = { title: "Manager · Deligro" };

/** Live board — never served from a cache. */
export const dynamic = "force-dynamic";

/**
 * Manager → the live cross-vendor order board.
 *
 * Scoped to exactly what migration 0023 grants: read every order, advance its
 * status, and manage `deliveries` to dispatch riders. Fees, settlements, refund
 * decisions and vendor management stay with admin, and nothing on this page
 * reaches for the service role to get at them.
 */
export default async function ManagerHome() {
  // Matches the layout, which admits admins too. Gating this on "manager" alone
  // would render the board for an admin and then bounce every button they
  // pressed to /login?denied=1.
  const profile = await requireRole(["manager", "admin"]);
  const name = profile.full_name?.trim() || "Manager";

  let orders: ManagerOrderRow[] = [];
  let riders: ManagerRider[] = [];
  let failed = false;

  if (isSupabaseConfigured) {
    try {
      [orders, riders] = await Promise.all([listActiveOrders(), listRiders()]);
    } catch {
      // A board that renders empty on a failed read is worse than one that says
      // it failed: "no orders" is a thing an operator will act on.
      failed = true;
    }
  }

  // Admin → Feature access (managers only; an admin here has everything).
  const [canPhoneOrders, canCash, canCall] = await Promise.all([
    staffFeatureOn("manager.phone_orders"),
    staffFeatureOn("manager.cash"),
    staffFeatureOn("manager.call_customer"),
  ]);
  // With calling off, customer numbers are not sent to the page at all —
  // hiding the Call button alone would still ship them in the payload.
  if (!canCall) orders = orders.map((o) => ({ ...o, customerPhone: null }));

  const waiting = orders.filter((o) => o.dbStatus === "placed").length;
  const unassigned = orders.filter(
    (o) => !o.rider && (o.dbStatus === "ready" || o.dbStatus === "on_the_way")
  ).length;

  return (
    // No `max-w-md`: the column this sits in is the phone frame's 370px in app
    // mode and `.dashboard-main`'s ~1060px in web, so the width is already the
    // right width. Everything below sizes against that container, not the
    // window — the board is a list on a handset and a grid at a desk.
    <div className="w-full">
      {isSupabaseConfigured && !failed ? <AutoRefresh interval={4000} /> : null}

      <header className="pt-2">
        <p className="text-sm font-semibold text-muted">Deligro · Operations</p>
        <h1 className="mt-1 text-[23px] font-extrabold tracking-tight">
          Hi, {name}
        </h1>
        <p className="mt-1.5 max-w-prose text-sm text-muted">
          Every order in flight, across every restaurant. Fees, settlements, and
          vendor management stay with the admin team.
        </p>
      </header>

      {/* Above the board, not buried in a menu: a ringing phone is the one
          thing on this screen that cannot wait for the operator to go looking. */}
      {canPhoneOrders ? (
      <Link
        href="/manager/new-order"
        className="press mt-4 flex items-center gap-3 rounded-2xl border border-line bg-surface p-3.5 hover:bg-surface-2 @3xl:max-w-md"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
          <PhoneIncoming className="size-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] font-bold text-ink">
            Take a phone order
          </span>
          <span className="block text-xs text-muted">
            For a customer on the line — cash on delivery
          </span>
        </span>
      </Link>
      ) : null}

      {canCash ? (
      <Link
        href="/manager/cash"
        className="press mt-2.5 flex items-center gap-3 rounded-2xl border border-line bg-surface p-3.5 hover:bg-surface-2"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
          <Wallet className="size-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] font-bold text-ink">
            Cash &amp; expenses
          </span>
          <span className="block text-xs text-muted">
            Record a COD handover or a small spend
          </span>
        </span>
      </Link>
      ) : null}

      {!isSupabaseConfigured ? (
        <p className="mt-5 rounded-xl border border-pop/40 bg-pop/10 px-3.5 py-3 text-sm font-medium text-ink">
          Demo mode. Connect Supabase and apply migration 0023 to work live
          orders.
        </p>
      ) : failed ? (
        <p className="mt-5 rounded-xl border border-red-500/25 bg-red-500/10 px-3.5 py-3 text-sm font-medium text-red-600">
          Could not load the order board. This screen needs migration 0023
          applied — without it your account has no read access to orders.
        </p>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-3 gap-2.5 @3xl:max-w-2xl">
            <Tile label="In flight" value={orders.length} />
            <Tile label="Awaiting kitchen" value={waiting} alert={waiting > 0} />
            <Tile
              label="Need a rider"
              value={unassigned}
              alert={unassigned > 0}
            />
          </div>

          <div className="mt-5">
            <ManagerOrderBoard orders={orders} riders={riders} />
          </div>
        </>
      )}

      <form
        action="/auth/signout?next=/manager/login"
        method="post"
        className="mt-8 @3xl:max-w-xs"
      >
        <button
          type="submit"
          className="press block min-h-11 w-full py-3 text-center text-sm font-semibold text-muted hover:text-ink @3xl:text-left"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}

function Tile({
  label,
  value,
  alert,
}: Readonly<{
  label: string;
  value: number;
  alert?: boolean;
}>) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <p
        className={`text-data text-xl font-bold leading-none ${
          alert ? "text-red-600" : "text-ink"
        }`}
      >
        {value}
      </p>
      <p className="text-label mt-1">{label}</p>
    </div>
  );
}
