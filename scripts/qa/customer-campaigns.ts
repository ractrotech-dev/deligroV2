/**
 * QA — Phase 7 customer surfaces: the featured-slot overlay as the feed
 * applies it, the sponsored-dish boost in search ranking, honest labels, and
 * the public track route's rules. Pure and structural.
 *
 * Usage:  npm run test:customer-campaigns
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { campaignLive, effectiveVendorPositions } from "../../src/lib/marketing/campaign-rules";
import { buildDishIndex, searchDishes, SPONSORED_BOOST } from "../../src/lib/search/dishes";
import type { MenuItem, Restaurant } from "../../src/types";

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}

const dish = (over: Partial<MenuItem> = {}): MenuItem => ({ id: "d1", name: "Paneer Roll", description: "", price: 120, category: "Rolls", veg: true, ...over });
const shop = (over: Partial<Restaurant> = {}): Restaurant => ({ slug: "shop", name: "Shop", tagline: "", cuisines: ["Rolls"], rating: 4.2,
  ratingCount: 50, etaMin: 25, etaMax: 35, priceTier: 2, costForTwo: 200, distanceKm: null, open: true, categories: [], menu: [dish()],
  accentTint: "", image: "", ...over } as Restaurant);

console.log("\n── featured slot, by the window ──");
const campaign = { status: "approved", startsAt: "2026-11-01T00:00:00+05:30", endsAt: "2026-11-08T00:00:00+05:30" };
check("not live before its start (even if the scheduler had run)", !campaignLive({ ...campaign, status: "in_progress" }, new Date("2026-10-31T23:59:00+05:30")));
check("live inside its window (even if the scheduler never ran)", campaignLive(campaign, new Date("2026-11-03T12:00:00+05:30")));
check("not live at its end", !campaignLive({ ...campaign, status: "in_progress" }, new Date("2026-11-08T00:00:00+05:30")));
check("a cancelled campaign is never live", !campaignLive({ ...campaign, status: "cancelled" }, new Date("2026-11-03T12:00:00+05:30")));
const feed = effectiveVendorPositions(new Map([["pinned", 2]]), [{ restaurantId: "featured", slot: 2 }]);
check("the featured shop takes its slot; the pinned shop moves down one", feed.get("featured") === 2 && feed.get("pinned") === 3);

console.log("\n── sponsored dishes ──");
const a = shop({ slug: "a", name: "Alpha", menu: [dish({ id: "x" })] });
const b = shop({ slug: "b", name: "Beta", menu: [dish({ id: "y", sponsored: { campaignId: "c1" } })] });
const hits = searchDishes(buildDishIndex([a, b]), "paneer roll");
const ha = hits.find((h) => h.restaurant.slug === "a"), hb = hits.find((h) => h.restaurant.slug === "b");
check("a sponsored dish outranks an equal one by exactly SPONSORED_BOOST", !!ha && !!hb && Math.abs(hb.score - ha.score - SPONSORED_BOOST) < 1e-9,
  { a: ha?.score, b: hb?.score });
check("the boost stays below one token match (140)", SPONSORED_BOOST < 140);
const other = searchDishes(buildDishIndex([shop({ slug: "c", menu: [dish({ name: "Veg Thali", sponsored: { campaignId: "c2" } })] }), a]), "paneer roll");
check("a sponsored dish that doesn't answer the query never outranks one that does", other[0]?.restaurant.slug === "a", other.map((h) => h.item.name));

console.log("\n── labels and tracking (structure) ──");
const src = (p: string) => readFileSync(join(__dirname, "../..", p), "utf8");
const card = src("src/components/shared/restaurant-card.tsx");
check("restaurant card labels a featured shop and tracks it", card.includes('t("Featured"') && card.includes("useCampaignImpression(featuredId)")
  && card.includes('trackCampaign(featuredId, "click")'));
for (const f of ["src/components/search/dish-card.tsx", "src/components/restaurant/menu-item-row.tsx"]) {
  const s = src(f);
  check(`${f}: labels a sponsored dish and tracks it`, s.includes('t("Sponsored"') && s.includes("useCampaignImpression(item.sponsored?.campaignId)")
    && s.includes('trackCampaign(item.sponsored.campaignId, "click")'));
}
const track = src("src/app/api/campaigns/track/route.ts");
check("track route: rate-limited per IP, ignores previews, records only live campaigns",
  track.includes("rateLimit(`campaign-track:${clientIp(request)}`, 120") && track.includes('placement === "preview"')
  && track.indexOf("campaignIsLive(") < track.indexOf("recordCampaignEvent("));
check("track route: only a customer is ever stamped on an event", track.includes('profile?.role === "customer" ? profile.id : null'));
check("track route: always answers 200 (beacon)", !/status: 4\d\d|status: 5\d\d/.test(track));
const feedSrc = src("src/lib/data-access/restaurants.ts");
check("the feed applies the featured overlay from live campaigns, one zone at a time, and labels only a shop that took its slot",
  feedSrc.includes("activeFeaturedCampaigns(") && feedSrc.includes("effectiveVendorPositionsByZone(") && feedSrc.includes("placedFeatured("));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
