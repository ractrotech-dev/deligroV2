import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { loginPathForRole } from "@/lib/auth/portals";
import { getPlatformLock, lockBlocksConsole } from "@/lib/platform-lock";

export type Role =
  | "customer"
  | "restaurant"
  | "driver"
  | "admin"
  | "manager"
  | "developer";

export interface Profile {
  id: string;
  role: Role;
  full_name: string | null;
  phone: string | null;
}

/**
 * Current user's profile, or null if signed out / not configured.
 *
 * `cache()` dedupes this within a single request: the layout, a page's own
 * `requireUser`/`requireRole`, and any component further down all call this,
 * and used to each pay for two sequential Supabase round trips (auth.getUser
 * then a profiles select) for the same answer.
 */
export const getProfile = cache(async (): Promise<Profile | null> => {
  if (!isSupabaseConfigured) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("id, role, full_name, phone")
    .eq("id", user.id)
    .single();

  return (data as Profile) ?? null;
});

/**
 * Demo mode hands back a synthetic profile so the static UI renders without
 * Supabase keys. That is a dev-only convenience: in production, "no keys" means
 * the credentials failed to load, and answering that with a free pass would turn
 * a config outage into an authorization bypass. config.ts already refuses to
 * boot in that state; this is the second lock, so the bypass stays unreachable
 * even if that guard is ever relaxed.
 */
function assertDemoModeAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("backend_not_configured");
  }
}

/** Require a signed-in user, else send to login. */
export async function requireUser(): Promise<Profile> {
  if (!isSupabaseConfigured) {
    assertDemoModeAllowed();
    return DEMO_PROFILE("customer");
  }
  const profile = await getProfile();
  if (!profile) redirect("/login");
  return profile;
}

/**
 * Require a signed-in user whose role is allowed here. This is the server-side
 * role check (check #2 of authenticated -> role -> ownership). Wrong role gets a
 * consistent redirect — the UI never decides access on its own.
 *
 * The redirect goes to the door for the role that was *required*, not the one
 * the visitor has: a customer who opens /admin lands on the admin sign-in page
 * and is told that account can't open it, rather than being dumped on their own
 * login with no explanation.
 *
 * In demo mode (no Supabase keys) it passes through so the static UI renders.
 */
export async function requireRole(role: Role | Role[]): Promise<Profile> {
  const allowed = Array.isArray(role) ? role : [role];
  if (!isSupabaseConfigured) {
    assertDemoModeAllowed();
    return DEMO_PROFILE(allowed[0]);
  }

  const profile = await requireUser();
  if (!allowed.includes(profile.role)) {
    redirect(`${loginPathForRole(allowed[0])}?denied=1`);
  }
  // The developer's full pause (0177) closes the Admin console and Manager
  // pages and their actions; the paused screen says why.
  if ((profile.role === "admin" || profile.role === "manager") && lockBlocksConsole(await getPlatformLock(), profile.role)) {
    redirect("/paused");
  }
  return profile;
}

function DEMO_PROFILE(role: Role): Profile {
  return { id: "demo-user", role, full_name: "Demo user", phone: null };
}
