import type { Metadata } from "next";
import { PortalLoginScreen } from "@/components/auth/portal-login-screen";

export const metadata: Metadata = { title: "Admin sign-in · Deligro" };

/** Reads the auth cookie — never prerendered. */
export const dynamic = "force-dynamic";

export default function AdminLoginPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ next?: string; denied?: string }>;
}>) {
  return <PortalLoginScreen portalKey="admin" searchParams={searchParams} />;
}
