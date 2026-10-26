import "server-only";
import Link from "next/link";
import { Section } from "@/components/admin/console";
import { featuresFor, type FeatureRole } from "@/lib/features/catalog";
import { featureSwitchesAvailable, listSwitches } from "@/lib/features/flags.server";
import { setFeatureSwitchAsAdminAction } from "@/app/admin/settings/feature-access/actions";
import { AccountSwitchesPanel } from "./feature-access-panel";

/**
 * The Access tab on Admin → Riders → one rider and Admin → Vendors → one shop:
 * what this rider or this shop may use, switch by switch. Platform: BOTH.
 *
 * The same switches as Admin → Feature access, scoped to one account: each
 * row is Default (follow everyone), On or Off for this account only. Off hides
 * the section in their app and the server refuses it (src/lib/features).
 * Core work (accepting and completing orders) and a rider's SOS have no switch.
 *
 * **The page that renders this must already have checked for an admin**: it
 * reads with the service role, and the save action re-checks the role itself.
 */
export async function AccountAccess({
  role,
  subjectId,
  subjectName,
}: Readonly<{ role: Extract<FeatureRole, "driver" | "vendor">; subjectId: string; subjectName: string }>) {
  const [available, switches] = await Promise.all([
    featureSwitchesAvailable(),
    listSwitches().catch(() => []),
  ]);
  const who = role === "driver" ? "rider" : "shop";

  return (
    <div className="admin-measure space-y-5">
      <Section
        title={`What ${subjectName} can use`}
        meta={`${featuresFor(role).length} switches`}
      >
        <p className="text-sm text-muted">
          Default follows the setting for every {who} in{" "}
          <Link href="/admin/settings/feature-access" className="font-semibold text-accent-ink hover:underline">
            Feature access
          </Link>
          . On or Off here applies to this {who} only. Off hides it in their app and the server refuses it.
          {role === "driver"
            ? " Going online, deliveries, cash collection on an order and SOS are never switched off."
            : " Seeing and accepting orders is never switched off."}
        </p>
        {!available ? (
          <p className="mt-2 text-sm font-semibold text-deal">
            Migration 0052 isn&apos;t applied to this database, so everything is on and changes can&apos;t be saved yet.
          </p>
        ) : null}
      </Section>
      <AccountSwitchesPanel
        role={role}
        subjectId={subjectId}
        switches={switches}
        disabled={!available}
        save={setFeatureSwitchAsAdminAction}
      />
    </div>
  );
}
