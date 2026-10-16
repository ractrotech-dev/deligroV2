import type { Role } from "@/lib/auth";

/**
 * The portal registry — one entry per surface that has its own front door.
 *
 * Deligro used to have a single global /login that read your role and threw you
 * wherever that role belonged. That made one account's role decide which app you
 * got: the owner's phone is an admin, so signing in to *shop* landed on the
 * admin console. Each portal now has its own sign-in page instead, and the
 * customer app is simply what you get at `/`.
 *
 *   /admin   → /admin/login    (email or mobile + password, or phone OTP)
 *   /vendor  → /vendor/login   (email or mobile + password, or phone OTP)
 *   /manager → /manager/login  (email or mobile + password, or phone OTP)
 *   /driver  → /driver/login   (email or mobile + password, or phone OTP)
 *   customer → /login          (phone OTP, or browse as guest)
 *
 * The same account may hold more than one of these — signing in at a door does
 * not change who you are, only where you land. Moving *between* the surfaces one
 * account holds is `surfaces.ts` + the `/switch` chooser; it navigates, it does
 * not grant.
 *
 * `roles` here is for *routing* — which front door leads where, and whether a
 * signed-in visitor should be sent straight in. It is not the security boundary:
 * every portal layout still calls `requireRole()` / `requireVendorAccess()`
 * server-side, and the database still enforces RLS underneath that.
 *
 * Pure and side-effect free (the `Role` import is type-only, erased at build),
 * so client and server components can both read it.
 */

export type PortalKey = "admin" | "vendor" | "manager" | "driver" | "developer";

export interface Portal {
  key: PortalKey;
  /** Shown as the heading on the portal's own sign-in page. */
  label: string;
  /** One line under the heading, so you know which door you're at. */
  blurb: string;
  /** Portal root — where a signed-in operator lands. */
  home: string;
  /** That portal's sign-in page. */
  login: string;
  /** Roles routed here. Ownership-based access (vendor) is checked server-side. */
  roles: readonly Role[];
  /**
   * Offer phone OTP beside email + password. True everywhere: operator accounts
   * are not all email accounts — the owner's admin account is a phone account
   * (scripts/seed-developer.ts), and staff created from /admin/settings/employees
   * may carry a mobile. An email-only door would lock those accounts out of
   * their own portal. OTP is rate-limited per number, and the role check in the
   * portal layout still decides who gets in.
   */
  otp: boolean;
}

export const PORTALS: Record<PortalKey, Portal> = {
  admin: {
    key: "admin",
    label: "Admin console",
    blurb: "Platform operations, refunds, vendors & settlements",
    home: "/admin",
    login: "/admin/login",
    roles: ["admin"],
    otp: true,
  },
  vendor: {
    key: "vendor",
    label: "Restaurant portal",
    blurb: "Your orders, menu, hours & earnings",
    home: "/vendor",
    login: "/vendor/login",
    // Admins can open a shop's portal for support. Plain customers who own a
    // restaurant get in too — that check is ownership, not role, and lives in
    // requireVendorAccess().
    roles: ["restaurant", "admin"],
    otp: true,
  },
  manager: {
    key: "manager",
    label: "Manager console",
    blurb: "The live order board — dispatch, riders & phone orders",
    home: "/manager",
    login: "/manager/login",
    roles: ["manager", "admin"],
    otp: true,
  },
  driver: {
    key: "driver",
    label: "Driver partner",
    blurb: "Available jobs, active delivery & today's earnings",
    home: "/driver",
    login: "/driver/login",
    roles: ["driver"],
    otp: true,
  },
  developer: {
    key: "developer",
    label: "Developer panel",
    blurb: "Monitoring, health checks, configuration & maintenance",
    home: "/developer",
    login: "/developer/login",
    // Developer only. Admin is not routed here: an account has one role, and
    // the company's operators must not be able to open the app's internals.
    roles: ["developer"],
    otp: true,
  },
};

export const PORTAL_LIST: readonly Portal[] = [
  PORTALS.admin,
  PORTALS.vendor,
  PORTALS.manager,
  PORTALS.driver,
  PORTALS.developer,
];

/** The customer front door. Not a portal — it *is* the app. */
export const CUSTOMER_LOGIN = "/login";

/** Every portal sign-in page, for the proxy's public list. */
export const PORTAL_LOGIN_PATHS: readonly string[] = PORTAL_LIST.map(
  (p) => p.login
);

/** True when a path lives inside an operator portal (not the customer app). */
export function isOperatorPath(path: string): boolean {
  return PORTAL_LIST.some(
    (p) => path === p.home || path.startsWith(`${p.home}/`)
  );
}

/** The portal a path belongs to, or null for the customer app. */
export function portalForPath(path: string): Portal | null {
  return (
    PORTAL_LIST.find(
      (p) => path === p.home || path.startsWith(`${p.home}/`)
    ) ?? null
  );
}

/**
 * The sign-in page to send someone to when a role check fails. Keyed on the role
 * the guard *wanted*, not the one the visitor has — a customer who wanders into
 * /admin is shown the admin door (and told they can't open it), not their own.
 */
export function loginPathForRole(role: Role): string {
  switch (role) {
    case "admin":
      return PORTALS.admin.login;
    case "restaurant":
      return PORTALS.vendor.login;
    case "manager":
      return PORTALS.manager.login;
    case "driver":
      return PORTALS.driver.login;
    case "developer":
      return PORTALS.developer.login;
    case "customer":
    default:
      return CUSTOMER_LOGIN;
  }
}

/** True when this role is routed into `portal` on sign-in. */
export function roleEntersPortal(portal: Portal, role: Role): boolean {
  return portal.roles.includes(role);
}

/** Only relative, same-origin in-app paths — never an open redirect. */
export function safeNextPath(
  next: string | null | undefined,
  fallback = "/"
): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return fallback;
  // WHATWG URL parsing drops tab/newline and reads `\` as `/`, so "/\t/evil.com"
  // and "/\evil.com" pass the checks above yet resolve to another origin. Refuse
  // control characters and backslashes, then confirm the parse stays on-origin.
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  try {
    const probe = new URL(next, "https://deligro.invalid");
    if (probe.origin !== "https://deligro.invalid") return fallback;
  } catch {
    return fallback;
  }
  return next;
}

/**
 * Where a sign-in at `portal` should land. A `next` is honored only when it is
 * already inside that portal (a deep link the proxy bounced through the login),
 * so no door can be talked into dropping someone somewhere else.
 */
export function portalLanding(
  portal: Portal,
  next?: string | null
): string {
  const target = safeNextPath(next, portal.home);
  return target === portal.home || target.startsWith(`${portal.home}/`)
    ? target
    : portal.home;
}

/**
 * Where a customer sign-in should land: their `next`, unless it points into an
 * operator portal (that needs the portal's own door, and its own account).
 */
export function customerLanding(next?: string | null): string {
  const target = safeNextPath(next, "/");
  return isOperatorPath(target) ? "/" : target;
}
