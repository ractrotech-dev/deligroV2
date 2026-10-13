import { AdminShell } from "@/components/admin/admin-shell";
import { OneSignalInit } from "@/components/notifications/onesignal-init";
import { getProfile, requireRole } from "@/lib/auth";
import {
  getAdminNavCounts,
  type AdminNavCounts,
} from "@/lib/data-access/admin-stats";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { resolveConsolePrefs } from "@/lib/console-theme.server";

const NO_COUNTS: AdminNavCounts = {
  pendingApprovals: 0,
  pendingRefunds: 0,
  liveOrders: 0,
};

/**
 * The operator's own email, for the rail's account row. `profiles` does not
 * carry one — it lives on the auth user — and this is chrome, so a failure
 * here drops the line rather than the page.
 */
async function operatorEmail(): Promise<string | null> {
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

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const operator = await requireRole("admin");

  // The console's badges and its "signed in as". Both are chrome: a failure
  // here must not take the page under it down, so counts fall back to zero
  // (nothing to do) and the name to a neutral label — never to someone else's.
  const [counts, profile, email, prefs] = await Promise.all([
    isSupabaseConfigured
      ? getAdminNavCounts().catch(() => NO_COUNTS)
      : Promise.resolve(NO_COUNTS),
    getProfile().catch(() => null),
    operatorEmail(),
    // The console's own palette and rail width. Same reasoning as the shell
    // mode above: decided here, or the first paint is a guess that has to be
    // corrected after hydration.
    resolveConsolePrefs(),
  ]);

  return (
    <>
      {/* Ops alarms ("kitchen hasn't accepted", "no rider yet") are pushed. */}
      <OneSignalInit userId={isSupabaseConfigured ? operator.id : null} />
      <AdminShell
        prefs={prefs}
        counts={counts}
        name={profile?.full_name?.trim() || "Admin"}
        email={email}
      >
        {children}
      </AdminShell>
    </>
  );
}
