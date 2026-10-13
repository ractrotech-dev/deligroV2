import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Security headers (checklist §7 + §4). Applied to every response.
 *
 * The CSP below is the pragmatic budget tier: it locks img/connect/frame/base
 * sources down hard, but allows 'unsafe-inline' for scripts/styles because the
 * app ships an inline pre-paint theme bootstrap and Tailwind inline styles.
 * Upgrade path (documented in SECURITY.md): switch to a per-request nonce in
 * src/proxy.ts and drop 'unsafe-inline' from script-src for full XSS hardening.
 */
const isDev = process.env.NODE_ENV === "development";

const csp = [
  "default-src 'self'",
  // React dev mode uses eval() for stack traces; production never needs it.
  // cdn.onesignal.com serves the web-push SDK; maps.googleapis.com the Maps JS;
  // checkout.razorpay.com the payment SDK, loaded on demand at checkout.
  // api.onesignal.com: the v16 SDK loads its app config as a JSONP script
  // (/sync/<app-id>/web); blocking it times out OneSignal init, so web push
  // never subscribes.
  `script-src 'self' 'unsafe-inline' https://cdn.onesignal.com https://api.onesignal.com https://maps.googleapis.com https://maps.gstatic.com https://checkout.razorpay.com${isDev ? " 'unsafe-eval'" : ""}`,
  // Google Maps injects a stylesheet + Roboto webfont.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://images.unsplash.com https://*.supabase.co https://*.onesignal.com https://onesignal.com https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.razorpay.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // OneSignal over WSS/HTTPS; Google Maps tiles/geocode/places over HTTPS;
  // Razorpay's API + its lumberjack telemetry host, both under *.razorpay.com.
  // nominatim.openstreetmap.org is the reverse-geocode fallback in
  // lib/utils/geocode.ts; without it a detected location never gets a name.
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.onesignal.com https://onesignal.com wss://*.onesignal.com https://maps.googleapis.com https://*.googleapis.com https://*.gstatic.com https://*.razorpay.com https://nominatim.openstreetmap.org",
  // The OneSignal service worker is served from our own origin.
  "worker-src 'self'",
  // Subscription/permission flow may open a OneSignal iframe. Razorpay Checkout
  // is an iframe too, and the bank/UPI redirect legs happen inside it — which
  // is why they need frame-src and not a hole in form-action.
  "frame-src 'self' https://*.onesignal.com https://onesignal.com https://*.razorpay.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  // Production only. This directive rewrites every http:// subresource to
  // https://, and it does so same-origin too — browsers exempt localhost, but
  // NOT a LAN IP. So `next dev -H 0.0.0.0` opened from a phone at
  // http://192.168.x.x:3005 upgraded its own CSS and JS to a port that speaks
  // no TLS, and the app rendered as unstyled HTML. It buys nothing in dev
  // (there is no https dev server to upgrade to) and production still sends it.
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(self), payment=()",
  },
];

const nextConfig: NextConfig = {
  // No reason to advertise the framework to scanners.
  poweredByHeader: false,
  // Parent ~/package-lock.json (unrelated) + this app's lockfiles confuse
  // Turbopack's workspace-root inference — pin explicitly to this project.
  turbopack: {
    root: projectRoot,
  },
  outputFileTracingRoot: projectRoot,
  // Lets next/image actually optimize (resize + AVIF/WebP negotiate) real
  // restaurant/menu photos instead of only working for local /public assets.
  // Mirrors the CSP's img-src allowlist above: Supabase storage for real
  // vendor uploads, Unsplash for the demo-mode/mock catalog.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "images.unsplash.com" },
    ],
  },
  // Testing on a real handset means loading /_next/* from a LAN IP, which the
  // dev server treats as cross-origin. Dev-only key: it is not read by
  // `next build`, and these are private ranges that cannot be reached from
  // outside the network the machine is already on.
  // Matched as dot-separated globs, not CIDR (see csrf-protection.ts), so the
  // private ranges are spelled as patterns.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.*.*.*"],
  experimental: {
    // Tab switches re-fetch the page from the server every time (the default is
    // 0 s for dynamic pages), and every customer page is dynamic. Reusing what
    // was fetched in the last 20 s makes a quick Home → Stores → Home hop free.
    //
    // Short on purpose: Home's active-order card has no live refresh of its
    // own. Every place the customer changes their own data calls
    // `router.refresh()` (which clears this cache), and sign-out is a plain form
    // post, a full page load, so one customer's pages never survive into the
    // next sign-in. `scripts/qa/router-reuse.ts` fails when a new customer-side
    // mutation is added without one.
    staleTimes: { dynamic: 20 },
  },
  // Observability moved from the admin console to the Developer panel. Old
  // links (bookmarks, alert and push deep links) keep working.
  async redirects() {
    return [
      {
        source: "/admin/observability",
        destination: "/developer/observability",
        permanent: false,
      },
      {
        source: "/admin/observability/:path*",
        destination: "/developer/observability/:path*",
        permanent: false,
      },
      // Feature access moved too.
      {
        source: "/admin/settings/features",
        destination: "/developer/features",
        permanent: false,
      },
    ];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // Private surfaces: robots.txt Disallow stops crawling but not indexing
        // of a URL discovered through an external link, and the root layout
        // emits `index, follow` when SITE_INDEXABLE=true. Say noindex at the
        // edge so no page-level metadata can be forgotten.
        source:
          "/:portal(admin|vendor|driver|manager|portals|switch|checkout|orders|profile|login|location|build)/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        // Every /api response is either user-scoped or an auth step. Next does
        // not cache route handlers by default, but nothing here says so out
        // loud — and a CDN or reverse proxy added later would happily serve one
        // customer's /api/me or /api/orders to the next visitor. Make it
        // explicit at the edge rather than relying on a framework default.
        //
        // Excludes app-version via a negative-lookahead segment rather than
        // matching "everything", so there is exactly one matching rule per
        // path — no ambiguity about which Cache-Control value a client sees.
        source: "/api/:path((?!app-version).*)",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0, must-revalidate" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
      {
        // The one genuine exception: a version-check answer with no user scope
        // and the same answer for every caller (see its own doc comment). Both
        // Android apps poll this on every cold start; a short public cache cuts
        // that down to one DB read per window instead of one per launch.
        source: "/api/app-version",
        headers: [{ key: "Cache-Control", value: "public, max-age=120" }],
      },
    ];
  },
};

export default nextConfig;
