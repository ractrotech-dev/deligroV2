import { Suspense } from "react";
import { StatusBar } from "@/components/layout/status-bar";
import { TabBar } from "@/components/layout/tab-bar";
import { GlassCart } from "@/components/glass/glass-cart";
import { CartHydrator } from "@/components/glass/cart-hydrator";
import { ItemSheet } from "@/components/restaurant/item-sheet";
import { CartSwitchDialog } from "@/components/shared/cart-switch-dialog";
import { ReorderReviewDialog } from "@/components/shared/reorder-review-dialog";
import { SplashScreen } from "@/components/shared/splash-screen";
import { OneSignalInit } from "@/components/notifications/onesignal-init";
import { ChargesConfigProvider } from "@/components/providers/charges-config-provider";
import { LangProvider } from "@/components/providers/lang-provider";
import { getLang } from "@/lib/i18n/server";
import { getProfile } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { pickRole } from "@/lib/features/catalog";
import { getFeatures } from "@/lib/features/flags.server";
import { customerFeatures } from "@/lib/features/guards.server";
import { CustomerFeatureSync, CustomerFeaturesProvider } from "@/components/features/customer-features-provider";

// The customer app is per-request: it reads the auth cookie (getProfile, below)
// and live catalog/order data. Render dynamically so cookie/Supabase access
// never collides with a child's generateStaticParams (which would otherwise
// throw DYNAMIC_SERVER_USAGE, e.g. on /restaurant/[slug]).
export const dynamic = "force-dynamic";

/**
 * Push registration needs the signed-in user's id, and nothing else in this
 * layout does. Reading it here, behind a Suspense boundary, keeps the profile
 * read (two Supabase round trips) off the path to the first byte: the shell and
 * the page's skeleton stream out first, and registration mounts as soon as the
 * id is known. `getProfile` is `cache()`d, so a page that also needs the
 * profile still shares this one read.
 *
 * No `.catch` here on purpose. A failed read must not look like "signed out",
 * because signed out is what makes `OneSignalInit` log this browser out of
 * push.
 */
async function PushRegistration() {
  const profile = await getProfile();
  return <OneSignalInit userId={profile?.id ?? null} />;
}

/**
 * This person's feature switches. The same reasoning as `PushRegistration`: the
 * profile read stays off the path to the first byte, and until it lands the page
 * shows the "for everyone" values. The API routes refuse either way.
 */
async function CustomerFeatures() {
  return <CustomerFeatureSync features={await customerFeatures()} />;
}

export default async function CustomerLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Auth cookie gates per-user extras (push). Onboarding now lives entirely in
  // the /login entry flow — no first-run carousel over the feed.
  //
  // No role check here on purpose. This shell used to redirect any non-customer
  // to their portal, which meant an operator account could not open the app it
  // operates — the owner's phone is an admin, so signing in to shop landed on
  // the admin console. The customer app is for everyone; the portals are the
  // things that are gated, each behind its own door.
  //
  // Settings come down with it because the basket sheet and every discovery
  // card quote a delivery fee, and those quotes have to be the numbers checkout
  // and `createOrder` bill from. Read here, once, rather than per surface:
  // `getSettings()` is request-cached, and this is the one node that is an
  // ancestor of both the page tree and the cart sheet.
  const [settings, lang] = await Promise.all([getSettings(), getLang()]);
  // Admin → App features, for everyone. No profile read: a guest is the same answer.
  const everyone = pickRole("customer", await getFeatures("customer", null));

  return (
    <LangProvider initial={lang}>
      <CustomerFeaturesProvider everyone={everyone}>
      <ChargesConfigProvider
        config={{
          deliveryFee: settings.deliveryFee,
          taxRate: settings.taxRate,
          freeDeliveryThreshold: settings.freeDeliveryThreshold,
        }}
      >
        <div className="device">
          <div className="app-shell customer-app">
            <div className="app-scroll no-scrollbar pb-[80px]">
              {/* The content landmark screen readers jump to. */}
              <main>{children}</main>
            </div>
            <StatusBar />
            <ItemSheet />
            <CartSwitchDialog />
            <ReorderReviewDialog />
            <GlassCart />
            <CartHydrator />
            <TabBar />
            <SplashScreen />
            {/* Mounted once the user id is known (never with a placeholder
                id: signed out, it logs this browser out of push). */}
            <Suspense fallback={null}>
              <PushRegistration />
            </Suspense>
            <Suspense fallback={null}>
              <CustomerFeatures />
            </Suspense>
          </div>
        </div>
      </ChargesConfigProvider>
      </CustomerFeaturesProvider>
    </LangProvider>
  );
}
