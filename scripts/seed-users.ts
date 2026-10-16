/**
 * Seed test accounts for every operator role.
 *
 * Creates (idempotently) one login per role and elevates it — using the
 * service-role key, which bypasses the `lock_role` guard the same way the
 * Supabase SQL editor does.
 *
 * Prereqs: run 0001–0003 migrations first, and put a real
 * SUPABASE_SECRET_KEY (sb_secret_…) in .env.local.
 *
 *   npm run db:seed-users
 *
 * The restaurant account matches the one `npm run db:seed` uses, so after you
 * also run the catalog seed it will own the seeded restaurants and its
 * /vendor board will be populated.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// supabase-js eagerly builds a realtime client that needs a global WebSocket
// (native only on Node 22+). We only make REST calls here, but the constructor
// still requires it. Load `ws` lazily via require, only when the global is
// missing — so it's not a hard build/type dependency, and Node 22+ skips it.
const g = globalThis as { WebSocket?: unknown };
if (typeof g.WebSocket === "undefined") {
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
    "Missing NEXT_PUBLIC_SUPABASE_URL or a real SUPABASE_SECRET_KEY in .env.local.\n" +
      "Paste the sb_secret_… key from Supabase → Settings → API."
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Role = "restaurant" | "driver" | "admin";

/**
 * Never a literal: a password committed to the repository is a public password,
 * and one of these accounts is an *admin*. Supply it at run time:
 *
 *   SEED_PASSWORD='...' npm run db:seed-users
 */
const PASSWORD = process.env.SEED_PASSWORD ?? "";
if (PASSWORD.length < 12) {
  console.error(
    "Set SEED_PASSWORD (12+ chars) before seeding — these accounts include an admin.\n" +
      "  Generate one with `openssl rand -base64 18`, export it as SEED_PASSWORD, then npm run db:seed-users"
  );
  process.exit(1);
}

const ACCOUNTS: { email: string; role: Role; fullName: string }[] = [
  // Same email seed-catalog uses, so this account owns the seeded restaurants.
  { email: "vendor@deligro.demo", role: "restaurant", fullName: "Demo Vendor" },
  { email: "driver@deligro.demo", role: "driver", fullName: "Demo Driver" },
  { email: "admin@deligro.demo", role: "admin", fullName: "Demo Admin" },
];

/**
 * Find a user by email, paging through ALL users. A single listUsers() call
 * only returns one page (default/perPage cap), so once auth.users grows past
 * that — e.g. after the legacy customer import — a bare lookup misses seeded
 * accounts and createUser() then fails with "already registered".
 */
async function findUserId(email: string): Promise<string | undefined> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) break; // reached the last page
  }
  return undefined;
}

async function ensureAccount(email: string, role: Role, fullName: string) {
  let userId = await findUserId(email);

  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) throw error;
    userId = data.user.id;
    console.log(`Created ${role} user: ${email}`);
  } else {
    // Reset the password so a half-seeded account (unknown password) becomes
    // usable again with the documented demo password.
    const { error } = await admin.auth.admin.updateUserById(userId, {
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
    console.log(`${role} user exists — password reset: ${email}`);
  }

  // Upsert (not update): guarantees the role sticks even if the signup trigger
  // hasn't created the profile row yet — a bare UPDATE would silently hit 0 rows.
  const { error: roleErr } = await admin
    .from("profiles")
    .upsert({ id: userId, role, full_name: fullName }, { onConflict: "id" });
  if (roleErr) {
    console.warn(
      `  ! could not set role for ${email} — run 0003_lock_role_service_bypass.sql. (${roleErr.message})`
    );
  } else {
    console.log(`  → role = ${role}`);
  }
}

async function main() {
  for (const a of ACCOUNTS) {
    await ensureAccount(a.email, a.role, a.fullName);
  }
  console.log(
    `\nDone. Sign in at /login with any of the above emails · password: ${PASSWORD}`
  );
  console.log(
    "Tip: run `npm run db:seed` too, so the vendor owns restaurants and its /vendor board fills up."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
