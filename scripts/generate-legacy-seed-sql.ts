/**
 * Generate Supabase-ready SQL from the legacy phpMyAdmin JSON export.
 *
 * Output: supabase/seed/legacy_catalog.sql
 * Paste that file into Supabase → SQL Editor after db:seed-users.
 *
 *   npm run db:generate-legacy-sql
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateShopRatings,
  buildCategoryMap,
  inferCuisines,
  inferVeg,
  loadLegacyExport,
  parseEtaMinutes,
  parsePrice,
  productsForShop,
  resolveMenuSeedImage,
  resolveRestaurantSeedImage,
  resolveShopImportScope,
  selectShops,
  shopSlug,
} from "./lib/legacy-db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const shopScope = resolveShopImportScope();
const VENDOR_EMAIL = "vendor@deligro.demo";

const jsonPath = resolve(
  process.env.LEGACY_DB_JSON ??
    join(__dirname, "..", "..", "u231346219_deligro.json")
);
const assetsBase = process.env.LEGACY_ASSETS_BASE_URL;
const imageOpts = {
  assetsBaseUrl: assetsBase,
  usePexels: process.env.USE_PEXELS_IMAGES !== "0",
};
const outPath = join(__dirname, "..", "supabase", "seed", "legacy_catalog.sql");

function sqlStr(value: string | null | undefined): string {
  if (value == null || value === "") return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlBool(value: boolean): string {
  return value ? "true" : "false";
}

function sqlArray(values: string[]): string {
  if (values.length === 0) return "ARRAY[]::text[]";
  return `ARRAY[${values.map((v) => sqlStr(v)).join(", ")}]`;
}

function estimatePriceTier(avgPrice: number): number {
  if (avgPrice < 80) return 1;
  if (avgPrice < 180) return 2;
  return 3;
}

/** Price tier and cost-for-two from the average of the shop's priced products. */
function shopPricing(products: ReturnType<typeof productsForShop>): {
  priceTier: number;
  costForTwo: number | null;
} {
  const prices = products
    .map((p) => parsePrice(p.price))
    .filter((n) => n > 0);
  const avgPrice =
    prices.length > 0
      ? prices.reduce((a, b) => a + b, 0) / prices.length
      : 0;
  const priceTier = estimatePriceTier(avgPrice);
  const costForTwo =
    avgPrice > 0 ? Math.round(avgPrice * 2.5) : null;
  return { priceTier, costForTwo };
}

/** One SQL VALUES tuple per sellable product (named, priced above zero). */
function menuValueRows(
  products: ReturnType<typeof productsForShop>,
  categoryMap: ReturnType<typeof buildCategoryMap>
): string[] {
  const menuRows: string[] = [];
  for (const p of products) {
    const price = parsePrice(p.price);
    if (!p.pname?.trim() || price <= 0) continue;
    const externalId = `legacy-${p.id}`;
    const category = categoryMap.get(p.category_id) ?? "Popular";
    const imageUrlItem = resolveMenuSeedImage(
      category,
      p.pname.trim(),
      imageOpts,
      { aimage: p.aimage, pimage: p.pimage, description: p.pdesc }
    );
    const popular = Boolean(p.badge?.trim());
    menuRows.push(
      [
        sqlStr(externalId),
        sqlStr(p.pname.trim()),
        sqlStr(p.pdesc?.trim() || null),
        String(price),
        sqlBool(inferVeg(p.pname)),
        sqlBool(p.status === "ON"),
        sqlStr(category),
        sqlStr(imageUrlItem),
        sqlBool(popular),
        sqlBool(popular),
      ].join(", ")
    );
  }
  return menuRows;
}

