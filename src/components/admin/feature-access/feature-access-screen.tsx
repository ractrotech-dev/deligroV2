import "server-only";
import { PageHeader, Section } from "@/components/admin/console";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { listEmployees } from "@/lib/data-access/employees";
import { featureSwitchesAvailable, listSwitches } from "@/lib/features/flags.server";
import type { SwitchInput, SwitchResult } from "@/lib/features/switch-types";
import { FeatureAccessPanel, type Account } from "./feature-access-panel";

/**
 * Feature access, the screen. Platform: BOTH — a list of switches works on a
 * phone as well as at a desk.
 *
 * What each non-customer role may use, role-wide, with exceptions for one shop
 * or one person. Switching a feature off hides it in that app and makes the
 * server refuse it (src/lib/features). Core work — accepting, readying and
 * delivering orders, seeing the board — is not listed and cannot be switched
 * off.
 *
 * Rendered by Admin → Feature access and Developer → Feature access. **The page
 * that renders it must already have checked its role**: this reads with the
 * service role, and `save` is that page's own role-gated Server Action.
 */
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

export async function FeatureAccessScreen({
  save,
}: Readonly<{ save: (input: SwitchInput) => Promise<SwitchResult> }>) {
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
        description="Choose what vendors, managers and riders can use. Off means hidden in their app and refused by the server. Set it for everyone, then make exceptions for one shop or one person — here, or on that rider's or shop's Access tab. Sensitive manager powers (payments, corrections, customer contact) start off."
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
      <FeatureAccessPanel switches={switches} accounts={accounts} disabled={!available} save={save} />
    </div>
  );
}
