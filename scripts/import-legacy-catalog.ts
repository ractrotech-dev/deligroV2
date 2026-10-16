/**
 * Import active legacy restaurants + menus into Supabase.
 *
 * Phase 1 migration — reads the phpMyAdmin JSON export (keep it OUT of git).
 * Idempotent: upserts by restaurant `slug` and menu `external_id`.
 *
 * Prereqs:
 *   - Migrations 0001–0003 applied
 *   - .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY
 *   - npm run db:seed-users  (vendor@deligro.demo owns imported restaurants)
 *
 * Usage:
 *   LEGACY_DB_JSON=../u231346219_deligro.json npm run db:import-legacy
 *   npm run db:import-legacy -- --dry-run
 *   LEGACY_SHOP_SCOPE=active npm run db:import-legacy      # only status ON (5 shops)
 *   LEGACY_SHOP_SCOPE=approved npm run db:import-legacy    # approve=YES only (40 shops)
 *   LEGACY_SHOP_SCOPE=bemetara npm run db:import-legacy    # default — all Bemetara (62 shops)
 *   LEGACY_ASSETS_BASE_URL=https://old-server.example npm run db:import-legacy
 *   USE_PEXELS_IMAGES=0 npm run db:import-legacy   # disable Pexels fallbacks
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
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
  type LegacyShop,
} from "./lib/legacy-db";

const g = globalThis as { WebSocket?: unknown };
if (g.WebSocket === undefined) {
  g.WebSocket = createRequire(import.meta.url)("ws");
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes("--dry-run");
const shopScope = resolveShopImportScope();

function loadEnv() {
  const envPath = join(__dirname, "..", ".env.local");
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // optional
  }
}

loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SECRET_KEY ??
  "";

if (!url.startsWith("http") || serviceKey.length < 20) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local"
  );
  process.exit(1);
}

const jsonPath = resolve(
  process.env.LEGACY_DB_JSON ??
    join(__dirname, "..", "..", "u231346219_deligro.json")
);
const assetsBase = process.env.LEGACY_ASSETS_BASE_URL;
const imageOpts = {
  assetsBaseUrl: assetsBase,
  usePexels: process.env.USE_PEXELS_IMAGES !== "0",
};

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const VENDOR_EMAIL = "vendor@deligro.demo";

async function ensureVendor() {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const userId = list?.users.find((u) => u.email === VENDOR_EMAIL)?.id;
  if (!userId) {
    throw new Error(
      `Vendor ${VENDOR_EMAIL} not found. Run: npm run db:seed-users`
    );
  }
  return userId;
}

function estimatePriceTier(avgPrice: number): 1 | 2 | 3 {
  if (avgPrice < 80) return 1;
  if (avgPrice < 180) return 2;
  return 3;
}

async function upsertRestaurant(
  ownerId: string,
  shop: LegacyShop,
  menuCount: number,
  ratingMeta: { rating: number; ratingCount: number } | undefined
) {
  const slug = shopSlug(shop);
  const cuisines = inferCuisines(shop);
  const { etaMin, etaMax } = parseEtaMinutes(shop.deliverytime || "25 Min");
  const legacyRating = Number.parseFloat(shop.rating);
  const rating = ratingMeta?.rating ?? (Number.isFinite(legacyRating) ? legacyRating : 4.5);
  const ratingCount = ratingMeta?.ratingCount ?? 0;
  const imageUrl = resolveRestaurantSeedImage(shop, cuisines, imageOpts);

  const row = {
    owner_id: ownerId,
    slug,
    name: shop.sname.trim(),
    tagline: shop.famous && shop.famous !== "NO" ? shop.famous : shop.tags || null,
    is_open: shop.status === "ON",
    approved: shop.approve === "YES",
    image_url: imageUrl || null,
    accent_tint: "linear-gradient(135deg,#f6c453,#e8552d)",
    cuisines,
    rating,
    rating_count: ratingCount,
    eta_min: etaMin,
    eta_max: etaMax,
    price_tier: 2 as const,
    cost_for_two: null,
    distance_km: null,
    offer: shop.promoted === "YES" ? "Featured" : null,
    promoted: shop.promoted === "YES",
  };

  if (DRY_RUN) {
    console.log(`[dry-run] restaurant ${slug} — ${menuCount} menu items`);
    return { id: `dry-run-${shop.id}`, slug };
  }

  const { data: existing } = await admin
    .from("restaurants")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();

  if (existing?.id) {
    const { error } = await admin.from("restaurants").update(row).eq("id", existing.id);
    if (error) throw error;
    console.log(`Updated restaurant: ${shop.sname} (${slug})`);
    return { id: existing.id as string, slug };
  }

  const { data, error } = await admin
    .from("restaurants")
    .insert(row)
    .select("id")
    .single();
  if (error) throw error;
  console.log(`Inserted restaurant: ${shop.sname} (${slug})`);
  return { id: data.id as string, slug };
}

/** Update the dish this legacy product was imported as before, or insert it. */
async function writeMenuItem(
  restaurantId: string,
  externalId: string,
  menuRow: Record<string, unknown>
): Promise<"inserted" | "updated"> {
  const { data: existingItem } = await admin
    .from("menu_items")
    .select("id")
    .eq("restaurant_id", restaurantId)
    .eq("external_id", externalId)
    .maybeSingle();

  if (existingItem?.id) {
    const { error } = await admin
      .from("menu_items")
      .update(menuRow)
      .eq("id", existingItem.id);
    if (error) throw error;
    return "updated";
  }
  const { error } = await admin.from("menu_items").insert(menuRow);
  if (error) throw error;
  return "inserted";
}