function main() {
  const legacy = loadLegacyExport(jsonPath);
  const shops = selectShops(legacy.shops, shopScope);
  const shopIds = new Set(shops.map((s) => s.id));
  const categoryMap = buildCategoryMap(legacy.categories);
  const ratings = aggregateShopRatings(legacy.reviews, shopIds);

  const lines: string[] = [
    "-- ============================================================",
    "-- Deligro — legacy catalog seed (generated)",
    "-- ------------------------------------------------------------",
    `-- Source: ${jsonPath}`,
    `-- Shops: ${shops.length} (${shopScope}) · generated ${new Date().toISOString()}`,
    "--",
    "-- Prereqs:",
    "--   1. Run migrations 0001–0003",
    "--   2. Run npm run db:seed-users (creates vendor@deligro.demo)",
    "--   3. Paste this file into Supabase → SQL Editor → Run",
    "--",
    "-- Idempotent: upserts on restaurants.slug and",
    "-- menu_items (restaurant_id, external_id).",
    "-- ============================================================",
    "",
    "BEGIN;",
    "",
    "DO $$",
    "BEGIN",
    `  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = ${sqlStr(VENDOR_EMAIL)}) THEN`,
    `    RAISE EXCEPTION 'Missing vendor user ${VENDOR_EMAIL}. Run npm run db:seed-users first.';`,
    "  END IF;",
    "END $$;",
    "",
  ];

  let menuTotal = 0;

  for (const shop of shops) {
    const slug = shopSlug(shop);
    const cuisines = inferCuisines(shop);
    const { etaMin, etaMax } = parseEtaMinutes(shop.deliverytime || "25 Min");
    const ratingMeta = ratings.get(shop.id);
    const legacyRating = Number.parseFloat(shop.rating);
    const rating =
      ratingMeta?.rating ??
      (Number.isFinite(legacyRating) ? legacyRating : 4.5);
    const ratingCount = ratingMeta?.ratingCount ?? 0;
    const imageUrl = resolveRestaurantSeedImage(shop, cuisines, imageOpts) || null;
    const tagline =
      shop.famous && shop.famous !== "NO" ? shop.famous : shop.tags || null;
    const products = productsForShop(legacy.products, shop.id);
    const { priceTier, costForTwo } = shopPricing(products);

    const menuRows = menuValueRows(products, categoryMap);
    menuTotal += menuRows.length;

    lines.push(
      `-- ${shop.sname} (legacy shop #${shop.id})`,
      "WITH owner AS (",
      `  SELECT id AS owner_id FROM auth.users WHERE email = ${sqlStr(VENDOR_EMAIL)} LIMIT 1`,
      "),",
      "upsert_restaurant AS (",
      "  INSERT INTO public.restaurants (",
      "    owner_id, slug, name, tagline, is_open, approved, image_url, accent_tint,",
      "    cuisines, rating, rating_count, eta_min, eta_max, price_tier, cost_for_two, offer, promoted",
      "  )",
      "  SELECT",
      "    owner.owner_id,",
      `    ${sqlStr(slug)},`,
      `    ${sqlStr(shop.sname.trim())},`,
      `    ${sqlStr(tagline)},`,
      `    ${sqlBool(shop.status === "ON")},`,
      `    ${sqlBool(shop.approve === "YES")},`,
      `    ${sqlStr(imageUrl)},`,
      `    ${sqlStr("linear-gradient(135deg,#f6c453,#e8552d)")},`,
      `    ${sqlArray(cuisines)},`,
      `    ${rating},`,
      `    ${ratingCount},`,
      `    ${etaMin},`,
      `    ${etaMax},`,
      `    ${priceTier},`,
      `    ${costForTwo ?? "NULL"},`,
      `    ${shop.promoted === "YES" ? sqlStr("Featured") : "NULL"},`,
      `    ${sqlBool(shop.promoted === "YES")}`,
      "  FROM owner",
      "  ON CONFLICT (slug) DO UPDATE SET",
      "    name = EXCLUDED.name,",
      "    tagline = EXCLUDED.tagline,",
      "    is_open = EXCLUDED.is_open,",
      "    approved = EXCLUDED.approved,",
      "    image_url = EXCLUDED.image_url,",
      "    cuisines = EXCLUDED.cuisines,",
      "    rating = EXCLUDED.rating,",
      "    rating_count = EXCLUDED.rating_count,",
      "    eta_min = EXCLUDED.eta_min,",
      "    eta_max = EXCLUDED.eta_max,",
      "    price_tier = EXCLUDED.price_tier,",
      "    cost_for_two = EXCLUDED.cost_for_two,",
      "    offer = EXCLUDED.offer,",
      "    promoted = EXCLUDED.promoted",
      "  RETURNING id",
      menuRows.length > 0 ? ")," : ")",
    );

    if (menuRows.length === 0) {
      lines.push("SELECT id FROM upsert_restaurant;");
    } else {
      lines.push(
        "menu_data AS (",
        "  SELECT * FROM (",
        "    VALUES",
        menuRows
          .map((row, i) => `      (${row})${i < menuRows.length - 1 ? "," : ""}`)
          .join("\n"),
        "  ) AS v(external_id, name, description, price, veg, available, category, image_url, popular, bestseller)",
        ")",
        "INSERT INTO public.menu_items (",
        "  restaurant_id, external_id, name, description, price, veg, available,",
        "  category, image_url, popular, bestseller",
        ")",
        "SELECT",
        "  upsert_restaurant.id,",
        "  menu_data.external_id, menu_data.name, menu_data.description, menu_data.price,",
        "  menu_data.veg, menu_data.available, menu_data.category, menu_data.image_url,",
        "  menu_data.popular, menu_data.bestseller",
        "FROM upsert_restaurant",
        "CROSS JOIN menu_data",
        "ON CONFLICT (restaurant_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET",
        "  name = EXCLUDED.name,",
        "  description = EXCLUDED.description,",
        "  price = EXCLUDED.price,",
        "  veg = EXCLUDED.veg,",
        "  available = EXCLUDED.available,",
        "  category = EXCLUDED.category,",
        "  image_url = EXCLUDED.image_url,",
        "  popular = EXCLUDED.popular,",
        "  bestseller = EXCLUDED.bestseller;",
      );
    }
    lines.push("");
  }

  if (legacy.settings) {
    lines.push(
      "-- Legacy delivery rules (reference — wire into app config separately):",
      `-- min order ₹${legacy.settings.min_order_amount}, free delivery above ₹${legacy.settings.free_delivery}`,
      "",
    );
  }

  lines.push(
    "COMMIT;",
    "",
    "-- Verify import (this is what the SQL Editor result should show):",
    "SELECT",
    "  (SELECT count(*)::int FROM public.restaurants) AS total_restaurants,",
    "  (SELECT count(*)::int FROM public.menu_items WHERE external_id LIKE 'legacy-%') AS legacy_menu_items,",
    "  (SELECT count(*)::int FROM public.restaurants WHERE is_open = true) AS open_restaurants;",
    "",
    `-- Expected after full seed: ~62 restaurants, ~${menuTotal} legacy menu items`,
  );

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
  console.log(`${shops.length} restaurants, ${menuTotal} menu items`);
}

main();
