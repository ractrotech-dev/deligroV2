import "server-only";
import { isLiveDishRow } from "@/lib/menu/live";
import { createClient, createPublicClient } from "@/lib/supabase/server";
import { getMenuPopularity, type Popularity } from "@/lib/data-access/menu-popularity";
import {
  applyVendorOrder,
  getVendorPositions,
} from "@/lib/data-access/vendor-positions";
import { kitchenPace } from "@/lib/orders/kitchen-pace";
import { updateVendorRestaurant } from "@/lib/data-access/vendor-restaurant";
import { liveShopStatuses } from "@/lib/data-access/shop-status";
import type { ShopStatus } from "@/lib/orders/order-options";
import type { Cuisine, MenuItem, PriceTier, Restaurant } from "@/types";
import { activeFeaturedCampaigns, activeSponsoredItems, zonesOfShops } from "@/lib/data-access/manager-marketing";
import { effectiveVendorPositionsByZone, placedFeatured } from "@/lib/marketing/campaign-rules";
import { weatherMinutesForShops } from "@/lib/data-access/zone-weather";

interface DbMenuItem {
  id: string;
  external_id: string | null;
  name: string;
  description: string | null;
  price: number;
  discount_price: number | null;
  veg: boolean;
  available: boolean;
  category: string | null;
  image_url: string | null;
  popular: boolean;
  bestseller: boolean;
  // Optional: absent on a database that predates migration 0146.
  approval_status?: string | null;
  pending_price?: number | null;
  hidden_by_ops?: boolean | null;
  // Optional: absent entirely on a database that predates migration 0062.
  stock_qty?: number | null;
  available_days?: number[] | null;
  available_from?: string | null;
  available_to?: string | null;
  menu_item_variants?: DbOption[];
  menu_item_addon_groups?: (DbSorted & {
    id: string;
    name: string;
    min_select: number;
    max_select: number;
    menu_item_addons?: DbOption[];
  })[];
}

interface DbSorted {
  sort_order: number;
}

type DbOption = DbSorted & { id: string; name: string; price: number; available: boolean };

interface DbRestaurantRow {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  is_open: boolean;
  opening_time: string | null;
  image_url: string | null;
  accent_tint: string | null;
  cuisines: string[];
  rating: number;
  rating_count: number;
  eta_min: number | null;
  eta_max: number | null;
  price_tier: number;
  cost_for_two: number | null;
  distance_km: number | null;
  // Optional: absent entirely on a database that predates migration 0009.
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  offer: string | null;
  // Optional: absent entirely on a database that predates migration 0041.
  offer_expires_at?: string | null;
  promoted: boolean;
  // Optional: absent entirely on a database that predates migration 0036.
  prep_minutes?: number | null;
  busy_until?: string | null;
  busy_extra_minutes?: number | null;
  // Absent entirely when the query was run with `withMenu: false` (list
  // surfaces that never render menu data — see `mapRestaurant`'s `?? []`).
  menu_items?: DbMenuItem[];
}

/**
 * The shop-location columns (migration 0009) are selected only when the database
 * actually has them. Asking for a column that doesn't exist is a hard 400 from
 * PostgREST, which would take the whole catalog down — so a database that hasn't
 * run 0009 yet simply serves shops without a pin, and they fall back to the
 * seeded `distance_km`. Delete this branch once every environment is migrated.
 */
function restaurantSelect(
  withLocation: boolean,
  withPace: boolean,
  withOfferWindow: boolean,
  withMenu: boolean,
  withInventory: boolean,
  withModeration = false
): string {
  // 0146: a dish's moderation state, so a staff account browsing the storefront
  // (RLS shows owners, managers and admins every dish) sees only what a
  // customer sees — mapRestaurant drops anything not live.
  const moderation = withModeration ? ", approval_status, pending_price, hidden_by_ops" : "";
  // 0062: a dish's schedule, stock and its sizes / add-ons, embedded so the
  // storefront is still one query.
  const inventory = withInventory
    ? `, stock_qty, available_days, available_from, available_to,
      menu_item_variants (id, name, price, available, sort_order),
      menu_item_addon_groups (id, name, min_select, max_select, sort_order,
        menu_item_addons (id, name, price, available, sort_order))`
    : "";
  return `
    id, slug, name, tagline, is_open, opening_time,
    image_url, accent_tint, cuisines, rating, rating_count,
    eta_min, eta_max, price_tier, cost_for_two, distance_km,
    ${withLocation ? "lat, lng, address," : ""}
    ${withPace ? "prep_minutes, busy_until, busy_extra_minutes," : ""}
    ${withOfferWindow ? "offer_expires_at," : ""}
    offer, promoted
    ${
      withMenu
        ? `, menu_items (
      id, external_id, name, description, price, discount_price, veg, available,
      category, image_url, popular, bestseller${moderation}${inventory}
    )`
        : ""
    }
  `;
}

