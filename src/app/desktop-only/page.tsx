import type { Metadata } from "next";
import { DesktopOnlyNotice } from "@/components/admin/desktop-only-notice";

export const metadata: Metadata = {
  title: "Not made for mobile · Deligro",
  robots: { index: false, follow: false },
};

/** Where `src/proxy.ts` sends a phone asking for any admin address. */
export default function DesktopOnlyPage() {
  return <DesktopOnlyNotice />;
}
