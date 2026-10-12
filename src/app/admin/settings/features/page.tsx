import { requireRole } from "@/lib/auth";
import { PageHeader, Section } from "@/components/admin/console";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { listEmployees } from "@/lib/data-access/employees";
import { featureSwitchesAvailable, listSwitches } from "@/lib/features/flags.server";
import { FeatureAccessPanel, type Account } from "./feature-access-panel";

/**
 * Settings → Feature access. Platform: BOTH — a list of switches works on a
 * phone as well as at a desk.
 *
 * What each non-customer role may use, role-wide, with exceptions for one shop
 * or one person. Switching a feature off hides it in that app and makes the
 * server refuse it (src/lib/features). Core work — accepting, readying and
 * delivering orders, seeing the board — is not listed and cannot be switched
 * off. The admin layout has already required the admin role.
 */
export const dynamic = "force-dynamic";

async function listShops(): Promise<Account[]> {
  const { data } = await createAdminClient()
    .from("restaurants")
    .select("id, name")
    .order("name", { ascending: true })
    .limit(500);
  return ((data ?? []) as { id: string; name: string | null }[]).map((r) => ({
    id: r.id,
    name: r.name?.trim() || "Unnamed shop",
  }));
}

export default async function FeatureAccessPage() {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  if (!isSupabaseConfigured) {
    return (
      <div className="admin-measure">
        <PageHeader title="Feature access" description="Connect Supabase to manage feature switches." />
      </div>
    );
  }

  const [available, switches, shops, staff] = await Promise.all([
    featureSwitchesAvailable(),
    listSwitches().catch(() => []),
    listShops().catch(() => []),
    listEmployees().catch(() => []),
  ]);

  const accounts = {
    vendor: shops,
    manager: staff
      .filter((e) => e.role === "manager")
      .map((e) => ({ id: e.id, name: e.fullName ?? e.phone ?? "Manager" })),
    driver: staff
      .filter((e) => e.role === "driver")
      .map((e) => ({ id: e.id, name: e.fullName ?? e.phone ?? "Rider" })),
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Feature access"
        description="Choose what vendors, managers and riders can use. Off means hidden in their app and refused by the server. Set it for everyone, then make exceptions for one shop or one person."
      />
      {!available ? (
        <Section title="Not active yet">
          <p className="text-sm text-muted">
            Migration <code>0052_role_feature_flags.sql</code> has not been applied to this
            database, so every feature is on and changes here can&apos;t be saved yet. Run it in
            the Supabase SQL editor, then reload this page.
          </p>
        </Section>
      ) : null}
      <FeatureAccessPanel switches={switches} accounts={accounts} disabled={!available} />
    </div>
  );
}
