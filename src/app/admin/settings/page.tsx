import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { AdminHero } from "@/components/admin/admin-ui";
import { ConsoleOnlyNotice } from "@/components/admin/console-only";
import { ADMIN_PHONE_MENU } from "@/components/admin/admin-nav";

/**
 * Settings home = a menu, not a form. Each row is a tap target that routes to
 * the screen that owns it (platform config, the ops shortcuts). The actual
 * editing lives on the sub-pages so this stays a clean settings tab.
 *
 * There is no Account section: MFA was removed in migration 0033 and the
 * security screen with it, so a row leading there would be a dead link. Admin
 * sign-in is a password alone — that is logged as accepted risk P-1 in
 * docs/SECURITY_AUDIT.md, which is where it belongs, not in a settings menu
 * that would imply there is something here to configure.
 *
 * Sections marked `phoneOnly` are the phone's second half of its navigation.
 * Five bottom tabs cannot carry eleven destinations, so everything without a
 * tab is listed here — derived from ADMIN_PHONE_MENU rather than hand-written,
 * so adding a nav item cannot silently strand it on a handset. In the console
 * the rail already lists all of it, and showing the same link twice there would
 * only be noise, so these sections drop out at `@3xl`.
 *
 * Platform configuration is the exception: it is console-only, so the phone
 * gets a note explaining where it went instead of a row that leads to one.
 */
export const dynamic = "force-dynamic";

/** Toned icon chips, matching the dashboard cards and the bottom nav. */
const ICON_TONE = {
  accent: "bg-accent/12 text-accent",
  green: "bg-green/12 text-green",
  blue: "bg-blue/12 text-blue",
  deal: "bg-deal/12 text-deal",
  violet: "bg-violet-500/15 text-violet-500",
  // Amber on a pale chip fails contrast, so this one takes its dark ink — the
  // same pairing the phone tab bar uses for the Campaigns tone.
  pop: "bg-pop/25 text-pop-ink",
} as const;

type IconTone = keyof typeof ICON_TONE;

/**
 * One line of "what is this" per derived row. Kept here rather than on the nav
 * item: the rail and the tab bar show a label alone, and only this menu has the
 * room to explain. A missing entry just renders the label, so a new nav item
 * degrades quietly instead of breaking the page.
 */
const MENU_DESC: Record<string, string> = {
  "/admin/settlements": "Vendor payout batches & statements",
  "/admin/vendors/slots": "What the customer app features, and in what order",
  "/admin/banners": "Pause or end a live campaign",
  "/admin/customers": "Directory, order history & contact",
  "/admin/settings/employees": "Create manager & driver logins",
  "/admin/storage": "Food photos and home-strip category pictures",
};

export default function AdminSettingsPage() {
  return (
    <div className="admin-measure space-y-6">
      <AdminHero
        title="Settings"
        subtitle="Platform configuration — fees, support, availability & ops"
      />

      {/* Platform config is console-only (see its page), so the phone gets the
          reason rather than a row that leads to a notice. This is the whole
          Configuration group — there is nothing else in it. */}
      <section className="@3xl:hidden">
        <h2 className="text-label mb-2">Configuration</h2>
        <ConsoleOnlyNotice
          tool="Platform configuration"
          why="Fees, tax, support hours, availability and the rider payout formula all live behind it, and each one reaches every order."
        />
      </section>

      {/* Everything the phone can use that has no bottom tab. Derived from the
          nav so a new destination can't quietly become unreachable here. */}
      <Group label="Manage" phoneOnly>
        {ADMIN_PHONE_MENU.map((item) => (
          <Row
            key={item.href}
            href={item.href}
            icon={item.icon}
            label={item.label}
            desc={MENU_DESC[item.href]}
            tone={item.tone}
          />
        ))}
      </Group>
    </div>
  );
}

function Group({
  label,
  children,
  phoneOnly = false,
}: {
  label: string;
  children: React.ReactNode;
  /** Hidden in the console, where the sidebar carries these destinations. */
  phoneOnly?: boolean;
}) {
  return (
    // A container query, not a breakpoint: the phone frame is a ~390px column
    // on the same desktop viewport as the console, so `@3xl` is what actually
    // distinguishes the two shells here. Below that width in web mode the rows
    // stay — the rail is a drawer there, and a visible link beats a hidden one.
    <section className={phoneOnly ? "@3xl:hidden" : undefined}>
      <h2 className="text-label mb-2">{label}</h2>
      {/* A divided list in the phone frame; separate cards in the console,
          where a full-width row with one chevron at the far right reads as an
          empty shelf rather than a menu. */}
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface @3xl:grid @3xl:grid-cols-2 @3xl:gap-4 @3xl:divide-y-0 @3xl:rounded-none @3xl:border-0 @3xl:bg-transparent">
        {children}
      </div>
    </section>
  );
}

function Row({
  href,
  icon: Icon,
  label,
  desc,
  tone = "accent",
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  desc?: string;
  tone?: IconTone;
}) {
  return (
    <Link
      href={href}
      // Two faces, as everywhere else: a full-bleed tappable row inside the
      // phone frame, a bordered tile in the console. The console tile keeps its
      // border because these *are* the page — a settings index is a set of
      // destinations, and there is nothing else for a hairline to separate them
      // from.
      className="press flex items-center gap-3 px-4 py-3 @3xl:rounded-[var(--c-r)] @3xl:border @3xl:border-line @3xl:bg-surface @3xl:px-3 @3xl:py-2.5 @3xl:transition-colors @3xl:hover:border-[var(--c-border-hover)]"
    >
      <span
        className={`grid size-8 shrink-0 place-items-center rounded-[var(--c-r)] @3xl:size-7 ${ICON_TONE[tone]}`}
      >
        <Icon className="size-4 @3xl:size-[15px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-ink @3xl:text-[12.5px]">
          {label}
        </span>
        {desc ? (
          <span className="block truncate text-xs text-muted @3xl:text-[11px]">
            {desc}
          </span>
        ) : null}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted @3xl:size-3.5 @3xl:text-[color:var(--c-faint)]" />
    </Link>
  );
}
