import type { MetadataRoute } from "next";

import { THEME_BG } from "@/lib/theme-colors";

/**
 * Web app manifest — what makes the app installable.
 *
 * The root layout has always declared `appleWebApp: { capable: true }`, so
 * home-screen install was intended from the start; without this file Android
 * Chrome never offers it and the app can only be reached by typing a URL. In a
 * tier-3 market that is often the difference between a repeat customer and a
 * one-time visitor, and an installed vendor board is far less likely to be
 * closed by accident than a browser tab.
 *
 * It also matters for the push notifications this app already sends. OneSignal
 * is wired up and the server fans out order events (notifyOrderAccepted,
 * notifyOnTheWay, notifyDelivered) — installability is what makes those
 * reliably deliverable on Android.
 *
 * `start_url` is the customer feed, not a portal: operators reach their console
 * through /switch after signing in, and an installed icon that opened the admin
 * panel for a shopper would be the wrong front door.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Deligro — food delivery in Bemetara",
    short_name: "Deligro",
    description:
      "Freshly made, delivered warm — usually in under 30 minutes. Order from restaurants across Bemetara.",
    // Stable identity for the installed app. Without it a browser derives the id
    // from start_url, so changing that later would be treated as a different app
    // and the installed icon would orphan.
    id: "/",
    start_url: "/",
    scope: "/",
    lang: "en-IN",
    dir: "ltr",
    display: "standalone",
    orientation: "portrait",
    // Both match the light theme, which is the default (see `deligro-theme` in
    // layout.tsx) — these manifest values are static and can't follow the
    // in-app toggle, but they're only what paints the splash/status bar before
    // the page's own theme-color meta tag takes over, so they should match
    // whatever most launches actually render first. From THEME_BG rather than a
    // literal #ffffff: the light page is #f4f3f0, so white here hands the
    // installed app a splash that shifts colour the moment the page paints.
    background_color: THEME_BG.light,
    theme_color: THEME_BG.light,
    categories: ["food", "shopping"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Android crops icons to a circle or squircle. The `any` icons above have
      // transparent corners and would be visibly clipped; this one bleeds to
      // every edge with the artwork inside the centre 80% safe zone.
      {
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    // Long-press the installed icon. Only three, and each is a place someone
    // actually goes with intent — a shortcut list that mirrors the tab bar is
    // just a second tab bar the user has to read.
    //
    // `/orders` and `/switch` both sit behind a sign-in redirect, which is the
    // correct behaviour: the shortcut takes you to the door, and the door knows
    // where you were going.
    shortcuts: [
      {
        name: "Search restaurants",
        short_name: "Search",
        url: "/search",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "My orders",
        short_name: "Orders",
        url: "/orders",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Open my console",
        short_name: "Console",
        url: "/switch",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
    // There is no native app to hand off to, so never let a store listing
    // pre-empt the install prompt.
    prefer_related_applications: false,
  };
}
