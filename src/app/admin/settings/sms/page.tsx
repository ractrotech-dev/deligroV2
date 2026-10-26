import { MessageSquareText } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { AdminHero, EmptyState, PreviewNotice } from "@/components/admin/admin-ui";
import { Figure, FigureRow } from "@/components/admin/console";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  DEFAULT_ORDER_SMS_TEMPLATE,
  getOrderSmsSettings,
  listVendorSms,
  type OrderSmsSettings,
  type VendorSmsRow,
} from "@/lib/data-access/vendor-order-sms";
import { SmsManager } from "./sms-manager";

/**
 * Settings → Vendor SMS. A text message to the shop when a new order arrives,
 * on top of the Partner app's push and ring: the global switch and message,
 * and per shop whether it gets one and on which number (migration 0175).
 *
 * Platform: BOTH — a switch and a list; it works on a phone.
 */
export const dynamic = "force-dynamic";

export default async function AdminSmsPage() {
  await requireRole("admin");

  let settings: OrderSmsSettings = {
    enabled: false,
    template: DEFAULT_ORDER_SMS_TEMPLATE,
    installed: false,
    gatewayConfigured: false,
  };
  let shops: VendorSmsRow[] = [];
  let failed = false;
  if (isSupabaseConfigured) {
    try {
      [settings, shops] = await Promise.all([getOrderSmsSettings(), listVendorSms()]);
    } catch {
      failed = true;
    }
  }
  const on = shops.filter((s) => s.enabled).length;

  return (
    <>
      <AdminHero
        backHref="/admin/settings"
        backLabel="Settings"
        title="Vendor SMS"
        subtitle="Text a shop when a new order arrives, as well as the Partner app's ring."
      />

      {!isSupabaseConfigured ? <PreviewNotice>Connect Supabase to manage SMS.</PreviewNotice> : null}

      {failed ? (
        <EmptyState
          icon={MessageSquareText}
          title="Couldn't load SMS settings"
          description="Reload the page. If it keeps happening, check the database connection."
        />
      ) : !settings.installed ? (
        <EmptyState
          icon={MessageSquareText}
          title="Vendor SMS isn't set up yet"
          description="Apply migration 0175 to turn on new-order SMS for shops."
        />
      ) : (
        <>
          <FigureRow>
            <Figure label="New-order SMS" value={settings.enabled ? "On" : "Off"} note="For every shop below that is on" />
            <Figure label="Shops receiving" value={on} note={`of ${shops.length}`} />
            <Figure
              label="SMS gateway"
              value={settings.gatewayConfigured ? "Connected" : "Not set"}
              note={settings.gatewayConfigured ? "ORDER_SMS_URL is set" : "Set ORDER_SMS_URL on the server"}
            />
          </FigureRow>
          <SmsManager settings={settings} shops={shops} disabled={!isSupabaseConfigured} />
        </>
      )}
    </>
  );
}
