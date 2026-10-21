import { StatusBar } from "@/components/layout/status-bar";
import { OneSignalInit } from "@/components/notifications/onesignal-init";
import { FeaturesProvider } from "@/components/features/features-provider";
import { getFeatures } from "@/lib/features/flags.server";
import { DriverHeader } from "@/components/driver/driver-header";
import { DriverTabBar } from "@/components/driver/driver-tab-bar";
import { requireRole } from "@/lib/auth";
import { riderWorkBlock } from "@/lib/data-access/rider-work";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import type { Metadata } from "next";

/**
 * Installs as its own home-screen app on iPhone/Android ("Add to Home
 * Screen" from this portal) — see src/lib/pwa/role-manifest.ts.
 */
export const metadata: Metadata = {
  manifest: "/manifests/rider",
  appleWebApp: { capable: true, title: "Deligro Rider", statusBarStyle: "default" },
};

/**
 * The courier app runs in the phone frame, not the console shell.
 *
 * It used to render `.dashboard-shell` — the responsive web layout built for
 * the admin and vendor consoles — capped at 640px. On a laptop that produced a
 * 640px column of full-width cards floating on a page, which is not a thing any
 * rider will ever look at: the driver app is used one-handed, on a phone, at a
 * gate, and nowhere else. `.device` is the same frame the customer app uses, so
 * the layout being developed against is the layout that ships.
 *
 * No app↔web switch, unlike admin and vendor. Those two have a genuine desktop
 * audience — an operator at a desk, a kitchen with a tablet on the pass — and
 * the toggle exists so they can work at the size they actually have. There is
 * no desktop courier, so a switch would only offer a layout nobody should pick.
 *
 * The courier app used to be one screen, and this comment used to say so. It is
 * now three — Jobs, History, Profile — so the 80px foot padding that was
 * breathing room above the home indicator is real clearance for the tab bar.
 *
 * Jobs stays the app's front door. History and Profile are things a rider opens
 * between deliveries; neither should ever be what the app opens on, which is
 * why `DRIVER_TABS` orders them that way and why /driver matches exactly rather
 * than by prefix.
 */
export default async function DriverLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Delivery partners only — and it hands back the profile it already read, so
  // naming the rider in the header costs no second query. (`getProfile` is not
  // memoised, so calling it again here would be a real extra round trip.)
  const profile = await requireRole("driver");
  // 0151: a suspended or rejected rider sees why, and nothing they could act on.
  const block = isSupabaseConfigured ? await riderWorkBlock(profile.id) : null;
  if (block) {
    return (
      <div className="device">
        <div className="app-shell">
          <main className="px-6 pt-24 text-center">
            <h1 className="text-xl font-bold text-ink">
              {block === "account_suspended" ? "Your account is suspended" : "Your registration was not approved"}
            </h1>
            <p className="mt-3 text-sm text-muted">
              You can&apos;t take deliveries right now. Please contact your Deligro manager.
            </p>
            <form action="/auth/signout?next=/driver/login" method="post" className="mt-8">
              <button type="submit" className="press min-h-11 w-full rounded-xl border border-line py-3 text-sm font-semibold text-ink">
                Sign out
              </button>
            </form>
          </main>
        </div>
      </div>
    );
  }
  const features = await getFeatures("driver", profile.id);

  return (
    <FeaturesProvider features={features}>
    <div className="device">
      <div className="app-shell">
        <div className="app-scroll no-scrollbar pb-[80px]">
          <DriverHeader name={profile.full_name} />
          <main className="@container px-4 pb-6 pt-4">{children}</main>
        </div>
        <DriverTabBar />
        <StatusBar />
        {/* Push for pickup offers and cancellations — the rider's phone is in
            a pocket most of the shift. See onesignal-init.tsx. */}
        <OneSignalInit userId={isSupabaseConfigured ? profile.id : null} />
      </div>
    </div>
    </FeaturesProvider>
  );
}