async function upsertMenuItems(
  restaurantId: string,
  shop: LegacyShop,
  products: ReturnType<typeof productsForShop>,
  categoryMap: Map<string, string>
) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const prices = products.map((p) => parsePrice(p.price)).filter((n) => n > 0);
  const avgPrice =
    prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;

  for (const p of products) {
    const price = parsePrice(p.price);
    if (!p.pname?.trim() || price <= 0) {
      skipped++;
      continue;
    }

    const externalId = `legacy-${p.id}`;
    const category = categoryMap.get(p.category_id) ?? "Popular";
    const imageUrl = resolveMenuSeedImage(category, p.pname.trim(), imageOpts, {
      aimage: p.aimage,
      pimage: p.pimage,
      description: p.pdesc,
    });
    const popular = Boolean(p.badge?.trim());

    const menuRow = {
      restaurant_id: restaurantId,
      external_id: externalId,
      name: p.pname.trim(),
      description: p.pdesc?.trim() || null,
      price,
      veg: inferVeg(p.pname),
      available: p.status === "ON",
      category,
      image_url: imageUrl,
      popular,
      bestseller: popular,
    };

    if (DRY_RUN) {
      inserted++;
      continue;
    }

    if ((await writeMenuItem(restaurantId, externalId, menuRow)) === "updated") {
      updated++;
    } else {
      inserted++;
    }
  }

  if (!DRY_RUN && avgPrice > 0) {
    const tier = estimatePriceTier(avgPrice);
    await admin
      .from("restaurants")
      .update({ price_tier: tier, cost_for_two: Math.round(avgPrice * 2.5) })
      .eq("id", restaurantId);
  }

  return { inserted, updated, skipped };
}

async function main() {
  console.log(`Legacy JSON: ${jsonPath}`);
  if (DRY_RUN) console.log("DRY RUN — no Supabase writes\n");
  console.log(`Shop scope: ${shopScope}\n`);
  if (assetsBase) console.log(`Assets base: ${assetsBase}\n`);
  else if (imageOpts.usePexels) {
    console.log("Images: Unsplash CDN (images.unsplash.com)\n");
  } else {
    console.log("Images: disabled (no legacy base URL, USE_PEXELS_IMAGES=0)\n");
  }

  const legacy = loadLegacyExport(jsonPath);
  const shops = selectShops(legacy.shops, shopScope);
  const shopIds = new Set(shops.map((s) => s.id));
  const categoryMap = buildCategoryMap(legacy.categories);
  const ratings = aggregateShopRatings(legacy.reviews, shopIds);

  console.log(
    `Found ${shops.length} shops to import (${legacy.products.length} total legacy products)\n`
  );

  if (legacy.settings) {
    console.log("Legacy delivery settings (reference only — not written to DB):");
    console.log(
      `  min order ₹${legacy.settings.min_order_amount}, free delivery above ₹${legacy.settings.free_delivery}, tax ${legacy.settings.tax}%\n`
    );
  }

  const ownerId = DRY_RUN ? "dry-run-owner" : await ensureVendor();

  let totalMenu = 0;
  for (const shop of shops) {
    const products = productsForShop(legacy.products, shop.id);
    const { id: restaurantId } = await upsertRestaurant(
      ownerId,
      shop,
      products.length,
      ratings.get(shop.id)
    );
    const stats = await upsertMenuItems(
      restaurantId,
      shop,
      products,
      categoryMap
    );
    totalMenu += products.length;
    console.log(
      `  → menu: +${stats.inserted} new, ~${stats.updated} updated, ${stats.skipped} skipped`
    );
  }

  console.log(
    `\nImport ${DRY_RUN ? "dry-run " : ""}complete: ${shops.length} restaurants, ${totalMenu} legacy menu rows processed.`
  );
  if (!DRY_RUN) {
    console.log(`Vendor portal: /vendor as ${VENDOR_EMAIL}`);
  }
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
