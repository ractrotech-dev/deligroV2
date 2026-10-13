/**
 * Create (or promote) a Developer-panel account.
 *
 * The Developer panel has its own role, `developer`, and an account has ONE
 * role. So a developer account is a SEPARATE login from any admin account: use a
 * different phone number from the one you operate the company with. An admin
 * cannot open the Developer panel, and a developer cannot open the admin console.
 *
 * Sign in afterwards at /developer/login with the phone number (OTP), like every
 * other portal. Uses the service-role key, which bypasses the `lock_role`
 * guard the same way the Supabase SQL editor does.
 *
 * Prerequisite: migration 0059_developer_role_enum.sql applied, and a real
 * SUPABASE_SECRET_KEY in .env.local. Idempotent: safe to re-run.
 *
 *   npm run db:create-developer -- --phone 98XXXXXX01 --name "Asha Verma" --dry-run
 *   npm run db:create-developer -- --phone 98XXXXXX01 --name "Asha Verma"
 *
 * It REFUSES to change an account that is already admin, manager, driver,
 * restaurant or developer-with-another-name unless you add --force, because that
 * silently removes the person's access to their current portal.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { toE164, phoneToSyntheticEmail } from "../src/lib/auth/phone";

const g = globalThis as { WebSocket?: unknown };
if (typeof g.WebSocket === "undefined") {
  g.WebSocket = createRequire(import.meta.url)("ws");
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  try {
    const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
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
    // .env.local is optional if the variables are already exported
  }
}
loadEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "";
if (!url.startsWith("http") || serviceKey.length < 20) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local");
  process.exit(1);
}

const rawPhone = arg("phone") ?? "";
const fullName = (arg("name") ?? "").trim();
const phone = toE164(rawPhone);
if (!phone) {
  console.error('Pass a usable phone number: --phone 98XXXXXX01 --name "Full Name"');
  process.exit(1);
}
if (!fullName) {
  console.error('Pass a name: --name "Full Name"');
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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

  const { data: holder } = await admin
    .from("profiles")
    .select("id, role, full_name, phone")
    .eq("phone", phone!)
    .maybeSingle();

  let userId = holder?.id ?? (await findUserIdByPhone(digits));

  console.log(`Name       : ${fullName}`);
  console.log(`Phone      : ${phone}`);
  console.log(
    userId
      ? `Existing   : ${userId}${holder ? ` · role=${holder.role} · name=${holder.full_name ?? "-"}` : " (auth user, no profile row)"}`
      : "Existing   : none, a new developer account will be created"
  );

  // An account has one role. Promoting someone who already has a portal would
  // take that portal away from them without a word.
  if (holder && holder.role !== "customer" && holder.role !== "developer" && !FORCE) {
    console.error(
      `\nRefusing: this phone is already a '${holder.role}' account. An account has ONE role, ` +
        "so making it a developer would remove its access to that portal.\n" +
        "Use a different phone number for the developer login, or add --force if you really mean it."
    );
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log("\n--dry-run, nothing written.");
    return;
  }

  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email: phoneToSyntheticEmail(phone!),
      phone: digits,
      phone_confirm: true,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) throw error;
    userId = data.user.id;
    console.log(`Created    : auth user ${userId}`);
  }

  const { error: upErr } = await admin
    .from("profiles")
    .upsert(
      { id: userId, role: "developer", full_name: holder?.full_name?.trim() || fullName, phone: phone! },
      { onConflict: "id" }
    );
  if (upErr) {
    console.error(
      `Could not set the developer role. Is migration 0059 applied? (${upErr.message})`
    );
    process.exit(1);
  }
  console.log(`Profile    : role = developer · phone = ${phone}`);

  const { error: authErr } = await admin.auth.admin.updateUserById(userId, {
    phone: digits,
    phone_confirm: true,
  });
  if (authErr) console.warn(`(auth phone not updated: ${authErr.message})`);

  console.log("\nDone. Sign in at /developer/login with this phone number (OTP).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