/** null = not asked yet. Latches after the first query, so we probe once. */
let hasShopLocation: boolean | null = null;
/** Same, for the 0036 pace columns. Separate because the migrations are. */
let hasKitchenPace: boolean | null = null;
/** Same, for 0041's `offer_expires_at`. */
let hasOfferWindow: boolean | null = null;
/** Same, for 0062's menu schedule/stock columns and option tables. */
let hasMenuInventory: boolean | null = null;
/** Same, for 0146's moderation columns. */
let hasMenuModeration: boolean | null = null;

/** PostgREST's "column does not exist". */
const UNDEFINED_COLUMN = "42703";

interface QueryResult<T> {
  data: T | null;
  error: { code?: string } | null;
}

/** A query just succeeded: every column group it still asked for exists. */
function latchSelectedColumnsPresent(): void {
  if (hasShopLocation !== false) hasShopLocation = true;
  if (hasKitchenPace !== false) hasKitchenPace = true;
  if (hasOfferWindow !== false) hasOfferWindow = true;
}

/**
 * A missing column (42703), or, for the embedded 0062 option tables, a
 * relationship PostgREST doesn't know yet (PGRST200).
 */
function isMissingSchema(error: { code?: string }): boolean {
  return error.code === UNDEFINED_COLUMN || error.code === "PGRST200";
}

/**
 * Run a catalog query with the shop-location columns, retrying without them if
 * the database predates migration 0009.
 */
async function selectRestaurants<T>(
  run: (select: string) => PromiseLike<QueryResult<T>>,
  withMenu = true
): Promise<T | null> {
  // Dropped newest-migration-first: `isMissingColumn` doesn't say WHICH column
  // is absent, so a database with 0009 but not 0036 must not lose its shop pins
  // to a failed probe for the pace columns.
  const groups: Array<[() => boolean, (v: boolean) => void]> = [
    // Only probed when the menu is asked for: it lives in the menu join.
    [() => withMenu && hasMenuModeration !== false, (v) => (hasMenuModeration = v)],
    [() => withMenu && hasMenuInventory !== false, (v) => (hasMenuInventory = v)],
    [() => hasOfferWindow !== false, (v) => (hasOfferWindow = v)],
    [() => hasKitchenPace !== false, (v) => (hasKitchenPace = v)],
    [() => hasShopLocation !== false, (v) => (hasShopLocation = v)],
  ];

  for (const [optimistic, latch] of groups) {
    if (!optimistic()) continue;
    const { data, error } = await run(
      restaurantSelect(
        hasShopLocation !== false,
        hasKitchenPace !== false,
        hasOfferWindow !== false,
        withMenu,
        withMenu && hasMenuInventory !== false,
        withMenu && hasMenuModeration !== false
      )
    );
    if (!error) {
      latchSelectedColumnsPresent();
      // A list without the menu says nothing about the menu's columns.
      if (withMenu && hasMenuInventory !== false) hasMenuInventory = true;
      if (withMenu && hasMenuModeration !== false) hasMenuModeration = true;
      return data;
    }
    if (!isMissingSchema(error)) throw error;
    latch(false);
  }

  const { data, error } = await run(restaurantSelect(false, false, false, withMenu, false));
  if (error) throw error;
  return data;
}

const FALLBACK_TINT = "linear-gradient(135deg,#f6c453,#e8552d)";

/** The shop's badge, or nothing once the coupon behind it has lapsed. */
function offerIfLive(
  offer: string | null,
  expiresAt: string | null | undefined
): string | undefined {
  if (!offer) return undefined;
  if (expiresAt && Date.parse(expiresAt) < Date.now()) return undefined;
  return offer;
}

