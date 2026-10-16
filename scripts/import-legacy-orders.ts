/**
 * Import legacy order history into Supabase orders + order_items.
 *
 * Parses the HTML cart snapshot in `orders.pname` into line items
 * (name / qty / unit price). Idempotent via orders.external_id = legacy-<id>.
 *
 * Prereqs:
 *   - Migration 0015_orders_external_id applied
 *   - Catalog + customers already imported
 *   - .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY
 *
 * Usage:
 *   LEGACY_DB_JSON=../deligro26/u231346219_deligro.json npm run db:import-legacy-orders
 *   npm run db:import-legacy-orders -- --dry-run
 *   LEGACY_ORDER_LIMIT=200 npm run db:import-legacy-orders
 *   LEGACY_ORDER_OFFSET=500 npm run db:import-legacy-orders
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { toE164 } from "../src/lib/auth/phone";
import {
  loadLegacyExport,
  mapLegacyOrderStatus,
  parseLegacyOrderTime,
  parsePnameHtml,
  parsePrice,
  shopSlug,
  type LegacyOrder,
  type LegacyShop,
} from "./lib/legacy-db";
import { loadEnvFile, sleep, withRetry } from "./lib/import-env";

const g = globalThis as { WebSocket?: unknown };
if (g.WebSocket === undefined) {
  g.WebSocket = createRequire(import.meta.url)("ws");
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = Number(process.env.LEGACY_ORDER_LIMIT ?? "0") || Infinity;
const OFFSET = Number(process.env.LEGACY_ORDER_OFFSET ?? "0") || 0;
const THROTTLE_MS = Number(process.env.LEGACY_IMPORT_THROTTLE_MS ?? "0") || 0;
const BATCH = Math.max(1, Number(process.env.LEGACY_ORDER_BATCH ?? "50") || 50);
const CONCURRENCY = Math.max(
  1,
  Number(process.env.LEGACY_IMPORT_CONCURRENCY ?? "6") || 6
);
const ONLY_IDS = new Set(
  (process.env.LEGACY_ORDER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

loadEnvFile(join(__dirname, "..", ".env.local"));

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SECRET_KEY ??
  "";

if (!url.startsWith("http") || serviceKey.length < 20) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const jsonPath = resolve(
  process.env.LEGACY_DB_JSON ??
    join(__dirname, "..", "..", "deligro26", "u231346219_deligro.json")
);

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** true = orders.external_id exists (migration 0015). */
let hasExternalId: boolean | null = null;

async function detectExternalIdColumn(): Promise<boolean> {
  if (hasExternalId !== null) return hasExternalId;
  const { error } = await admin.from("orders").select("external_id").limit(1);
  hasExternalId = !error;
  if (!hasExternalId) {
    console.warn(
      "orders.external_id missing — apply supabase/migrations/0015_orders_external_id.sql\n" +
        "  Falling back to address.legacy_order_id for idempotency.\n"
    );
  }
  return hasExternalId;
}

async function findExistingOrderId(legacyId: string): Promise<string | null> {
  if (await detectExternalIdColumn()) {
    const { data, error } = await admin
      .from("orders")
      .select("id")
      .eq("external_id", `legacy-${legacyId}`)
      .maybeSingle();
    if (error) throw error;
    return (data?.id as string) ?? null;
  }

  const { data, error } = await admin
    .from("orders")
    .select("id")
    .filter("address->>legacy_order_id", "eq", legacyId)
    .maybeSingle();
  if (error) throw error;
  return (data?.id as string) ?? null;
}

type Stats = {
  inserted: number;
  updated: number;
  skippedNoShop: number;
  skippedNoCustomer: number;
  skippedNoItems: number;
  errors: number;
};

async function loadRestaurantMap(shops: LegacyShop[]) {
  const map = new Map<string, string>(); // legacy shop_id → restaurant uuid
  const slugs = shops.map((s) => shopSlug(s));
  // PostgREST `.in` is fine for ~62 Bemetara shops.
  for (let i = 0; i < slugs.length; i += 100) {
    const slice = slugs.slice(i, i + 100);
    const { data, error } = await admin
      .from("restaurants")
      .select("id, slug")
      .in("slug", slice);
    if (error) throw error;
    const bySlug = new Map((data ?? []).map((r) => [r.slug as string, r.id as string]));
    for (const shop of shops) {
      const id = bySlug.get(shopSlug(shop));
      if (id) map.set(shop.id, id);
    }
  }
  return map;
}

async function loadCustomerMapByPhone(phones: string[]) {
  const map = new Map<string, string>(); // e164 → profile id
  const unique = [...new Set(phones.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const slice = unique.slice(i, i + 100);
    const { data, error } = await admin
      .from("profiles")
      .select("id, phone")
      .in("phone", slice);
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.phone) map.set(row.phone as string, row.id as string);
    }
  }
  return map;
}

