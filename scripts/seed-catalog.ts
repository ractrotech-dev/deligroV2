/**
 * Seed restaurants + menu from the Phase 1 mock catalog.
 *
 * Run after 0001_init.sql and 0002_catalog_display.sql:
 *   npm run db:seed
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { RESTAURANTS } from "../src/lib/data";

// Node < 22 has no global WebSocket, which supabase-js needs to construct its
// client (we only make REST calls). Load `ws` lazily via require, only when the
// global is missing — so it's not a hard build/type dependency, and Node 22+
// skips it entirely.
const g = globalThis as { WebSocket?: unknown };
if (g.WebSocket === undefined) {
  g.WebSocket = createRequire(import.meta.url)("ws");
}

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    // .env.local optional if vars already exported
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
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in deligro/.env.local"
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const VENDOR_EMAIL = process.env.SEED_VENDOR_EMAIL ?? "vendor@deligro.demo";
// Same rule as seed-users: no committed password. Must match the one that
// account was created with.
const VENDOR_PASSWORD = process.env.SEED_PASSWORD ?? "";
if (VENDOR_PASSWORD.length < 12) {
  console.error("Set SEED_PASSWORD (the vendor account's password) before seeding.");
  process.exit(1);
}

/**
 * Find the vendor by email, paging through ALL users. A single listUsers()
 * returns one page only, so once auth.users grows past it (e.g. after the
 * legacy customer import) the lookup misses the vendor and createUser() then
 * throws "email_exists".
 */
async function findUserId(email: string): Promise<string | undefined> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) break; // last page
  }
  return undefined;
}

async function ensureVendor() {
  let userId = await findUserId(VENDOR_EMAIL);

  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email: VENDOR_EMAIL,
      password: VENDOR_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Demo Vendor" },
    });
    if (error) throw error;
    userId = data.user.id;
    console.log(`Created vendor user ${VENDOR_EMAIL}`);
  } else {
    console.log(`Vendor user exists: ${VENDOR_EMAIL}`);
  }

  // Upsert (not update): the role sticks even if the profile row isn't there yet.
  const { error: roleErr } = await admin
    .from("profiles")
    .upsert({ id: userId, role: "restaurant", full_name: "Demo Vendor" }, { onConflict: "id" });
  if (roleErr) {
    console.warn(
      "Could not set vendor role (run 0003_lock_role_service_bypass.sql in Supabase).",
      roleErr.message
    );
  }

  return userId!;
}

type SeedRestaurant = (typeof RESTAURANTS)[number];
type SeedMenuItem = SeedRestaurant["menu"][number];

/** Insert or refresh one restaurant by slug; returns its id. */
async function upsertRestaurant(ownerId: string, r: SeedRestaurant): Promise<string> {
  const { data: existing } = await admin
    .from("restaurants")
    .select("id")
    .eq("slug", r.slug)
    .maybeSingle();

  const row = {
    owner_id: ownerId,
    slug: r.slug,
    name: r.name,
    tagline: r.tagline,
    is_open: r.open,
    approved: true,
    image_url: r.image,
    accent_tint: r.accentTint,
    cuisines: r.cuisines,
    rating: r.rating,
    rating_count: r.ratingCount,
    eta_min: r.etaMin,
    eta_max: r.etaMax,
    price_tier: r.priceTier,
    cost_for_two: r.costForTwo,
    distance_km: r.distanceKm,
    offer: r.offer ?? null,
    promoted: r.promoted ?? false,
  };

  if (existing?.id) {
    const { error } = await admin
      .from("restaurants")
      .update(row)
      .eq("id", existing.id);
    if (error) throw error;
    console.log(`Updated restaurant: ${r.name}`);
    return existing.id;
  }

  const { data, error } = await admin
    .from("restaurants")
    .insert(row)
    .select("id")
    .single();
  if (error) throw error;
  console.log(`Inserted restaurant: ${r.name}`);
  return data.id;
}

/** Insert or refresh one menu item by its external id within the restaurant. */
async function upsertMenuItem(restaurantId: string, item: SeedMenuItem) {
  const menuRow = {
    restaurant_id: restaurantId,
    external_id: item.id,
    name: item.name,
    description: item.description,
    price: item.price,
    veg: item.veg,
    available: !item.soldOut,
    category: item.category,
    image_url: item.image ?? null,
    popular: item.popular ?? false,
    bestseller: item.bestseller ?? false,
  };

  const { data: existingItem } = await admin
    .from("menu_items")
    .select("id")
    .eq("restaurant_id", restaurantId)
    .eq("external_id", item.id)
    .maybeSingle();

  if (existingItem?.id) {
    const { error } = await admin
      .from("menu_items")
      .update(menuRow)
      .eq("id", existingItem.id);
    if (error) throw error;
  } else {
    const { error } = await admin.from("menu_items").insert(menuRow);
    if (error) throw error;
  }
}

async function seedCatalog(ownerId: string) {
  for (const r of RESTAURANTS) {
    const restaurantId = await upsertRestaurant(ownerId, r);
    for (const item of r.menu) {
      await upsertMenuItem(restaurantId, item);
    }
  }
}

async function main() {
  const ownerId = await ensureVendor();
  await seedCatalog(ownerId);
  console.log("\nSeed complete.");
  console.log(`Vendor login: ${VENDOR_EMAIL} / ${VENDOR_PASSWORD}`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