/** Live sponsored dishes (0160), menu item uuid → campaign id; empty when none or unreadable. */
async function sponsoredDishes(): Promise<Map<string, string>> {
  return activeSponsoredItems(new Date()).catch(() => new Map<string, string>());
}

function mapMenuItem(row: DbMenuItem, popularity?: Popularity, sponsored?: Map<string, string>): MenuItem {
  // Ranked by sales when there's enough history; otherwise the seeded flags
  // stand in. `popular` and `bestseller` are set together so every consumer —
  // the Popular tab, the row badge — agrees on one answer.
  const ranked = popularity?.basis === "orders";
  const popular = ranked ? popularity.top.includes(row.id) : row.popular || row.bestseller;

  const sponsoredBy = sponsored?.get(row.id);
  return {
    id: row.external_id ?? row.id,
    ...(sponsoredBy ? { sponsored: { campaignId: sponsoredBy } } : {}),
    name: row.name,
    description: row.description ?? "",
    price: row.price,
    discountPrice: row.discount_price,
    category: row.category ?? "Popular",
    veg: row.veg,
    image: row.image_url ?? undefined,
    soldOut: !row.available,
    popular,
    bestseller: popular,
    unitsSold: popularity?.units.get(row.id) ?? 0,
    ...menuInventory(row),
  };
}

const bySortOrder = <T extends DbSorted>(rows: T[] | undefined): T[] =>
  [...(rows ?? [])].sort((a, b) => a.sort_order - b.sort_order);

const option = (o: DbOption) => ({ id: o.id, name: o.name, price: o.price, available: o.available });

/** 0062's fields, or nothing on a database without it. */
function menuInventory(row: DbMenuItem): Partial<MenuItem> {
  if (row.menu_item_variants === undefined) return {};
  return {
    stockLeft: row.stock_qty ?? null,
    availableDays: row.available_days ?? null,
    availableFrom: row.available_from?.slice(0, 5) ?? null,
    availableTo: row.available_to?.slice(0, 5) ?? null,
    variants: bySortOrder(row.menu_item_variants).map(option),
    addonGroups: bySortOrder(row.menu_item_addon_groups).map((g) => ({
      id: g.id,
      name: g.name,
      minSelect: g.min_select,
      maxSelect: g.max_select,
      addons: bySortOrder(g.menu_item_addons).map(option),
    })),
  };
}

function mapRestaurant(
  row: DbRestaurantRow,
  popularity?: Popularity,
  status?: ShopStatus,
  sponsored?: Map<string, string>,
  /** Extra minutes for the weather in the shop's zone (0178). */
  weatherExtraMinutes = 0
): Restaurant {
  // Customers' own reads are already filtered by RLS; this also covers staff.
  const menu = (row.menu_items ?? []).filter(isLiveDishRow).map((item) => mapMenuItem(item, popularity, sponsored));

  // Popular is a derived tab, so it only earns its place when it has dishes in
  // it. Legacy menus carry no badges and may have no orders yet — offering an
  // empty tab (and opening on it) is worse than not offering it at all.
  const hasPopular = menu.some((m) => m.popular);
  const categories = [
    ...(hasPopular ? ["Popular"] : []),
    ...Array.from(new Set(menu.map((m) => m.category).filter((c) => c !== "Popular"))),
  ];

  const pace = kitchenPace({
    etaMin: row.eta_min,
    etaMax: row.eta_max,
    busyUntil: row.busy_until,
    busyExtraMinutes: row.busy_extra_minutes,
    weatherExtraMinutes,
  });

  return {
    popularBasis: popularity?.basis ?? "picks",
    slug: row.slug,
    name: row.name,
    tagline: row.tagline ?? "",
    cuisines: row.cuisines as Cuisine[],
    rating: Number(row.rating),
    ratingCount: row.rating_count,
    // The band the shop is quoting RIGHT NOW, bump included — not the one the
    // vendor typed when they set the store up. Applied here, once, so every
    // surface that renders a Restaurant (cards, search, the shop page) tells the
    // same story without each having to remember to.
    etaMin: pace.etaMin,
    etaMax: pace.etaMax,
    busy: pace.busy,
    busyExtraMinutes: pace.addedMinutes,
    prepMinutes: row.prep_minutes ?? null,
    priceTier: row.price_tier as PriceTier,
    costForTwo: row.cost_for_two ?? 400,
    // Null, not 2. A shop with no seeded distance has no distance, and `?? 2`
    // manufactured one — the same 2 km for every such shop, for every customer,
    // however far away they were. Nothing renders it today (`ShopDistance`
    // measures from lat/lng and shows nothing without a pin), but it sat on the
    // type as the documented fallback, waiting for the next caller to believe it.
    distanceKm:
      row.distance_km === null || row.distance_km === undefined
        ? null
        : Number(row.distance_km),
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    address: row.address ?? null,
    // A badge with a lapsed campaign behind it is dropped on read. The trigger
    // in 0041 fires when a coupon changes, and nothing fires at the moment one
    // expires — so this is what keeps the card from advertising a promotion
    // that ended overnight.
    offer: offerIfLive(row.offer, row.offer_expires_at),
    promoted: row.promoted,
    // The live answer (hours, holidays, timed close) when 0062 can give it;
    // the owner's switch alone before that.
    open: status ? status === "open" : row.is_open,
    status,
    openingTime: row.opening_time?.slice(0, 5) ?? null,
    categories,
    menu,
    accentTint: row.accent_tint ?? FALLBACK_TINT,
    image: row.image_url ?? "",
  };
}

