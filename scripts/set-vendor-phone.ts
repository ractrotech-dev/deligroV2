/**
 * Give a restaurant's owner a phone number, so that number can OTP into /vendor.
 *
 * Phone-OTP login resolves the profile whose `phone` matches (see
 * lib/data-access/otp.ts → resolveUser), so attaching the number to the owner's
 * profile is what makes the code land on the vendor board instead of creating a
 * fresh customer. `profiles_phone_unique` allows exactly one profile per phone,
 * so the number is detached from whatever profile currently holds it — which
 * means it stops working as a customer login.
 *
 * Prereqs: migrations 0001–0005, catalog seeded/imported, SUPABASE_SECRET_KEY.
 *
 * Usage:
 *   npm run db:set-vendor-phone -- --restaurant=saffron-kitchen --phone=6260451258
 *   npm run db:set-vendor-phone -- --restaurant=saffron-kitchen --phone=6260451258 --dry-run
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { toE164 } from "../src/lib/auth/phone";

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
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local");
  process.exit(1);
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const DRY_RUN = process.argv.includes("--dry-run");
const slug = arg("restaurant");
const rawPhone = arg("phone");

if (!slug || !rawPhone) {
  console.error("Usage: --restaurant=<slug> --phone=<number> [--dry-run]");
  process.exit(1);
}

const phone = toE164(rawPhone);
if (!phone) {
  console.error(`Not a usable phone number: ${rawPhone}`);
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const { data: restaurant, error: rErr } = await admin
    .from("restaurants")
    .select("id, slug, name, owner_id")
    .eq("slug", slug!)
    .maybeSingle();

  if (rErr) throw rErr;
  if (!restaurant) {
    console.error(`No restaurant with slug "${slug}".`);
    process.exit(1);
  }
  if (!restaurant.owner_id) {
    console.error(
      `"${restaurant.name}" has no owner_id — run db:seed or db:import-legacy-owners first.`
    );
    process.exit(1);
  }

  const { data: owner, error: oErr } = await admin
    .from("profiles")
    .select("id, role, full_name, phone")
    .eq("id", restaurant.owner_id)
    .maybeSingle();
  if (oErr) throw oErr;
  if (!owner) {
    console.error(`Owner profile ${restaurant.owner_id} is missing.`);
    process.exit(1);
  }

  const { data: ownedAll } = await admin
    .from("restaurants")
    .select("slug")
    .eq("owner_id", owner.id);

  console.log(`Restaurant : ${restaurant.name} (${restaurant.slug})`);
  console.log(`Owner      : ${owner.full_name ?? "—"} · role=${owner.role} · phone=${owner.phone ?? "—"}`);
  console.log(`Owner's restaurants: ${ownedAll?.map((r) => r.slug).join(", ") ?? "—"}`);
  console.log(`New phone  : ${phone}`);

  // Whoever holds this number today loses it — one profile per phone.
  const { data: holder } = await admin
    .from("profiles")
    .select("id, role, full_name")
    .eq("phone", phone)
    .maybeSingle();

  if (holder && holder.id !== owner.id) {
    console.log(`Detaching  : ${phone} from existing ${holder.role} profile ${holder.id}`);
  }

  if (DRY_RUN) {
    console.log("\n--dry-run — nothing written.");
    return;
  }

  if (holder && holder.id !== owner.id) {
    const { error } = await admin.from("profiles").update({ phone: null }).eq("id", holder.id);
    if (error) throw error;
    // auth.users.phone is unique too, so free it there before claiming it below.
    await admin.auth.admin.updateUserById(holder.id, { phone: "" });
  }

  const { error: setErr } = await admin
    .from("profiles")
    .update({ phone, role: "restaurant" })
    .eq("id", owner.id);
  if (setErr) throw setErr;

  // Best-effort: keep auth.users in step. Login doesn't read it (resolveUser
  // matches on profiles.phone), so a failure here is not fatal.
  const { error: authErr } = await admin.auth.admin.updateUserById(owner.id, {
    phone: phone.replace("+", ""),
    phone_confirm: true,
  });
  if (authErr) console.warn(`  ! auth.users.phone not updated: ${authErr.message}`);

  console.log(`\nDone. ${phone} now OTPs into /vendor as the owner of ${restaurant.name}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
