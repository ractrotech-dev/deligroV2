import "server-only";
import Link from "next/link";
import { PageHeader, Section } from "@/components/admin/console";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { featureAccountById, featureExceptions, featureRows } from "@/lib/features/accounts.server";
import { featureSwitchesAvailable, listSwitches } from "@/lib/features/flags.server";
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

  const [available, switches] = await Promise.all([
    featureSwitchesAvailable(),
    listSwitches().catch(() => []),
  ]);

  const sections: FeatureSection[] = await Promise.all(
    ROLES.map(async (role) => ({
      role,
      rows: featureRows(role, switches),
      exceptions: await featureExceptions(role, switches).catch(() => []),
    }))
  );

  const role: AccountFeatureRole = isAccountFeatureRole(initialRole) ? initialRole : "customer";
  let account: FeatureAccount | null = null;
  if (initialAccountId && UUID.test(initialAccountId)) {
    account = await featureAccountById(role, initialAccountId).catch(() => null);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="App features"
        description="Choose what customers, shops, riders and managers can use. Off means hidden in their app and refused by the server. Set it for everyone, then change it for one person or one shop. Every change is in the audit log."
      />
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
      <Section title="Not on this page">
        <p className="text-sm text-muted">
          Grocery, Pick &amp; Drop, pharmacy, online payment and the cash limit are for everyone at once, in{" "}
          <Link href="/admin/settings/platform" className="font-semibold text-accent-ink hover:underline">
            Platform config
          </Link>
          . Ordering, tracking and a customer&apos;s way to reach Deligro have no switch, and neither do accepting and
          delivering orders or a rider&apos;s SOS.
        </p>
      </Section>
    </div>
  );
}