/**
 * Approved restaurants, readable by anon (RLS).
 *
 * `withMenu` defaults to true (every field the type promises, unchanged
 * behavior for any caller that doesn't opt out). Pass false for a listing
 * surface that never renders menu data — the card it feeds (`RestaurantCard`)
 * only reads slug/name/cuisines/image/open/busy/eta/distance, so joining and
 * transferring every menu item for every restaurant on every Home/Stores load
 * was pure waste. Search still needs the full menu (dish-first ranking), so
 * it keeps the default.
 */
export async function listRestaurantsFromDb(withMenu = true): Promise<Restaurant[]> {
  const supabase = await createClient();
  const rows = await selectRestaurants<DbRestaurantRow[]>(
    (select) =>
      supabase
        .from("restaurants")
        .select(select)
        .eq("approved", true)
        .order("promoted", { ascending: false })
        .order("name")
        .overrideTypes<DbRestaurantRow[]>(),
    withMenu
  );

  const now = new Date();
  const [statuses, sponsored, positions, featured] = await Promise.all([
    liveShopStatuses((rows ?? []).map((r) => r.id)),
    withMenu ? sponsoredDishes() : Promise.resolve(undefined),
    getVendorPositions(),
    activeFeaturedCampaigns(now).catch(() => []),
  ]);
  // Slots belong to a zone's feed: pinned and featured shops are laid out one zone at a
  // time (a zone-B campaign on slot 2 neither displaces nor loses to a zone-A shop on 2),
  // decided from the window at read time, so a missed scheduler run never leaves a
  // campaign showing or hidden. Resilient: an un-migrated database keeps the default order.
  const zoneOf = await zonesOfShops([...positions.byId.keys(), ...featured.map((f) => f.restaurantId)]);
  const byId = effectiveVendorPositionsByZone(positions.byId, (id) => zoneOf.get(id) ?? null, featured);
  // "Featured" is a claim about placement: only a shop that took its campaign's slot wears it.
  const featuredById = placedFeatured(featured, byId);
  const weather = await weatherMinutesForShops((rows ?? []).map((r) => r.id));
  const list = (rows ?? []).map((row) => {
    const r = mapRestaurant(row, undefined, statuses.get(row.id), sponsored, weather.get(row.id) ?? 0);
    const campaignId = featuredById.get(row.id);
    return campaignId ? { ...r, featured: { campaignId } } : r;
  });
  const slugOf = new Map((rows ?? []).map((r) => [r.id, r.slug]));
  const bySlug = new Map<string, number>();
  for (const [id, pos] of byId) {
    const slug = slugOf.get(id);
    if (slug) bySlug.set(slug, pos);
  }
  return applyVendorOrder(list, byId.size > 0 ? bySlug : positions.bySlug, (r) => r.slug);
}

/**
 * Just the slugs of approved restaurants, for `sitemap.xml`.
 *
 * Deliberately not `listRestaurantsFromDb().map(r => r.slug)`. That path builds
 * every menu, resolves kitchen pace and applies admin pin order — none of which
 * a list of URLs needs — and, more importantly, it runs on the cookie-reading
 * client, which forces the sitemap out of static generation and made the read
 * throw during `next build`.
 *
 * Same `approved = true` filter and the same anon-visible grants as the
 * storefront, so this cannot advertise a page the app will not render. Throws
 * rather than returning `[]` on failure: an empty sitemap and a failed query are
 * very different claims, and the caller decides what to publish.
 */
