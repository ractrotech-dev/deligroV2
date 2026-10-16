import type { Metadata } from "next";
import { LangProvider } from "@/components/providers/lang-provider";
import { getLang } from "@/lib/i18n/server";

// robots.txt already disallows /login, but a disallowed page can still be listed
// as a bare URL; noindex is what actually keeps the sign-in door out of results.
export const metadata: Metadata = { robots: { index: false, follow: true } };

// The login screen speaks whatever language the app is set to, so it reads the
// same cookie the app does. The switch itself lives in the customer profile.
export default async function LoginLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <LangProvider initial={await getLang()}>{children}</LangProvider>;
}
