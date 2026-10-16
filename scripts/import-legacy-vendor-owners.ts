/**
 * Create one Supabase owner account per legacy shop and link restaurants.owner_id.
 *
 * The old MySQL `shop` table stored login as email + plaintext `auth` on each row —
 * NOT as separate user records. This script creates real auth.users + profiles and
 * points each migrated restaurant at its own owner.
 *
 * NEVER imports shop.auth (plaintext passwords).
 *
 * Prereqs:
 *   - Migrations 0001–0003
 *   - Legacy catalog already imported (npm run db:import-legacy)
 *   - SUPABASE_SECRET_KEY in .env.local
 *
 * Usage:
 *   npm run db:import-legacy-owners
 *   npm run db:import-legacy-owners -- --dry-run
 *
 * After run: share credentials from legacy-vendor-credentials.json (gitignored)
 * or have owners use "Forgot password" / OTP on their phone.
 */
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  isBemetaraShop,
  loadLegacyExport,
  resolveShopImportScope,
  selectShops,
  shopSlug,
} from "./lib/legacy-db";
import {
  legacyShopLoginEmail,
  legacyShopPhone,
} from "./lib/legacy-vendor-auth";

const g = globalThis as { WebSocket?: unknown };
if (g.WebSocket === undefined) {
  g.WebSocket = createRequire(import.meta.url)("ws");
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes("--dry-run");

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
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const jsonPath = resolve(
  process.env.LEGACY_DB_JSON ??
    join(__dirname, "..", "..", "u231346219_deligro.json")
);

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function tempPassword(): string {
  return `Lg${randomBytes(9).toString("base64url")}!`;
}

async function findUserByEmail(email: string) {
  // Paginate — project may have more than one page of users.
  let page = 1;
  const perPage = 200;
  while (page <= 20) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage });
    const users = data?.users ?? [];
    const hit = users.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    );
    if (hit) return hit;
    if (users.length < perPage) break;
    page++;
  }
  return null;
}

interface OwnerResult {
  legacyShopId: string;
  restaurantName: string;
  slug: string;
  loginEmail: string;
  phone: string | null;
  userId?: string;
  tempPassword?: string;
  status: "created" | "linked" | "skipped" | "error";
  error?: string;
}

/** The progress-line marker: failed, newly created, or already there. */
const STATUS_MARK: Record<OwnerResult["status"], string> = {
  error: "✗",
  created: "+",
  linked: "~",
  skipped: "~",
};

async function ensureOwner(shop: ReturnType<typeof selectShops>[number]): Promise<OwnerResult> {
  const slug = shopSlug(shop);
  const loginEmail = legacyShopLoginEmail(shop);
  const phone = legacyShopPhone(shop);

  const base: OwnerResult = {
    legacyShopId: shop.id,
    restaurantName: shop.sname.trim(),
    slug,
    loginEmail: loginEmail ?? "",
    phone,
    status: "skipped",
  };

  if (!loginEmail) {
    return { ...base, error: "no_valid_email_or_phone", status: "error" };
  }

  if (DRY_RUN) {
    return { ...base, status: "linked", userId: `dry-run-${shop.id}` };
  }

  let userId: string | undefined;
  let password: string | undefined;
  let created = false;

  const existing = await findUserByEmail(loginEmail);
  if (existing) {
    userId = existing.id;
  } else {
    password = tempPassword();
    const { data, error } = await admin.auth.admin.createUser({
      email: loginEmail,
      password,
      email_confirm: true,
      phone: phone ?? undefined,
      phone_confirm: phone ? true : undefined,
      user_metadata: {
        full_name: shop.sname.trim(),
        legacy_shop_id: shop.id,
      },
    });
    if (error || !data.user) {
      return {
        ...base,
        status: "error",
        error: error?.message ?? "create_user_failed",
      };
    }
    userId = data.user.id;
    created = true;
  }

  const { error: profileErr } = await admin
    .from("profiles")
    .update({
      role: "restaurant",
      full_name: shop.sname.trim(),
      phone: phone ?? null,
    })
    .eq("id", userId);

  if (profileErr) {
    return { ...base, userId, status: "error", error: profileErr.message };
  }

  const { data: restaurant, error: linkErr } = await admin
    .from("restaurants")
    .update({ owner_id: userId })
    .eq("slug", slug)
    .select("id")
    .maybeSingle();

  if (linkErr) {
    return { ...base, userId, status: "error", error: linkErr.message };
  }
  if (!restaurant?.id) {
    return {
      ...base,
      userId,
      status: "error",
      error: `restaurant_not_found_for_slug:${slug}`,
    };
  }

  return {
    ...base,
    userId,
    tempPassword: created ? password : undefined,
    status: created ? "created" : "linked",
  };
}

async function main() {
  const scope = resolveShopImportScope();
  const legacy = loadLegacyExport(jsonPath);
  const shops = selectShops(legacy.shops, scope).filter(isBemetaraShop);

  console.log(`Legacy JSON: ${jsonPath}`);
  console.log(`Shops to provision: ${shops.length} (${scope})`);
  if (DRY_RUN) console.log("DRY RUN — no writes\n");

  const results: OwnerResult[] = [];
  for (const shop of shops) {
    const result = await ensureOwner(shop);
    results.push(result);
    const mark = STATUS_MARK[result.status];
    console.log(
      `${mark} #${shop.id} ${shop.sname.slice(0, 32)} → ${result.loginEmail || "?"} (${result.status})`
    );
    if (result.error) console.log(`    ${result.error}`);
  }

  const created = results.filter((r) => r.status === "created");
  const linked = results.filter((r) => r.status === "linked");
  const errors = results.filter((r) => r.status === "error");

  if (!DRY_RUN && created.length > 0) {
    const outDir = join(__dirname, "..", ".local");
    mkdirSync(outDir, { recursive: true });
    const credPath = join(outDir, "legacy-vendor-credentials.json");
    const creds = created.map((r) => ({
      legacyShopId: r.legacyShopId,
      restaurant: r.restaurantName,
      slug: r.slug,
      email: r.loginEmail,
      phone: r.phone,
      tempPassword: r.tempPassword,
      loginUrl: "http://localhost:3003/login",
    }));
    writeFileSync(credPath, JSON.stringify(creds, null, 2), "utf8");
    console.log(`\nWrote ${created.length} temp passwords → ${credPath}`);
    console.log("(gitignored — share securely with each restaurant owner)");
  }

  console.log(
    `\nDone: ${created.length} created, ${linked.length} linked existing, ${errors.length} errors`
  );
  if (errors.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
