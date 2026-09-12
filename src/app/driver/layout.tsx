import { StatusBar } from "@/components/layout/status-bar";
import { DriverHeader } from "@/components/driver/driver-header";
import { DriverTabBar } from "@/components/driver/driver-tab-bar";
import { requireRole } from "@/lib/auth";

/**
 * The courier app runs in the phone frame, not the console shell.
 *
 * It used to render `.dashboard-shell` — the responsive web layout built for
 * the admin and vendor consoles — capped at 640px. On a laptop that produced a
 * 640px column of full-width cards floating on a page, which is not a thing any
 * rider will ever look at: the driver app is used one-handed, on a phone, at a
 * gate, and nowhere else. `.device` is the same frame the customer app uses, so
 * the layout being developed against is the layout that ships.
 *
 * No app↔web switch, unlike admin and vendor. Those two have a genuine desktop
 * audience — an operator at a desk, a kitchen with a tablet on the pass — and
 * the toggle exists so they can work at the size they actually have. There is
 * no desktop courier, so a switch would only offer a layout nobody should pick.
 *
 * The courier app used to be one screen, and this comment used to say so. It is
 * now three — Jobs, History, Profile — so the 80px foot padding that was
 * breathing room above the home indicator is real clearance for the tab bar.
 *
 * Jobs stays the app's front door. History and Profile are things a rider opens
 * between deliveries; neither should ever be what the app opens on, which is
 * why `DRIVER_TABS` orders them that way and why /driver matches exactly rather
 * than by prefix.
 */
export default async function DriverLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Delivery partners only — and it hands back the profile it already read, so
  // naming the rider in the header costs no second query. (`getProfile` is not
  // memoised, so calling it again here would be a real extra round trip.)
  const profile = await requireRole("driver");

  return (
    <div className="device">
      <div className="app-shell">
        <div className="app-scroll no-scrollbar pb-[80px]">
          <DriverHeader name={profile.full_name} />
          <div className="@container px-4 pb-6 pt-4">{children}</div>
        </div>
        <DriverTabBar />
        <StatusBar />
      </div>
    </div>
  );
}
