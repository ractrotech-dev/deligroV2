import "server-only";
import { PageHeader, Section } from "@/components/admin/console";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { featureAccountById, featureExceptions, featureRows } from "@/lib/features/accounts.server";
import { customerSwitchesAvailable, featureSwitchesAvailable, listSwitches } from "@/lib/features/flags.server";
import type { AccountFeatureRole, FeatureAccount, FeatureActions } from "@/lib/features/switch-types";
import { AppFeaturesPanel, type FeatureSection } from "./app-features-panel";

const ROLES: AccountFeatureRole[] = ["customer", "vendor", "driver", "manager"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAccountFeatureRole(value: unknown): value is AccountFeatureRole {
  return ROLES.includes(value as AccountFeatureRole);
}

/**
 * What customers, shops, riders and managers can use: for everyone, with
 * exceptions for one person or one shop. Switching a feature off hides it in that
 * app and makes the server refuse it (src/lib/features). Core work (ordering,
 * accepting, delivering, the live board) and a rider's SOS are not listed and can't
 * be switched off.
 *
 * Rendered by Admin → App features and Developer → Feature access. **The page that
 * renders it must already have checked its role**: this reads with the service
 * role, and `actions` are that page's own role-gated Server Actions.
 */
export async function FeatureAccessScreen({
  actions,
  initialRole,
  initialAccountId,
}: Readonly<{
  actions: FeatureActions;
  initialRole?: string;
  initialAccountId?: string;
}>) {
  if (!isSupabaseConfigured) {
    return (
      <div className="admin-measure">
        <PageHeader title="App features" description="Connect Supabase to manage feature switches." />
      </div>
    );
  }

  const [available, customersReady, switches] = await Promise.all([
    featureSwitchesAvailable(),
    customerSwitchesAvailable(),
    listSwitches().catch(() => []),
  ]);

  const sections: FeatureSection[] = await Promise.all(
    ROLES.map(async (role) => ({
      role,
      rows: featureRows(role, switches),
      exceptions: await featureExceptions(role, switches).catch(() => []),
      blocked:
        role === "customer" && !customersReady
          ? "Customer switches can't be changed yet. Migration 0200 is not applied to this database."
          : undefined,
    }))
  );

  const role: AccountFeatureRole = isAccountFeatureRole(initialRole) ? initialRole : "customer";
  let account: FeatureAccount | null = null;
  if (initialAccountId && UUID.test(initialAccountId)) {
    account = await featureAccountById(role, initialAccountId).catch(() => null);
  }

  return (
    <div className="space-y-6">
      <PageHeader title="App features" />
      {!available ? (
        <Section title="Not active yet">
          <p className="text-sm text-muted">
            Migration <code>0052_role_feature_flags.sql</code> has not been applied to this database, so everything
            is at its default and changes can&apos;t be saved yet.
          </p>
        </Section>
      ) : null}
      <AppFeaturesPanel
        sections={sections}
        actions={actions}
        disabled={!available}
        initialRole={role}
        initialAccount={account}
      />
    </div>
  );
}
