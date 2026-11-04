import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { AdminHero } from "@/components/admin/admin-ui";
import { ADMIN_NAV, enabledNav } from "@/components/admin/admin-nav";
import { requireRole } from "@/lib/auth";
import { adminFeaturesOff } from "@/lib/features/guards.server";

/**
 * Settings home: a list of the settings screens. The editing lives on each one.
 *
 * There is no Account section: MFA was removed in migration 0033 and the
 * security screen with it, so a row leading there would be a dead link. Admin
 * sign-in is a password alone — that is logged as accepted risk P-1 in
 * docs/SECURITY_AUDIT.md, which is where it belongs, not in a settings menu
 * that would imply there is something here to configure.
 */
export const dynamic = "force-dynamic";

/** Which screens this page lists, and one line on what each is for. */
const MENU_DESC: Record<string, string> = {
  "/admin/settings/platform": "Fees, tax, support hours, availability and rider dispatch",
  "/admin/settings/employees": "Create manager and rider logins, assign their zones",
  "/admin/settings/feature-access": "What customers, shops, riders and managers can use, for everyone or for one account",
  "/admin/settings/zones": "Cities and delivery zones managers are scoped to",
  "/admin/settings/sms": "Text shops when a new order arrives",
  "/admin/storage": "Food photos and home-strip category pictures",
};

export default async function AdminSettingsPage() {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so a page that reads service-role data checks for itself.
  await requireRole("admin");

  // A failed read shows everything rather than hiding a screen.
  const featuresOff = await adminFeaturesOff().catch(() => []);
  const items = enabledNav(ADMIN_NAV, featuresOff).filter(
    (item) => MENU_DESC[item.href]
  );

  return (
    <div className="admin-measure space-y-4">
      <AdminHero title="Settings" />
      <ul className="divide-y divide-[color:var(--c-divider)] border-y border-[color:var(--c-divider)]">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="flex items-center gap-3 py-2.5 hover:bg-[var(--c-hover)]"
            >
              <item.icon className="size-4 shrink-0 text-muted" />
              <span className="w-[180px] shrink-0 text-[13px] font-semibold text-ink">
                {item.label}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">
                {MENU_DESC[item.href]}
              </span>
              <ChevronRight className="size-3.5 shrink-0 text-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
