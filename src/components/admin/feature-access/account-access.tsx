import "server-only";
import Link from "next/link";
import { Section } from "@/components/admin/console";
import { ROLE_SUBJECT, featuresFor, type FeatureRole } from "@/lib/features/catalog";
import { featureSwitchesAvailable, listAccountSwitches, listSwitches } from "@/lib/features/flags.server";
import { setFeatureSwitchAsAdminAction } from "@/app/admin/settings/feature-access/actions";
import { AccountSwitchesPanel } from "./feature-access-panel";

/**
 * The same switches as Admin → App features, scoped to one account: each row is
 * Same as everyone, On or Off for this account only. Off hides the feature in their
 * app and the server refuses it (src/lib/features). Core work (ordering, accepting
 * and completing orders) and a rider's SOS have no switch.
 *
 * **The page that renders this must already have checked for an admin**: it
 * reads with the service role, and the save action re-checks the role itself.
 */
export async function AccountAccess({
  role,
  subjectId,
  subjectName,
}: Readonly<{ role: Extract<FeatureRole, "customer" | "driver" | "vendor">; subjectId: string; subjectName: string }>) {
  const [available, allSwitches, own] = await Promise.all([
    featureSwitchesAvailable(),
    listSwitches().catch(() => []),
    listAccountSwitches(ROLE_SUBJECT[role], subjectId).catch(() => []),
  ]);
  // What everyone gets, and this account's own rows with who set them. Nothing else
  // goes to the browser: a customer's exceptions are nobody else's page.
  const switches = [...allSwitches.filter((s) => s.subjectKind === "role"), ...own];
  const who = role === "driver" ? "rider" : role === "vendor" ? "shop" : "customer";

  return (
    <div className="admin-measure space-y-5">
      <Section
        title={`What ${subjectName} can use`}
        meta={`${featuresFor(role).length} switches`}
      >
        <p className="text-sm text-muted">
          Same as everyone follows the setting for every {who} in{" "}
          <Link href="/admin/settings/feature-access" className="font-semibold text-accent-ink hover:underline">
            App features
          </Link>
          . On or Off here applies to this {who} only. Off hides it in their app and the server refuses it.
          {role === "driver"
            ? " Going online, deliveries, cash collection on an order and SOS are never switched off."
            : role === "vendor"
              ? " Seeing and accepting orders is never switched off."
              : " Browsing, ordering and tracking are never switched off."}
        </p>
        {!available ? (
          <p className="mt-2 text-sm font-semibold text-deal">
            Migration 0052 isn&apos;t applied to this database, so everything is at its default and changes can&apos;t be saved yet.
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
