import type { Metadata } from "next";
import { PortalLoginScreen } from "@/components/auth/portal-login-screen";

export const metadata: Metadata = {
  title: "Developer sign-in · Deligro",
  // The panel is not for search engines or for sharing.
  robots: { index: false, follow: false },
};

/** Reads the auth cookie — never prerendered. */
export const dynamic = "force-dynamic";

export default function DeveloperLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; denied?: string }>;
}) {
  return <PortalLoginScreen portalKey="developer" searchParams={searchParams} />;
}
