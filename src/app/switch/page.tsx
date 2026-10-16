import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { StatusBar } from "@/components/layout/status-bar";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { SurfaceCards } from "@/components/shared/surface-switch";
import { requireUser } from "@/lib/auth";
import { customerLanding } from "@/lib/auth/portals";
import { ownsAnyRestaurant } from "@/lib/auth/vendor-access";
import { hasChoice, surfacesForRole } from "@/lib/auth/surfaces";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = { title: "Where to? · Deligro" };

/** Reads the auth cookie and the account's role — never prerendered. */
export const dynamic = "force-dynamic";

/**
 * "Where do you want to go?" — the fork for accounts that hold more than one
 * surface. The owner's phone is both an admin and a shopper, and until this
 * existed, signing in meant picking one of those forever (or knowing to type a
 * portal URL by hand).
 *
 * It is a chooser, not a gate: an account with only the customer app never sees
 * it, and it hands out links whose destinations do their own role checks. `next`
 * is the customer-app destination the sign-in was headed for, so a deep link
 * that bounced through the login (checkout, an order) survives the detour.
 */
export default async function SwitchPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ next?: string }>;
}>) {
  const profile = await requireUser();
  const { next } = await searchParams;
  const customerHref = customerLanding(next);

  // Ownership, not the role shortcut in hasVendorAccess(): an admin is *allowed*
  // into the vendor portal for support, but offering it here to one who owns no
  // shop is a card that leads to an empty portal.
  const vendorAccess = isSupabaseConfigured
    ? await ownsAnyRestaurant(profile.id).catch(() => false)
    : false;

  const surfaces = surfacesForRole(profile.role, {
    customerHref,
    vendorAccess,
  });

  // One surface means there is nothing to ask about — straight where they were
  // going. This is the path every ordinary customer takes.
  if (!hasChoice(surfaces)) redirect(customerHref);

  const name = profile.full_name?.trim().split(" ")[0] || "there";

  return (
    <div className="device">
      <div className="app-shell">
        <StatusBar />
        <div className="absolute right-4 top-4 z-10 min-[480px]:top-[64px]">
          <ThemeToggle />
        </div>
        <div className="app-scroll no-scrollbar flex min-h-full flex-col justify-center px-6 py-10">
          <div className="w-full">
            <h1 className="text-[23px] font-extrabold tracking-tight">
              Hi {name} — where to?
            </h1>
            <p className="mt-1.5 text-sm text-muted">
              This account opens more than one Deligro. Pick one; you can switch
              any time from your profile.
            </p>

            <div className="mt-6">
              <SurfaceCards surfaces={surfaces} />
            </div>

            <form action="/auth/signout" method="post" className="mt-6">
              <button
                type="submit"
                className="press block w-full text-center text-sm font-semibold text-muted hover:text-ink"
              >
                Not you? Sign out
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
