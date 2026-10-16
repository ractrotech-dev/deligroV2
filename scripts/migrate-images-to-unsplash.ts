/**
 * Repoint image_url values already stored in the database from Pexels to
 * Unsplash. Deterministic: each restaurant/menu row's new image is recomputed
 * from its name + category with the same picker the seeder now uses
 * (scripts/lib/unsplash-images.ts), so this is idempotent and matches fresh
 * seeds. Only rows whose image_url points at images.pexels.com are touched;
 * vendor-uploaded images (Supabase storage, other hosts) are left alone.
 *
 * Prereqs: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) in .env.local.
 *
 * Usage:
 *   npm run db:migrate-images -- --dry-run   # preview counts, write nothing
 *   npm run db:migrate-images                # apply
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  unsplashForMenuItem,
  unsplashForRestaurant,
} from "./lib/unsplash-images";

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
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "";

if (!url.startsWith("http") || serviceKey.length < 20) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or service-role key in .env.local");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

const PEXELS = "images.pexels.com";
const PAGE = 1000;
const CONCURRENCY = 25;

async function runChunked<T>(items: T[], fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
  }
}

interface RestaurantRow {
  id: string;
  name: string | null;
  category: string | null;
  image_url: string | null;
}
interface MenuRow {
  id: string;
  name: string | null;
  category: string | null;
  description: string | null;
  image_url: string | null;
}

async function pexelsCount(table: string): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .like("image_url", `%${PEXELS}%`);
  if (error) throw error;
  return count ?? 0;
}

async function migrateRestaurants() {
  const total = await pexelsCount("restaurants");
  if (dryRun) {
    console.log(`restaurants: ${total} Pexels images would be repointed`);
    return;
  }
  let changed = 0;
  // Updated rows leave the `like %pexels%` filter, so we always read from offset
  // 0 and loop until none remain — advancing an offset would skip rows.
  for (;;) {
    const { data, error } = await supabase
      .from("restaurants")
      .select("id, name, category, image_url")
      .like("image_url", `%${PEXELS}%`)
      .range(0, PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as RestaurantRow[];
    if (rows.length === 0) break;

    await runChunked(rows, async (r) => {
      const next = unsplashForRestaurant(
        r.name ?? "",
        r.category ? [r.category] : []
      );
      const { error: upErr } = await supabase
        .from("restaurants")
        .update({ image_url: next })
        .eq("id", r.id);
      if (upErr) throw upErr;
      changed++;
    });
  }
  console.log(`restaurants: ${changed}/${total} Pexels images repointed`);
}

async function migrateMenuItems() {
  const total = await pexelsCount("menu_items");
  if (dryRun) {
    console.log(`menu_items: ${total} Pexels images would be repointed`);
    return;
  }
  let changed = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("menu_items")
      .select("id, name, category, description, image_url")
      .like("image_url", `%${PEXELS}%`)
      .range(0, PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as MenuRow[];
    if (rows.length === 0) break;

    await runChunked(rows, async (m) => {
      const next = unsplashForMenuItem(
        m.category ?? "",
        m.name ?? "",
        m.description?.trim() ?? ""
      );
      const { error: upErr } = await supabase
        .from("menu_items")
        .update({ image_url: next })
        .eq("id", m.id);
      if (upErr) throw upErr;
      changed++;
    });
  }
  console.log(`menu_items: ${changed}/${total} Pexels images repointed`);
}

async function main() {
  console.log(dryRun ? "DRY RUN — no writes\n" : "Applying Unsplash image migration\n");
  await migrateRestaurants();
  await migrateMenuItems();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
