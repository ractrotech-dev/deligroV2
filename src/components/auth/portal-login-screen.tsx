import { redirect } from "next/navigation";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { OperatorLogin } from "@/components/auth/operator-login";
import { getProfile } from "@/lib/auth";
import { hasVendorAccess } from "@/lib/auth/vendor-access";
import { surfacesForRole } from "@/lib/auth/surfaces";
import { PORTALS, portalLanding, roleEntersPortal, type PortalKey } from "@/lib/auth/portals";

/**
 * The page body every portal's `/…/login` route renders.
 *
 * It lives outside the portal's own folder tree (see `src/app/(portal-auth)/`)
 * so the portal layout — which guards the portal and would bounce back here —
 * never wraps it. That is what keeps the door from looping into itself.
 *
 * Already signed in with an account that belongs here? Straight through, no
 * second form. Signed in as someone else? The form stays, with a way out — a
 * sign-out button and the list of doors that account *can* open.
 */
export async function PortalLoginScreen({
  portalKey,
  searchParams,
}: Readonly<{
  portalKey: PortalKey;
  searchParams: Promise<{ next?: string; denied?: string }>;
}>) {
  const portal = PORTALS[portalKey];
  const { next, denied } = await searchParams;
  const landing = portalLanding(portal, next);

  const profile = await getProfile();
  // Ownership decides the vendor portal, and it also decides whether the vendor
  // portal belongs in the "where this account CAN go" list below — so resolve it
  // once, for any signed-in visitor, rather than only on the vendor door.
  const vendorAccess = profile ? await hasVendorAccess(profile) : false;

  if (profile) {
    // Vendor access is ownership-based, not role-based: a customer who runs a
    // shop belongs here too. Everything else is a plain role match.
    const allowed =
      portalKey === "vendor"
        ? vendorAccess
        : roleEntersPortal(portal, profile.role);
    if (allowed) redirect(landing);
  }

  const signedInAs = profile
    ? profile.full_name?.trim() || profile.phone || "That account"
    : null;

  // Where this account CAN go. A single-role test account — the seeded Demo
  // Driver, Demo Vendor — holds exactly one portal, so hopping between doors in
  // one browser means every other door refuses it. That refusal is correct and
  // stays; what was missing is the other half of the sentence. Telling someone
  // "sign in with an account that does" while they are already signed in, with
  // no visible way to switch and no hint of where their own account works, is
  // what makes a working system read as a broken one.
  //
  // Presentation only, exactly as surfaces.ts says: every link here still lands
  // on a layout that guards itself. Listing a door someone cannot open would be
  // a bug; opening one is not something this can do.
  const elsewhere = profile
    ? surfacesForRole(profile.role, { vendorAccess }).filter(
        (s) => s.key !== portalKey
      )
    : [];

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <OperatorLogin
        portalKey={portalKey}
        landing={landing}
        denied={denied === "1"}
        signedInAs={signedInAs}
        elsewhere={elsewhere}
      />
    </div>
  );
}
