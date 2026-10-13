import type { Role } from "@/lib/auth";
import { PORTALS, type Portal, type PortalKey } from "@/lib/auth/portals";

/**
 * The surfaces one account can open — the customer app, plus whichever operator
 * portals that account is entitled to.
 *
 * This exists because a single person here is often two things at once: the
 * owner's phone is an admin account *and* the account they shop with. Portals
 * each have their own door (see portals.ts), which fixed sign-in landing you in
 * the wrong app — but it left no way to *move between* the apps you legitimately
 * hold. That is what this list drives: the "where do you want to go" chooser
 * after sign-in, the console rows on the customer profile, and the way back from
 * a console to the app.
 *
 * It is presentation only. Nothing here grants access: every link still lands on
 * a layout that calls `requireRole()` / `requireVendorAccess()`, and RLS sits
 * under that. Getting this list wrong shows someone a door they cannot open —
 * never one they can.
 *
 * Pure and side-effect free (the `Role` import is type-only), so client and
 * server components can both read it.
 */

export type SurfaceKey = "customer" | PortalKey;

export interface Surface {
  key: SurfaceKey;
  label: string;
  blurb: string;
  href: string;
}

/**
 * Portals offered per role, in the order they should be shown.
 *
 * The vendor portal is deliberately absent from `admin`: access there is
 * ownership-based (`requireVendorAccess`), so an admin who owns no restaurant
 * would be offered a portal with nothing in it. Callers that have already
 * resolved ownership can pass `vendorAccess` below and get it back.
 */
const ROLE_PORTALS: Record<Role, readonly Portal[]> = {
  admin: [PORTALS.admin, PORTALS.manager],
  manager: [PORTALS.manager],
  restaurant: [PORTALS.vendor],
  driver: [PORTALS.driver],
  // Only the Developer panel: a developer account is a separate login and does
  // not enter the company's operator consoles.
  developer: [PORTALS.developer],
  customer: [],
};

function surfaceFor(portal: Portal): Surface {
  return {
    key: portal.key,
    label: portal.label,
    blurb: portal.blurb,
    href: portal.home,
  };
}

/**
 * Every surface this account can open, operator portals first and the customer
 * app last — the app is what you fall back to, so it reads as the closing option
 * rather than the buried one.
 *
 * `customerHref` lets a caller keep a pending destination (the `/checkout` the
 * proxy bounced through the login) attached to the customer card. `vendorAccess`
 * is for the ownership case a role cannot express: a plain customer who runs a
 * shop. Resolve it with `hasVendorAccess()` server-side; omitted, the vendor
 * portal is offered on role alone.
 */
export function surfacesForRole(
  role: Role,
  opts: { customerHref?: string; vendorAccess?: boolean } = {}
): Surface[] {
  const { customerHref = "/", vendorAccess = false } = opts;

  const portals = [...ROLE_PORTALS[role]];
  if (vendorAccess && !portals.includes(PORTALS.vendor)) {
    portals.push(PORTALS.vendor);
  }

  return [
    ...portals.map(surfaceFor),
    {
      key: "customer",
      label: "Customer app",
      blurb: "Browse, order & track — Deligro as your customers see it",
      href: customerHref,
    },
  ];
}

/** Just the consoles — the customer app dropped. Empty for a plain customer. */
export function operatorSurfaces(surfaces: readonly Surface[]): Surface[] {
  return surfaces.filter((s) => s.key !== "customer");
}

/**
 * Is there anything to choose between? One surface means the account only has
 * the customer app, and asking would be a dead-end screen.
 */
export function hasChoice(surfaces: readonly Surface[]): boolean {
  return surfaces.length > 1;
}
