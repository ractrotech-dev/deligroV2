/**
 * Seed the developer/owner account — Gaurav — as an admin.
 *
 * This is the DB half of "make me the boss": it guarantees a profile exists for
 * the owner's phone (+91 7987265706), named "Gaurav", with role = admin. The
 * cosmetic half (the Developer badge + golden ring) is driven separately by the
 * phone allowlist in src/lib/developers.ts.
 *
 * Phone-OTP login resolves the profile whose `phone` matches (see
 * lib/data-access/otp.ts → resolveUser), so once this runs, OTP-ing in with
 * 7987265706 lands on this admin account. Uses the service-role key, which
 * bypasses the `lock_role` guard the same way the Supabase SQL editor does.
 *
 * Idempotent — safe to re-run. Prereqs: migrations 0001–0005, and a real
 * SUPABASE_SECRET_KEY (sb_secret_…) in .env.local.
 *
 *   npm run db:seed-developer
 *   npm run db:seed-developer -- --dry-run
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { toE164, phoneToSyntheticEmail } from "../src/lib/auth/phone";

// supabase-js eagerly builds a realtime client that needs a global WebSocket
// (native only on Node 22+). We only make REST calls here, but the constructor
// still requires it. Load `ws` lazily, only when the global is missing.
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

// The owner. Kept in step with DEVELOPER_PHONES in src/lib/developers.ts.
const DEVELOPER = { fullName: "Gaurav", rawPhone: "7987265706" };
const DRY_RUN = process.argv.includes("--dry-run");

const phone = toE164(DEVELOPER.rawPhone);
if (!phone) {
  console.error(`Not a usable phone number: ${DEVELOPER.rawPhone}`);
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Find an auth user by phone (digits, no "+"), paging through all users — a
 * single listUsers() call only returns one page.
 */
async function findUserIdByPhone(digits: string): Promise<string | undefined> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.phone ?? "").replace(/\D/g, "") === digits);
    if (hit) return hit.id;
    if (data.users.length < 1000) break;
  }
  return undefined;
}

async function main() {
  const digits = phone!.replace(/\D/g, "");

  // 1. Who holds this phone today? A profile match is the strongest signal —
  // that's the row OTP login resolves against.
  const { data: holder } = await admin
    .from("profiles")
    .select("id, role, full_name, phone")
    .eq("phone", phone!)
    .maybeSingle();

  let userId = holder?.id ?? (await findUserIdByPhone(digits));

  console.log(`Developer  : ${DEVELOPER.fullName}`);
  console.log(`Phone      : ${phone}`);
  console.log(
    userId
      ? `Existing   : profile/user ${userId}${holder ? ` · role=${holder.role} · name=${holder.full_name ?? "—"}` : " (auth user, no profile row yet)"}`
      : "Existing   : none — a fresh admin account will be created"
  );

  if (DRY_RUN) {
    console.log("\n--dry-run — nothing written.");
    return;
  }

  // 2. Create the auth user if there's none for this phone. The signup trigger
  // creates the matching profiles row; step 3 then elevates it.
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email: phoneToSyntheticEmail(phone!),
      phone: digits,
      phone_confirm: true,
      email_confirm: true,
      user_metadata: { full_name: DEVELOPER.fullName },
    });
    if (error) throw error;
    userId = data.user.id;
    console.log(`Created    : auth user ${userId}`);
  }

  // 3. Upsert (not update): role/name/phone stick even if the signup trigger
  // hasn't written the profile row yet — a bare UPDATE would hit 0 rows. Keep an
  // existing name (e.g. "Gaurav Mirjha") rather than clobbering it — the profile
  // header shows the first word either way.
  const fullName = holder?.full_name?.trim() || DEVELOPER.fullName;
  const { error: upErr } = await admin
    .from("profiles")
    .upsert(
      { id: userId, role: "admin", full_name: fullName, phone: phone! },
      { onConflict: "id" }
    );
  if (upErr) {
    console.error(
      `Could not set admin role — run 0003_lock_role_service_bypass.sql. (${upErr.message})`
    );
    process.exit(1);
  }
  console.log(`Profile    : role = admin · full_name = ${fullName} · phone = ${phone}`);

  // 4. Best-effort: keep auth.users.phone in step. Login doesn't read it
  // (resolveUser matches profiles.phone), so a failure here isn't fatal.
  const { error: authErr } = await admin.auth.admin.updateUserById(userId, {
    phone: digits,
    phone_confirm: true,
  });
  if (authErr) console.warn(`  ! auth.users.phone not updated: ${authErr.message}`);

  console.log(`\nDone. OTP in with ${DEVELOPER.rawPhone} to land on the admin account.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
