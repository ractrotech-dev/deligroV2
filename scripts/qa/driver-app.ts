/**
 * QA — the courier app's three screens.
 *
 * The courier app was one screen until History and Profile were added, and the
 * layout's doc comment said so in as many words. Three things are worth holding
 * in place now that it is three.
 *
 * 1. **No fabricated rider data.** `driver/page.tsx` carries a long comment
 *    about the time invented jobs ("Blue Tokai Cafe", ₹62, in a city Deligro
 *    does not operate in) and a fabricated ₹640 of earnings were offered to
 *    real riders, with a "Demo data" label carrying the whole weight of it.
 *    Demo rows are allowed ONLY behind `!isSupabaseConfigured`, where there is
 *    no backend to contradict them. A history of deliveries somebody never made
 *    is that same mistake with a longer memory.
 *
 * 2. **History is scoped to the session, never the URL.** `getDriverHistory`
 *    runs through `createAdminClient()`, which is past RLS, so its
 *    `.eq("driver_id", …)` IS the authorization (AGENTS.md rule 5). A driver id
 *    read from a query string would be an IDOR onto every rider's history.
 *
 * 3. **Every screen is reachable, and the tab bar agrees with the routes.** An
 *    orphan screen under /driver is one nobody can get to from the app; a tab
 *    pointing at a route that does not exist is a 404 on the bottom bar.
 *
 * Reads source. Runs offline — no Supabase, no network.
 *
 * Usage:
 *   npm run test:driver-app
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { DRIVER_TABS } from "../../src/components/driver/driver-nav";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

console.log("\nCourier app — three screens, real data\n");

/** Every `page.tsx` under src/app/driver, as a route path. */
function driverRoutes(): string[] {
  const base = join(ROOT, "src/app/driver");
  const out: string[] = [];
  const walk = (dir: string, route: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, `${route}/${name}`);
      else if (name === "page.tsx") out.push(route || "/driver");
    }
  };
  walk(base, "/driver");
  return out.sort((a, b) => a.localeCompare(b));
}

const routes = driverRoutes();

// ---------------------------------------------------------------------------
// 1. Routes and tabs agree in both directions.
// ---------------------------------------------------------------------------
check(
  "all three screens exist",
  routes.length === 3,
  `found ${routes.length}: ${routes.join(", ")}`
);

for (const tab of DRIVER_TABS) {
  check(
    `tab "${tab.label}" points at a route that exists (${tab.href})`,
    routes.includes(tab.href),
    `routes on disk: ${routes.join(", ")}`
  );
}

for (const route of routes) {
  check(
    `route ${route} is reachable from the tab bar`,
    DRIVER_TABS.some((t) => t.href === route),
    "no tab links here, so nobody can reach it inside the app"
  );
}

// ---------------------------------------------------------------------------
// 2. Tab matching. Every screen is nested under /driver, so a prefix match on
//    the Jobs tab would light it up on all three at once.
// ---------------------------------------------------------------------------
const jobs = DRIVER_TABS.find((t) => t.href === "/driver")!;
check("Jobs is active on /driver", jobs.match("/driver"));
check(
  "Jobs is NOT active on /driver/history",
  !jobs.match("/driver/history"),
  "the Jobs tab matches by prefix, so it highlights on every screen"
);
check(
  "Jobs is NOT active on /driver/profile",
  !jobs.match("/driver/profile")
);

for (const tab of DRIVER_TABS) {
  const others = DRIVER_TABS.filter((t) => t.href !== tab.href);
  check(
    `exactly one tab is active on ${tab.href}`,
    tab.match(tab.href) && others.every((o) => !o.match(tab.href)),
    `others matching: ${others.filter((o) => o.match(tab.href)).map((o) => o.label).join(", ")}`
  );
}

check(
  "Jobs is the first tab — it is what the app opens on",
  DRIVER_TABS[0].href === "/driver",
  `first tab is ${DRIVER_TABS[0].href}`
);

// ---------------------------------------------------------------------------
// 3. No fabricated rider data outside the no-backend branch.
// ---------------------------------------------------------------------------
const DEMO_IMPORTS = /from "@\/lib\/roles-data"|from "@\/lib\/data"/;

for (const route of routes) {
  const file =
    route === "/driver"
      ? "src/app/driver/page.tsx"
      : `src/app${route}/page.tsx`;
  const src = read(file);

  const importsDemo = DEMO_IMPORTS.test(src);
  const guards = /!isSupabaseConfigured/.test(src);

  check(
    `${route}: any demo import is paired with an !isSupabaseConfigured guard`,
    !importsDemo || guards,
    "demo constants are imported with nothing gating them — real riders can be shown invented rows"
  );
}

const historyPage = read("src/app/driver/history/page.tsx");
check(
  "history imports no demo constants at all",
  !DEMO_IMPORTS.test(historyPage),
  "a fabricated delivery history is worse than fabricated jobs: it claims work somebody did not do"
);
check(
  "history renders an empty state with no backend rather than sample rows",
  /!isSupabaseConfigured/.test(historyPage) && /EmptyState/.test(historyPage),
  "with no backend it must show nothing, not examples"
);

