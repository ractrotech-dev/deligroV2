import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { updateSession } from "@/lib/supabase/middleware";
import { GUEST_COOKIE } from "@/lib/auth/guest";
import {
  CUSTOMER_LOGIN,
  PORTAL_LIST,
  PORTAL_LOGIN_PATHS,
} from "@/lib/auth/portals";
import { newRequestId, newTraceId, parseCorrelationId } from "@/lib/obs/ids";
import { serverTimingHeader } from "@/lib/obs/server-timing";
import {
  OBS_REQUEST_ID_HEADER,
  OBS_TRACE_ID_HEADER,
} from "@/lib/obs/types";

// Next 16 "proxy" convention (formerly "middleware"). Runs before routes render.
//
// Three jobs, in order:
//   0. Mint the correlation ids every telemetry row is keyed on (see below).
//   1. Refresh the Supabase session cookie on every request (updateSession).
//   2. Coarse access control — the single place the "app launch" routing lives:
//        anon   → blocked from the app shell, redirected to /login
//        guest  → browse-only feed; gated customer routes bounce to /login
//        user   → full access
//
// Each surface has its own front door: /login is the customer app's (phone OTP
// or guest), and every portal bounces to its own (/admin → /admin/login, …), so
// a signed-out visitor is always sent to the door for the thing they asked for.
//
// Fine-grained role enforcement (is this user actually an admin/vendor/driver?)
// still happens server-side in each portal's layout via requireRole(). Proxy
// stays coarse and DB-free so it's cheap.

/**
 * Auth pages — always reachable without a session.
 *
 * The offline fallback is NOT here — it is `public/offline.html`, a static file
 * excluded in the matcher below alongside the service-worker scripts.
 */
const PUBLIC_PATHS = [CUSTOMER_LOGIN, "/portals", ...PORTAL_LOGIN_PATHS];

/** Entry page a signed-in user should be bounced away from (already onboarded). */
const ENTRY_PATHS = [CUSTOMER_LOGIN];

/** Customer routes that need a real account (user data or a write action). */
const GATED_CUSTOMER = ["/checkout", "/orders", "/profile"];

