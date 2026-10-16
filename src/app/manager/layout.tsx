import { ManagerShell } from "@/components/manager/manager-shell";
import { OneSignalInit } from "@/components/notifications/onesignal-init";
import { FeaturesProvider } from "@/components/features/features-provider";
import { getFeatures } from "@/lib/features/flags.server";
import { allOn } from "@/lib/features/catalog";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { resolveShellMode } from "@/lib/shell-mode.server";
import type { Metadata } from "next";

/**
 * Installs as its own home-screen app on iPhone/Android ("Add to Home
 * Screen" from this portal) — see src/lib/pwa/role-manifest.ts.
 */
export const metadata: Metadata = {
  manifest: "/manifests/manager",
  appleWebApp: { capable: true, title: "Deligro Manager", statusBarStyle: "default" },
};

/**
 * The Manager / Sub-Admin portal.
 *
 * Managers work from a phone at a gate and from a desk in an ops room, so this
 * carries the same app ↔ web switch as admin and vendor rather than forcing one
 * of them. It used to be `.device` unconditionally: an admin (this layout
 * admits them) or a manager on a laptop got a 402px iPhone mock with no way
 * out. See `ManagerShell`.
 *
 * The shell is resolved server-side so the console is the console in the first
 * byte of HTML — never a phone frame that swaps after hydration.
 */
export default async function ManagerLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [profile, shellMode] = await Promise.all([
    requireRole(["manager", "admin"]),
    resolveShellMode("manager"),
  ]);

  // Switches apply to managers; an admin using this portal has everything.
  const features =
    profile.role === "admin" ? allOn() : await getFeatures("manager", profile.id);

  return (
    <FeaturesProvider features={features}>
      {/* Ops alarms ("kitchen hasn't accepted", "no rider yet") are pushed. */}
      <OneSignalInit userId={isSupabaseConfigured ? profile.id : null} />
      <ManagerShell initialMode={shellMode}>{children}</ManagerShell>
    </FeaturesProvider>
  );
}