// ---------------------------------------------------------------------------
// 4. History is scoped to the signed-in rider.
// ---------------------------------------------------------------------------
const dataAccess = read("src/lib/data-access/driver-orders.ts");

check(
  "getDriverHistory filters by driver_id",
  /getDriverHistory[\s\S]{0,2600}\.eq\("driver_id", driverId\)/.test(dataAccess),
  "the query is not scoped — it would return every rider's deliveries"
);
check(
  "getDriverHistory returns delivered rows only",
  /getDriverHistory[\s\S]{0,2600}\.eq\("status", "delivered"\)/.test(dataAccess),
  "unfinished or cancelled jobs would appear as completed deliveries"
);
check(
  "the history page takes driverId from requireRole, not searchParams",
  /requireRole\("driver"\)/.test(historyPage) &&
    /getDriverHistory\(profile\.id/.test(historyPage),
  "a driver id from the URL is an IDOR onto every rider's history (AGENTS.md rule 5)"
);
check(
  "the only searchParam the history page reads is the cursor",
  !/searchParams[\s\S]{0,400}driverId|driverId[^\n]*searchParams/.test(historyPage),
  "a driver id is being read from the URL"
);

// ---------------------------------------------------------------------------
// 5. Keyset paging, not offset. The list grows at the top while it is read.
// ---------------------------------------------------------------------------
check(
  "history pages by a delivered_at cursor",
  /\.lt\("delivered_at", cursor\)/.test(dataAccess),
  "offset paging repeats rows across page boundaries when a new delivery lands mid-scroll"
);
check(
  "history does not use .range( for paging",
  !/getDriverHistory[\s\S]{0,2600}\.range\(/.test(dataAccess),
  "`.range()` is offset paging by another name"
);

// ---------------------------------------------------------------------------
// 6. The layout's doc comment no longer claims the app is one screen.
// ---------------------------------------------------------------------------
const layout = read("src/app/driver/layout.tsx");
check(
  "the layout renders the tab bar",
  /<DriverTabBar\s*\/>/.test(layout),
  "the tab bar is defined but never mounted"
);
check(
  "the layout comment no longer says there is no tab bar",
  !/there is no tab bar here/.test(layout),
  "AGENTS.md: a stale comment is worse than none — this one asserts the opposite of what ships"
);

// ---------------------------------------------------------------------------
// 7. Navigate is ONE action: a hand-off to Google Maps turn-by-turn.
//
// It used to open an in-app route sheet — a second Google map, usually just a
// pin, with its own "Open in Google Maps" button — positioned `absolute` inside
// the scrolling content, so it slid under the tab bar with the job card's map
// showing beneath it. Riders reported "two maps pop up". The sheet is gone;
// these checks keep it from coming back by accident.
// ---------------------------------------------------------------------------
const board = read("src/components/driver/driver-board.tsx");
const phoneUtil = read("src/lib/utils/phone.ts");

check(
  "the in-app route sheet is deleted",
  !existsSync(join(ROOT, "src/components/driver/route-sheet.tsx")),
  "a second map surface behind Navigate is the 'two maps' bug"
);
check(
  "the board does not import a route sheet",
  !/RouteSheet|route-sheet/.test(board),
  "Navigate should hand off to Google Maps, not open an in-app map first"
);
check(
  "Navigate is a link to the directions URL, not an onClick",
  /href=\{navigationUrl\}[\s\S]{0,400}\/> Navigate/.test(board),
  "the active leg's Navigate must be a single <a href> to Google Maps"
);
check(
  "the board renders no third-party HTML via dangerouslySetInnerHTML",
  !/dangerouslySetInnerHTML\s*=/.test(board),
  "third-party markup never reaches the DOM"
);
check(
  "directions ask for two-wheeler turn-by-turn",
  /travelmode/.test(phoneUtil) &&
    /"two-wheeler"/.test(phoneUtil) &&
    /dir_action/.test(phoneUtil),
  "every rider is on two wheels and wants guidance, not a route preview"
);

// Two watches on one screen is two sets of GPS wake-ups for one answer, on a
// phone that is already on all shift.
const watches = (board.match(/watchPosition\(/g) ?? []).length;
check(
  "the board opens exactly one geolocation watch",
  watches === 1,
  `found ${watches}`
);

// ---------------------------------------------------------------------------
// 8. Completing a delivery says so.
//
// The success path used to be `router.refresh()` alone: the job card vanished
// and the rider could not tell "delivered" from "the app lost my job".
// ---------------------------------------------------------------------------
check(
  "the board shows a delivered confirmation",
  /Modal/.test(board) && /setDelivered\(completing\)/.test(board),
  "no success popup after the delivery code is accepted"
);
check(
  "the confirmation repeats the cash to collect on a COD order",
  /cashCollected/.test(board) && /Cash collected/.test(board),
  "a COD rider should see the amount once more at the door"
);
check(
  "a thrown server action surfaces as an error, not the error boundary",
  /advanceDeliveryAction\(orderId, code\);\s*\}\s*catch/.test(board),
  "an offline tap at the door would replace the whole board with an error page"
);
check(
  "a wrong code is announced (role=alert)",
  /role="alert"/.test(board),
  "the OTP error must be unmissable"
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