function matches(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export async function proxy(request: NextRequest) {
  // For the Server-Timing header set in `stamp` below.
  const startedAt = performance.now();
  let sessionMs: number | null = null;

  // ---------- correlation ids ----------
  //
  // Minted here because this is the one place every request passes through, so
  // an id exists before any handler runs and every event from one request can
  // be tied together. They are written onto the REQUEST headers (which
  // `NextResponse.next({ request })` propagates to the handler, the same
  // mechanism updateSession already relies on for refreshed cookies) and onto
  // the RESPONSE, so a browser can quote the id of a call that failed.
  //
  // `requestId` is always ours. `traceId` is accepted from the caller when it
  // is well-formed, which is what lets the checkout screen join its own
  // sequence of API calls into one trace. That does mean a client could point
  // many requests at one trace id; the blast radius is a noisy trace view for
  // an admin, not access to anything, and the alternative — a new trace per
  // request — makes multi-step operations untraceable, which is most of why
  // traces are here.
  const requestId = newRequestId();
  const traceId =
    parseCorrelationId(request.headers.get(OBS_TRACE_ID_HEADER), "trace") ??
    newTraceId();

  request.headers.set(OBS_REQUEST_ID_HEADER, requestId);
  request.headers.set(OBS_TRACE_ID_HEADER, traceId);

  const stamp = <T extends NextResponse>(res: T): T => {
    res.headers.set(OBS_REQUEST_ID_HEADER, requestId);
    res.headers.set(OBS_TRACE_ID_HEADER, traceId);
    // How long this proxy held the request, and how much of that was the
    // Supabase session check. Lets a slow page be split into "proxy", "render"
    // and "network" from the browser's resource timing. Durations only.
    const timing = serverTimingHeader([
      ["proxy", performance.now() - startedAt],
      ...(sessionMs === null ? [] : ([["session", sessionMs]] as const)),
    ]);
    if (timing) res.headers.set("Server-Timing", timing);
    return res;
  };

  // Demo mode: no Supabase keys yet -> don't block anything.
  if (!isSupabaseConfigured) return stamp(NextResponse.next({ request }));

  const sessionStartedAt = performance.now();
  const { response, user } = await updateSession(request);
  sessionMs = performance.now() - sessionStartedAt;
  const path = request.nextUrl.pathname;

  // API routes self-guard and are needed pre-login (OTP request/verify). Refresh
  // the session but never gate them here — a redirect would break those calls.
  if (path.startsWith("/api")) return stamp(response);

  const guest = request.cookies.get(GUEST_COOKIE)?.value === "1";

  // Public auth pages first — including the portal doors, which sit *under* a
  // portal prefix and must not be caught by the portal gate below. The portal
  // login page itself decides what to do with an already-signed-in visitor.
  if (matches(path, PUBLIC_PATHS)) {
    // A signed-in visitor never needs the customer entry page.
    if (user && matches(path, ENTRY_PATHS)) {
      return stamp(NextResponse.redirect(new URL("/", request.url)));
    }
    return stamp(response);
  }

  // Once signed in, any stale guest flag is meaningless — clear it.
  if (user && guest) response.cookies.delete(GUEST_COOKIE);

  // Operator portals: must be a logged-in user (guest is not enough), and the
  // bounce goes to that portal's own sign-in page, not the customer one.
  const portal = PORTAL_LIST.find(
    (p) => path === p.home || path.startsWith(`${p.home}/`)
  );
  if (portal && !user) {
    const url = request.nextUrl.clone();
    url.pathname = portal.login;
    url.searchParams.set("next", path);
    return stamp(NextResponse.redirect(url));
  }

  // Gated customer routes: a guest is NOT enough — must be a real user.
  // `next` set means the customer login hides its guest option.
  if (matches(path, GATED_CUSTOMER) && !user) {
    const url = request.nextUrl.clone();
    url.pathname = CUSTOMER_LOGIN;
    url.searchParams.set("next", path);
    return stamp(NextResponse.redirect(url));
  }

  // Everything else in the app shell (main feed, search, restaurants) needs at
  // least an explicit guest. Pure anon → the customer entry screen.
  if (!user && !guest) {
    return stamp(NextResponse.redirect(new URL(CUSTOMER_LOGIN, request.url)));
  }

  return stamp(response);
}

export const config = {
  // Run on everything except static assets and the public metadata files.
  //
  // robots.txt, sitemap.xml and manifest.webmanifest MUST be excluded here.
  // They are generated correctly by src/app/{robots,sitemap,manifest}.ts and
  // appear in the build output, but the proxy gate below sends any request
  // without a session to /login — and Googlebot has no session. Every one of
  // them answered 307 → /login, which means:
  //
  //   * a crawler cannot read robots.txt, so it never discovers the sitemap;
  //   * it cannot read the sitemap, so no restaurant page is ever indexed;
  //   * a first-time visitor's browser cannot read the manifest, so Chrome
  //     never offers "Add to home screen" — precisely the visitor the manifest
  //     exists for.
  //
  // All three are public by definition. Nothing in them is user-scoped, so
  // there is nothing for the session gate to protect.
  //
  // The two service-worker scripts are excluded for exactly the same reason,
  // and it was exactly the same bug: the exclusion list above covers images but
  // not .js, so `/OneSignalSDKWorker.js` answered 307 → /login to any browser
  // without a session. A worker script that redirects does not register, so
  // push could only ever install for an already-signed-in visitor, and the
  // periodic update check — which the browser makes with no guarantee of
  // credentials — could not see the script at all. Both files are static
  // `public/` assets containing no user data.
  // manifests/ — the portal apps' manifests (role-manifest.ts); public, no user data.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots\\.txt|sitemap\\.xml|manifest\\.webmanifest|manifests/|OneSignalSDKWorker\\.js|sw-core\\.js|offline\\.html|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
