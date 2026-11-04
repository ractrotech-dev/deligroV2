import type { Metadata } from "next";
import { DesktopOnlyGate } from "@/components/admin/desktop-only-notice";
import { PortalLoginScreen } from "@/components/auth/portal-login-screen";

export const metadata: Metadata = { title: "Admin sign-in · Deligro" };

/** Reads the auth cookie — never prerendered. */
export const dynamic = "force-dynamic";

export default function AdminLoginPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ next?: string; denied?: string }>;
}>) {
  return (
    <>
      <DesktopOnlyGate />
      <PortalLoginScreen portalKey="admin" searchParams={searchParams} />
    </>
  );
}