async function loadMenuLookup(restaurantIds: string[]) {
  // restaurant_id → lower(name) → menu_item uuid (first match wins)
  const map = new Map<string, Map<string, string>>();
  for (let i = 0; i < restaurantIds.length; i += 20) {
    const slice = restaurantIds.slice(i, i + 20);
    const { data, error } = await admin
      .from("menu_items")
      .select("id, restaurant_id, name")
      .in("restaurant_id", slice);
    if (error) throw error;
    for (const row of data ?? []) {
      const rid = row.restaurant_id as string;
      const bucket = map.get(rid) ?? new Map<string, string>();
      const key = String(row.name ?? "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
      if (key && !bucket.has(key)) bucket.set(key, row.id as string);
      map.set(rid, bucket);
    }
  }
  return map;
}

function buildAddress(
  order: LegacyOrder,
  customer: { useraddress?: string; city?: string; latuser?: string; longuser?: string } | undefined
) {
  const line =
    customer?.useraddress?.trim() ||
    customer?.city?.trim() ||
    `${order.uname?.trim() || "Customer"} · ${order.ophone}`;
  const lat = Number.parseFloat(customer?.latuser ?? "");
  const lng = Number.parseFloat(customer?.longuser ?? "");
  return {
    label: "Home",
    line: line.slice(0, 300),
    ...(Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {}),
  };
}

async function upsertOrder(opts: {
  order: LegacyOrder;
  restaurantId: string;
  customerId: string;
  address: Record<string, unknown>;
  menuByName: Map<string, string> | undefined;
}): Promise<"inserted" | "updated" | "skipped_items"> {
  const { order, restaurantId, customerId, address, menuByName } = opts;
  const lines = parsePnameHtml(order.pname);
  if (!lines.length) return "skipped_items";

  const externalId = `legacy-${order.id}`;
  const status = mapLegacyOrderStatus(order.status);
  const createdAt = parseLegacyOrderTime(order.ordertime);
  const deliveryFee = parsePrice(order.dcharge);
  const taxAmount = parsePrice(order.tax);
  const total = parsePrice(order.price);
  const pickupOtp = (order.shop_otp || "").replace(/\D/g, "").slice(0, 4) || null;
  const deliveryOtp = (order.user_otp || "").replace(/\D/g, "").slice(0, 4) || null;

  const addressWithLegacy = {
    ...address,
    legacy_order_id: order.id,
  };

  const orderRow: Record<string, unknown> = {
    customer_id: customerId,
    restaurant_id: restaurantId,
    status,
    total,
    delivery_fee: deliveryFee,
    tax_amount: taxAmount,
    tip: 0,
    address: addressWithLegacy,
    pickup_otp: pickupOtp,
    delivery_otp: deliveryOtp,
  };
  if (await detectExternalIdColumn()) {
    orderRow.external_id = externalId;
  }
  if (createdAt) orderRow.created_at = createdAt;

  if (DRY_RUN) return "inserted";

  const existingId = await withRetry(
    () => findExistingOrderId(order.id),
    `lookup:${externalId}`
  );

  let orderId: string;
  let mode: "inserted" | "updated";

  if (existingId) {
    const { error } = await withRetry(
      () => admin.from("orders").update(orderRow).eq("id", existingId),
      `update:${externalId}`
    );
    if (error) throw new Error(error.message);
    orderId = existingId;
    mode = "updated";
    // Replace line items so re-runs stay accurate.
    const { error: delErr } = await withRetry(
      () => admin.from("order_items").delete().eq("order_id", orderId),
      `clear-items:${externalId}`
    );
    if (delErr) throw new Error(delErr.message);
  } else {
    const { data, error } = await withRetry(
      () => admin.from("orders").insert(orderRow).select("id").single(),
      `insert:${externalId}`
    );
    if (error) throw new Error(error.message);
    orderId = data.id as string;
    mode = "inserted";
  }

  const itemRows = lines.map((line) => {
    const key = line.name.toLowerCase().replace(/\s+/g, " ").trim();
    return {
      order_id: orderId,
      menu_item_id: menuByName?.get(key) ?? null,
      name: line.name,
      qty: line.qty,
      price: line.price,
    };
  });

  const { error: itemsErr } = await withRetry(
    () => admin.from("order_items").insert(itemRows),
    `items:${externalId}`
  );
  if (itemsErr) throw new Error(itemsErr.message);

  // Keep the legacy grand total — do NOT call recompute_order_total (pname
  // subtotals occasionally disagree with price by a few rupees).
  return mode;
}

async function main() {
  console.log(`Legacy JSON: ${jsonPath}`);
  if (DRY_RUN) console.log("DRY RUN — no Supabase writes\n");

  const legacy = loadLegacyExport(jsonPath);
  const shopById = new Map(legacy.shops.map((s) => [s.id, s]));
  const customerById = new Map(legacy.customers.map((c) => [c.id, c]));

  // All legacy orders are Bemetara (location_id=1); still filter to known shops.
  const all = legacy.orders
    .filter((o) => shopById.has(o.shop_id))
    .filter((o) => (ONLY_IDS.size ? ONLY_IDS.has(o.id) : true))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const batch = all.slice(OFFSET, OFFSET + LIMIT);

  console.log(
    `Orders to process: ${batch.length} (offset ${OFFSET}, eligible ${all.length}, raw ${legacy.orders.length})` +
      (ONLY_IDS.size ? ` · ids filter ${ONLY_IDS.size}` : "")
  );
  if (!DRY_RUN && CONCURRENCY > 1) console.log(`Concurrency: ${CONCURRENCY}`);
  console.log();

  const restaurantMap = DRY_RUN
    ? new Map(legacy.shops.map((s) => [s.id, `dry-${s.id}`]))
    : await loadRestaurantMap(legacy.shops);

  const phones = batch
    .map((o) => toE164(o.ophone || customerById.get(o.user_id)?.userphone || ""))
    .filter((p): p is string => Boolean(p));

  const customerMap = DRY_RUN
    ? new Map(phones.map((p) => [p, `dry-${p}`]))
    : await loadCustomerMapByPhone(phones);

  const restaurantIds = [...new Set(restaurantMap.values())];
  const menuLookup = DRY_RUN
    ? new Map<string, Map<string, string>>()
    : await loadMenuLookup(restaurantIds);

  const stats: Stats = {
    inserted: 0,
    updated: 0,
    skippedNoShop: 0,
    skippedNoCustomer: 0,
    skippedNoItems: 0,
    errors: 0,
  };

  let parseFails = 0;
  let done = 0;

  async function processOne(order: LegacyOrder) {
    try {
      const restaurantId = restaurantMap.get(order.shop_id);
      if (!restaurantId) {
        stats.skippedNoShop++;
        return;
      }

      const phone = toE164(
        order.ophone || customerById.get(order.user_id)?.userphone || ""
      );
      const customerId = phone ? customerMap.get(phone) : undefined;
      if (!customerId) {
        stats.skippedNoCustomer++;
        return;
      }

      const lines = parsePnameHtml(order.pname);
      if (!lines.length) {
        parseFails++;
        stats.skippedNoItems++;
        return;
      }

      const customer = customerById.get(order.user_id);
      const result = await upsertOrder({
        order,
        restaurantId,
        customerId,
        address: buildAddress(order, customer),
        menuByName: menuLookup.get(restaurantId),
      });

      if (result === "inserted") stats.inserted++;
      else if (result === "updated") stats.updated++;
      else stats.skippedNoItems++;
    } catch (err) {
      stats.errors++;
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err && "message" in err
            ? String((err as { message: unknown }).message)
            : JSON.stringify(err);
      console.error(`  ✗ order ${order.id}: ${msg}`);
    }

    if (THROTTLE_MS > 0) await sleep(THROTTLE_MS);

    done++;
    if (done % BATCH === 0 || done === batch.length) {
      console.log(
        `  … ${OFFSET + done}/${all.length} (+${stats.inserted} new, ~${stats.updated} upd, ` +
          `${stats.skippedNoCustomer} no-customer, ${stats.skippedNoShop} no-shop, ` +
          `${stats.skippedNoItems} no-items, ${stats.errors} err)`
      );
    }
  }

  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= batch.length) break;
      await processOne(batch[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batch.length) }, () => worker())
  );

  if (!DRY_RUN) {
    const outDir = join(__dirname, "..", ".local");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "legacy-order-import-summary.json"),
      JSON.stringify(
        {
          offset: OFFSET,
          batch: batch.length,
          parseFails,
          ...stats,
          eligible: all.length,
          raw: legacy.orders.length,
        },
        null,
        2
      )
    );
  }

  console.log(
    `\nDone: ${stats.inserted} inserted, ${stats.updated} updated, ` +
      `${stats.skippedNoCustomer} skipped (no customer), ` +
      `${stats.skippedNoShop} skipped (no shop), ` +
      `${stats.skippedNoItems} skipped (no items), ${stats.errors} errors` +
      (parseFails ? ` · ${parseFails} unparseable pname` : "")
  );
  if (stats.errors) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
