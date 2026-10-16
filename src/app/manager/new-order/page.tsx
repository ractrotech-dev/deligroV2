import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  BackToBoard,
  PhoneOrderComposer,
} from "@/components/manager/phone-order-composer";
import {
  listOrderableShops,
  phoneOrdersReady,
  type OrderableShop,
} from "@/lib/data-access/manager-phone-orders";
import { staffFeatureOn } from "@/lib/features/guards.server";
import { FeatureOffNotice } from "@/components/features/features-provider";

export const metadata: Metadata = { title: "Phone order · Deligro" };

/** Menus and shop opening hours change under the operator; never cache them. */
export const dynamic = "force-dynamic";

/**
 * Manager → take an order for a customer who called.
 *
 * The reason the manager role exists. Everything the desk needs that does not
 * change mid-call is resolved here — the shop list, the live fee and tax
 * settings the bill will be computed from, and whether this database can record
 * who took the order at all — so the composer opens ready to type into rather
 * than fetching while somebody waits.
 *
 * `requireRole` repeats the layout's gate on purpose: this page is reachable
 * directly, and a screen that writes orders in other people's names does not
 * get its authorization second-hand from a parent that could be refactored.
 */
export default async function NewPhoneOrderPage() {
  // Switchable in Admin → Feature access; the server actions behind this
  // page check the same switch.
  if (!(await staffFeatureOn("manager.phone_orders"))) return <FeatureOffNotice title="Phone orders" />;
  await requireRole(["manager", "admin"]);

  let shops: OrderableShop[] = [];
  let ready = false;
  let failed = false;

  const settings = await getSettings();

  if (isSupabaseConfigured) {
    try {
      [shops, ready] = await Promise.all([listOrderableShops(), phoneOrdersReady()]);
    } catch {
      failed = true;
    }
  }

  // Demo mode, a failed shop read, or the composer itself.
  function composer() {
    if (!isSupabaseConfigured) {
      return (
        <p className="rounded-xl border border-pop/40 bg-pop/10 px-3.5 py-3 text-sm font-medium text-ink">
          Demo mode. Connect Supabase and apply migration 0029 to take phone
          orders.
        </p>
      );
    }
    if (failed) {
      return (
        <p className="rounded-xl border border-red-500/25 bg-red-500/10 px-3.5 py-3 text-sm font-medium text-red-600">
          Could not load the restaurant list. Without it there is nothing to
          order from — refresh, and check migration 0023 is applied.
        </p>
      );
    }
    return (
      <PhoneOrderComposer
        shops={shops}
        ready={ready}
        config={{
          deliveryFee: settings.deliveryFee,
          taxRate: settings.taxRate,
          freeDeliveryThreshold: settings.freeDeliveryThreshold,
          minOrder: settings.minOrder,
          acceptingOrders: settings.acceptingOrders,
          maintenanceMessage: settings.maintenanceMessage,
        }}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <header className="flex items-center justify-between gap-3 pb-1 pt-1">
        <BackToBoard />
        <p className="text-sm font-semibold text-muted">Phone order</p>
      </header>

      <div className="pb-3">
        <h1 className="text-[23px] font-extrabold tracking-tight">
          Take an order
        </h1>
        <p className="mt-1 text-sm text-muted">
          For a customer on the line. It joins the same board, kitchen and
          dispatch as every other order.
        </p>
      </div>

      {composer()}
    </div>
  );
}
