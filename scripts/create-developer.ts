/**
 * Create (or promote) a Developer-panel account, by phone or by email.
 *
 * The Developer panel has its own role, `developer`, and an account has ONE
 * role. So a developer account is a SEPARATE login from any admin account. An
 * admin cannot open the Developer panel, and a developer cannot open the admin
 * console.
 *
 * Sign in afterwards at /developer/login: with the phone number (OTP), or with
 * the email and password. Uses the service-role key, which bypasses the
 * `lock_role` guard the same way the Supabase SQL editor does.
 *
 * Prerequisite: migration 0059_developer_role_enum.sql applied, and a real
 * SUPABASE_SECRET_KEY in .env.local. The script checks the migration first and
 * writes nothing if it is missing. Idempotent: safe to re-run.
 *
 *   by phone (OTP login):
 *     npm run db:create-developer -- --phone 98XXXXXX01 --name "Asha Verma" --dry-run
 *     npm run db:create-developer -- --phone 98XXXXXX01 --name "Asha Verma"
 *
 *   by email (password login). The password is read from the DEVELOPER_PASSWORD
 *   environment variable, never from the command line, so it does not land in
 *   shell history or process listings; it is only needed to create a new user:
 *     DEVELOPER_PASSWORD='...' npm run db:create-developer -- --email dev@example.com --name "Dev"
 *
 * It REFUSES to change an account that is already admin, manager, driver or
 * restaurant unless you add --force, because that silently removes the person's
 * access to their current portal.
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

const rawPhone = arg("phone");
const rawEmail = arg("email")?.trim().toLowerCase();
const fullName = (arg("name") ?? "").trim();

if ((rawPhone ? 1 : 0) + (rawEmail ? 1 : 0) !== 1) {
  console.error('Pass exactly one of --phone 98XXXXXX01 or --email name@example.com, plus --name "Full Name"');
  process.exit(1);
}
const phone = rawPhone ? toE164(rawPhone) : null;
if (rawPhone && !phone) {
  console.error("That is not a usable phone number.");
  process.exit(1);
}
// local@domain, the domain holding a dot that is neither its first nor last
// character. Pinned to the domain's first dot after its first character so the
// regex never has to backtrack over where the dot is.
if (rawEmail && !/^[^\s@]+@[^\s@][^\s@.]*\.[^\s@]+$/.test(rawEmail)) {
  console.error("That is not a usable email address.");
  process.exit(1);
}
if (!fullName) {
  console.error('Pass a name: --name "Full Name"');
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function findUserId(match: (u: { email?: string; phone?: string }) => boolean): Promise<string | undefined> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => match({ email: u.email ?? undefined, phone: u.phone ?? undefined }));
    if (hit) return hit.id;
    if (data.users.length < 1000) break;
  }
  return undefined;
}

async function main() {
  // 0. Is the role there? Reading with the new label fails on a database that
  // has not had 0059 applied. Checked before anything is written, so a missing
  // migration cannot leave a half-made account behind.
  const probe = await admin
    .from("profiles")
    .select("id", { head: true, count: "exact" })
    .eq("role", "developer");
  if (probe.error) {
    console.error(
      "\nThe database does not know the 'developer' role yet. Apply migration 0059 first, " +
        "in the Supabase SQL editor, on its own:\n\n" +
        "  alter type public.user_role add value if not exists 'developer';\n\n" +
        `Nothing was written. (${probe.error.message})`
    );
    process.exit(1);
  }

  const digits = phone ? phone.replace(/\D/g, "") : "";
  let userId = rawEmail
    ? await findUserId((u) => (u.email ?? "").toLowerCase() === rawEmail)
    : await findUserId((u) => (u.phone ?? "").replace(/\D/g, "") === digits);

  const { data: holder } = userId
    ? await admin.from("profiles").select("id, role, full_name").eq("id", userId).maybeSingle()
    : { data: null };

  console.log(`Name       : ${fullName}`);
  console.log(`Login      : ${rawEmail ? `email ${rawEmail} (password)` : `phone ${phone} (OTP)`}`);
  console.log(
    userId
      ? `Existing   : ${userId}${holder ? ` · role=${holder.role} · name=${holder.full_name ?? "-"}` : " (auth user, no profile row)"}`
      : "Existing   : none, a new developer account will be created"
  );

  // An account has one role. Promoting someone who already has a portal would
  // take that portal away from them without a word.
  if (holder && holder.role !== "customer" && holder.role !== "developer" && !FORCE) {
    console.error(
      `\nRefusing: this login is already a '${holder.role}' account. An account has ONE role, ` +
        "so making it a developer would remove its access to that portal.\n" +
        "Use a different login for the developer, or add --force if you really mean it."
    );
    process.exit(1);
  }

  const password = process.env.DEVELOPER_PASSWORD ?? "";
  if (rawEmail && !userId && password.length < 8) {
    console.error("\nCreating a new email login needs the DEVELOPER_PASSWORD environment variable (at least 8 characters).");
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log("\n--dry-run, nothing written.");
    return;
  }

  if (!userId) {
    const { data, error } = rawEmail
      ? await admin.auth.admin.createUser({
          email: rawEmail,
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName },
        })
      : await admin.auth.admin.createUser({
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

  // Only the columns we mean to set: an existing phone or name is kept.
  const { error: upErr } = await admin.from("profiles").upsert(
    {
      id: userId,
      role: "developer",
      full_name: holder?.full_name?.trim() || fullName,
      ...(phone ? { phone } : {}),
    },
    { onConflict: "id" }
  );
  if (upErr) {
    console.error(`Could not set the developer role: ${upErr.message}`);
    process.exit(1);
  }
  console.log("Profile    : role = developer");

  if (phone) {
    const { error: authErr } = await admin.auth.admin.updateUserById(userId, {
      phone: digits,
      phone_confirm: true,
    });
    if (authErr) console.warn(`(auth phone not updated: ${authErr.message})`);
  }

  console.log("\nDone. Sign in at /developer/login.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
