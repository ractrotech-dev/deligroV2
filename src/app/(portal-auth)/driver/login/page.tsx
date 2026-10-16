import type { Metadata } from "next";
import { PortalLoginScreen } from "@/components/auth/portal-login-screen";

// The manifest too, so "Add to Home Screen" from this sign-in page installs
// the Deligro Rider app, not the customer one (src/lib/pwa/role-manifest.ts).
export const metadata: Metadata = {
  title: "Driver sign-in · Deligro",
  manifest: "/manifests/rider",
  appleWebApp: { capable: true, title: "Deligro Rider", statusBarStyle: "default" },
};

/** Reads the auth cookie — never prerendered. */
export const dynamic = "force-dynamic";

export default function DriverLoginPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ next?: string; denied?: string }>;
}>) {
  return <PortalLoginScreen portalKey="driver" searchParams={searchParams} />;
}
