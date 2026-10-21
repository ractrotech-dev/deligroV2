import { requireRole } from "@/lib/auth";
import { AdminHero, PreviewNotice } from "@/components/admin/admin-ui";
import { ConsoleOnly } from "@/components/admin/console-only";
import { getSettingsSnapshot, riderRateCardReady, settingsBackendReady } from "@/lib/settings";
import { isRazorpayConfigured } from "@/lib/payments/razorpay";
import {
  getCommissionCoverage,
  getCommissionGstPct,
  getVendorCommissionDefault,
} from "@/lib/data-access/admin-commission";
import { SettingsForm } from "../settings-form";

/**
 * Platform settings — the one configuration row the whole app reads: order
 * fees, support contacts, which verticals are live, and the rider payout
 * formula. Writes here are server-authoritative; the customer app and the
 * billing code both read the same values. Reached from the Settings menu.
 */
export const dynamic = "force-dynamic";

export default async function PlatformSettingsPage() {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const [
    snapshot,
    backendReady,
    vendorCommissionPct,
    commissionGstPct,
    commissionCoverage,
    rateCardReady,
  ] = await Promise.all([
    getSettingsSnapshot(),
    settingsBackendReady(),
    getVendorCommissionDefault(),
    getCommissionGstPct(),
    getCommissionCoverage(),
    riderRateCardReady(),
  ]);
  const settings = snapshot.settings;

  return (
    <>
      <AdminHero
        backHref="/admin/settings"
        backLabel="Settings"
        title="Platform configuration"
        subtitle="Fees, support, availability and the rider payout formula."
      />

      {/* The settings row exists and could not be read. Ordering is paused
          platform-wide while that is true (see lib/settings.ts), and the form
          below is showing defaults rather than anything anyone configured — so
          saving from here would write those defaults over the real row. */}
      {snapshot.source === "unavailable" ? (
        <PreviewNotice>
          <strong>Settings could not be read.</strong> Customer ordering is
          paused platform-wide until this recovers, and the values below are
          fallback defaults, not your saved configuration.{" "}
          <strong>Do not save from this page</strong> — reload once the database
          is reachable. Check the server logs for{" "}
          <code className="rounded bg-surface-2 px-1">[settings]</code>.
        </PreviewNotice>
      ) : null}

      {!backendReady ? (
        <PreviewNotice>
          Preview mode — showing default values. Apply migration{" "}
          <code className="rounded bg-surface-2 px-1">
            0015_platform_settings.sql
          </code>{" "}
          to your database to save changes. Until then the app runs on these
          defaults.
        </PreviewNotice>
      ) : null}

      {/* Console-only: six two-column sections and a docked save bar, over the
          highest-blast-radius config in the product — fees, tax, commission,
          rider payout. Not something to edit from a phone by accident. */}
      <ConsoleOnly
        variant="page"
        tool="Platform configuration"
        why="Fees, tax, commission and the rider payout formula reach every order on the platform — too far to change by thumb, on purpose."
      >
        {/* Whether the gateway keys exist is a server fact; the form needs it to
            tell an admin that the payments toggle alone won't do anything. */}
        <SettingsForm
          settings={settings}
          razorpayConfigured={isRazorpayConfigured}
          vendorCommissionPct={vendorCommissionPct}
          commissionGstPct={commissionGstPct}
          commissionCoverage={commissionCoverage}
          rateCardReady={rateCardReady}
        />
      </ConsoleOnly>
    </>
  );
}
