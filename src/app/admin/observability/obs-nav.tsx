"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils/cn";

/**
 * The section's own tab strip.
 *
 * Twelve destinations is far too many for the admin rail, which already carries
 * fifteen and is grouped for a reason. So Observability takes one rail slot and
 * everything under it navigates from here — the same shape the app uses for the
 * vendor detail page's tabs.
 *
 * Ordered by what an operator reaches for during an incident, not
 * alphabetically: the overview, then the queue of problems, then the four
 * business surfaces where a problem shows up as something a customer noticed,
 * then the technical views you drill into once you know where to look.
 */
export interface ObsTab {
  href: string;
  label: string;
  /** Longest-prefix wins, so `/issues/DEL-1000` still highlights Issues. */
  match: (path: string) => boolean;
}

const BASE = "/admin/observability";

export const OBS_TABS: ObsTab[] = [
  { href: BASE, label: "Overview", match: (p) => p === BASE },
  { href: `${BASE}/issues`, label: "Issues", match: (p) => p.startsWith(`${BASE}/issues`) },
  { href: `${BASE}/incidents`, label: "Incidents", match: (p) => p.startsWith(`${BASE}/incidents`) },
  { href: `${BASE}/orders`, label: "Orders", match: (p) => p.startsWith(`${BASE}/orders`) },
  { href: `${BASE}/payments`, label: "Payments", match: (p) => p.startsWith(`${BASE}/payments`) },
  { href: `${BASE}/delivery`, label: "Delivery", match: (p) => p.startsWith(`${BASE}/delivery`) },
  { href: `${BASE}/notifications`, label: "Notifications", match: (p) => p.startsWith(`${BASE}/notifications`) },
  { href: `${BASE}/api`, label: "API", match: (p) => p.startsWith(`${BASE}/api`) },
  { href: `${BASE}/logs`, label: "Logs", match: (p) => p.startsWith(`${BASE}/logs`) },
  { href: `${BASE}/alerts`, label: "Alerts", match: (p) => p.startsWith(`${BASE}/alerts`) },
];

/**
 * A client component only because the active tab depends on the current path,
 * and a server layout cannot read one. Nothing else here is interactive — the
 * tabs are ordinary links, so navigation still works before hydration.
 */
export function ObsNav() {
  const pathname = usePathname();
  return (
    // The console's own tab strip (`.c-tabs`), so this section's ten
    // destinations read as the same control as the five on Orders and the six
    // on a vendor record — rather than as a third thing that also happens to be
    // a row of links.
    <nav className="c-tabs no-scrollbar" aria-label="Observability sections">
      {OBS_TABS.map((tab) => {
        const on = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={on ? "page" : undefined}
            className={cn("c-tab", "press")}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