export async function listPublicRestaurantSlugs(): Promise<
  { slug: string }[]
> {
  const supabase = createPublicClient();
  const { data, error } = await supabase
    .from("restaurants")
    .select("slug")
    .eq("approved", true)
    .order("name");

  if (error) throw error;
  return (data ?? []) as { slug: string }[];
}

/**
 * The signed-in user's hearted restaurants, with menus. Empty for guests or when
 * nothing is saved. RLS scopes the favourites read to the caller, so the id list
 * is already "mine"; we then fetch only those approved restaurants.
 */
export async function listFavoriteRestaurantsFromDb(): Promise<Restaurant[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: favRows, error: favErr } = await supabase
    .from("favorites")
    .select("restaurant_id");
  if (favErr || !favRows?.length) return [];

  const ids = favRows.map((r) => r.restaurant_id);
  const rows = await selectRestaurants<DbRestaurantRow[]>((select) =>
    supabase
      .from("restaurants")
      .select(select)
      .in("id", ids)
      .eq("approved", true)
      .order("name")
      .overrideTypes<DbRestaurantRow[]>()
  );

  const [statuses, weather] = await Promise.all([
    liveShopStatuses((rows ?? []).map((r) => r.id)),
    weatherMinutesForShops((rows ?? []).map((r) => r.id)),
  ]);
  return (rows ?? []).map((row) => mapRestaurant(row, undefined, statuses.get(row.id), undefined, weather.get(row.id) ?? 0));
}

/**
 * One restaurant, with its menu ranked by sales. The feed lists deliberately
 * skip the ranking — it's one RPC per restaurant, and no card shows dish-level
 * popularity — so only the menu screen pays for it.
 */
export async function getRestaurantFromDb(
  slug: string
): Promise<Restaurant | null> {
  const supabase = await createClient();
  const row = await selectRestaurants<DbRestaurantRow>((select) =>
    supabase
      .from("restaurants")
      .select(select)
      .eq("slug", slug)
      .eq("approved", true)
      .maybeSingle()
      .overrideTypes<DbRestaurantRow>()
  );

  if (!row) return null;

  const [popularity, statuses, sponsored] = await Promise.all([
    getMenuPopularity(row.id),
    liveShopStatuses([row.id]),
    sponsoredDishes(),
  ]);
  const weather = await weatherMinutesForShops([row.id]);
  return mapRestaurant(row, popularity, statuses.get(row.id), sponsored, weather.get(row.id) ?? 0);
}

/**
 * Pin the signed-in vendor's shop. This is what makes a real distance possible:
 * without it we only have the seeded `distance_km`, which is the same number
 * however far away the customer actually is.
 *
 * Scoped to the caller's own active restaurant twice over — resolved from the
 * session here, and the "restaurants — owner manage" RLS policy underneath.
 */
export async function updateShopLocation(input: {
  lat: number;
  lng: number;
  address: string;
}): Promise<void> {
  // The active shop only: an owner of several shops pins each one separately
  // (this used to move every shop they own onto the same pin).
  const ok = await updateVendorRestaurant({
    lat: input.lat,
    lng: input.lng,
    address: input.address,
  });
  if (!ok) throw new Error("unauthorized");
}

/**
 * The signed-in vendor's own restaurant + menu, ranked the same way the diner's
 * menu screen is — so the Popular list a vendor is shown is the very same list
 * their customers see, not a second implementation of the idea.
 *
 * Unapproved is included on purpose: a vendor still needs their menu before the
 * storefront goes live. RLS scopes the row to its owner.
 */
export async function getOwnedRestaurantFromDb(): Promise<Restaurant | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const row = await selectRestaurants<DbRestaurantRow>((select) =>
    supabase
      .from("restaurants")
      .select(select)
      .eq("owner_id", user.id)
      .order("name")
      .limit(1)
      .maybeSingle()
      .overrideTypes<DbRestaurantRow>()
  );

  if (!row) return null;

  const popularity = await getMenuPopularity(row.id);
  return mapRestaurant(row, popularity);
}
