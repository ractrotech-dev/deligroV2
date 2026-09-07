import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { InlineScript } from "@/components/shared/inline-script";
import { PwaProvider } from "@/components/pwa/pwa-provider";
import { ErrorReporter } from "@/components/providers/error-reporter";
import { IS_INDEXABLE, SITE_URL } from "@/lib/site";
import { THEME_BG } from "@/lib/theme-colors";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono-jb",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  // Without this, every relative image and canonical path below (and in each
  // page's own generateMetadata) stays relative — and a crawler or a WhatsApp
  // link preview needs absolute URLs, so it silently gets nothing.
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Deligro — food delivery in Bemetara",
    // Pages set their own bare title; this frames it. Keeps every tab and search
    // result identifiable without each page repeating the brand.
    template: "%s · Deligro",
  },
  description:
    "Order from restaurants across Bemetara. Freshly made, delivered warm — usually in under 30 minutes.",
  applicationName: "Deligro",
  appleWebApp: { capable: true, title: "Deligro", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // iOS does not round transparent corners, it renders them black — this one
    // is flattened onto white for that reason.
    apple: [{ url: "/icons/apple-icon-180.png", sizes: "180x180" }],
  },
  openGraph: {
    type: "website",
    siteName: "Deligro",
    locale: "en_IN",
    title: "Deligro — food delivery in Bemetara",
    description:
      "Order from restaurants across Bemetara. Freshly made, delivered warm.",
    images: [{ url: "/icons/icon-512.png", width: 512, height: 512 }],
  },
  twitter: { card: "summary", title: "Deligro", description: "Food delivery in Bemetara." },
  // A staging or preview host that indexes itself competes with production for
  // the same queries. Opt in per environment; see lib/site.ts.
  robots: IS_INDEXABLE
    ? { index: true, follow: true }
    : { index: false, follow: false },
};

export const viewport: Viewport = {
  // Static, not a `prefers-color-scheme` pair: Deligro's theme is an in-app
  // toggle (see `deligro-theme` below), independent of the phone's OS setting.
  // Keying this off the OS scheme meant a phone in system dark mode painted
  // the status bar/Dynamic Island strip near-black while the app itself was
  // still rendering its light-default theme underneath — a dark band sitting
  // directly on top of the light UI instead of blending into it. The
  // bootstrap script below and `applyTheme` in ui-store.ts now keep the real
  // meta tag's content in sync with whichever theme is actually on screen.
  //
  // The value is THEME_BG.light rather than a literal #ffffff because the light
  // page is #f4f3f0, not white. A white strip above an off-white page is the
  // same defect as the dark band, only two shades narrower — the eye still
  // reads a line across the top of the screen. THEME_BG is the one place both
  // colours are written down; `npm run test:theme-color` asserts they still
  // equal the --bg declarations in globals.css.
  themeColor: THEME_BG.light,
  width: "device-width",
  initialScale: 1,
  // Required for `env(safe-area-inset-*)` to resolve to anything but 0. This
  // stylesheet has used those insets from the start — --status-h, the tab bar's
  // bottom padding, the sticky docks — and without viewport-fit they were all
  // silently computing to zero on exactly the devices they were written for, so
  // an installed app on a notched iPhone drew its status bar under the notch
  // and its tab bar under the home indicator.
  viewportFit: "cover",
  // No `maximumScale`. Pinch-zoom is the only escape hatch a customer with weak
  // near vision has, and this app's audience skews toward first-time smartphone
  // users, shopkeepers reading the vendor board, and riders squinting at a phone
  // in daylight. Locking the scale fails WCAG 1.4.4 (Resize Text) and is
  // especially wrong here, where the type is small to begin with.
};

/* Light by default; set before paint to avoid a flash. Only an explicit saved
   choice ('light' or 'dark') overrides it — anything else falls back to light.
   Also repaints the theme-color meta tag `viewport` above renders statically,
   so a saved 'dark' choice recolors the status bar before first paint instead
   of leaving it on the light default until React hydrates.

   It creates the tag if it is somehow missing rather than giving up. Nothing
   else re-reads theme-color for the life of the session — `initTheme` only
   syncs the store *from* the DOM and never calls `applyTheme` — so a silent
   no-op here would strand a dark-theme visitor under a light strip until their
   next hard load, which is precisely the bug this is fixing. */
const themeBootstrap = `
(function () {
  try {
    var saved = localStorage.getItem('deligro-theme');
    var theme = (saved === 'dark' || saved === 'light') ? saved : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', theme === 'dark' ? '${THEME_BG.dark}' : '${THEME_BG.light}');
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <InlineScript html={themeBootstrap} />
      </head>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} antialiased`}
      >
        {children}
        {/* Last children, and both render nothing until after hydration: the
            PWA layer is additive, so it must never be in the way of the app
            painting, and neither must the error reporter. */}
        <PwaProvider />
        {/* Global window.onerror / unhandledrejection listeners. Here rather
            than per-surface so the vendor board and the rider board are covered
            too — those run all day on cheap handsets and are where a silent
            client crash costs somebody money. */}
        <ErrorReporter />
      </body>
    </html>
  );
}
