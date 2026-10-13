import type { Metadata } from "next";
import { DeveloperShell } from "@/components/developer/developer-shell";
import { getProfile, requireRole } from "@/lib/auth";
import { resolveConsolePrefs } from "@/lib/console-theme.server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

// The panel holds stack traces and logs: never indexed, never cached.
export const metadata: Metadata = {
  title: "Developer panel · Deligro",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The operator's own email for the rail's account row. `profiles` does not carry
 * one, and it is chrome, so a failure drops the line rather than the page.
 */
async function developerEmail(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * The Developer panel's gate.
 *
 * `requireRole("developer")` here protects the pages under it, but, as
 * everywhere in this project, a layout guard is not what protects the data: each
 * page's actions and the data layer behind them (`lib/obs/*`, which reaches for
 * the service role) check the role again at their own boundary.
 *
 * An admin is not let in. The two roles are separate on purpose: the company's
 * operators do not need the app's internals, and the app's maintainers are not
 * the company's operators.
 */
export default async function DeveloperLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const developer = await requireRole("developer");

  const [profile, email, prefs] = await Promise.all([
    getProfile().catch(() => null),
    developerEmail(),
    resolveConsolePrefs(),
  ]);

  return (
    <DeveloperShell
      name={profile?.full_name?.trim() || developer.full_name?.trim() || "Developer"}
      email={email}
      prefs={prefs}
    >
      {children}
    </DeveloperShell>
  );
}
