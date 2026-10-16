/**
 * Generate Supabase-ready SQL for legacy customer phone accounts (OTP login).
 *
 * Output: supabase/seed/legacy_customers.sql
 * Paste into Supabase → SQL Editor after vendor owner import.
 *
 *   npm run db:generate-legacy-customers-sql
 *
 * Idempotent: skips phones/emails that already exist. Never imports plaintext passwords.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { phoneToSyntheticEmail, toE164 } from "../src/lib/auth/phone";
import { loadLegacyExport } from "./lib/legacy-db";
import { legacyShopPhone } from "./lib/legacy-vendor-auth";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BATCH = Number(process.env.LEGACY_CUSTOMER_SQL_BATCH ?? "80") || 80;

const jsonPath = resolve(
  process.env.LEGACY_DB_JSON ??
    join(__dirname, "..", "..", "u231346219_deligro.json")
);
const outPath = join(__dirname, "..", "supabase", "seed", "legacy_customers.sql");

function sqlStr(value: string | null | undefined): string {
  if (value == null || value === "") return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function dedupeCustomers(
  rows: ReturnType<typeof loadLegacyExport>["customers"],
  skipPhones: Set<string>
) {
  const seen = new Set<string>();
  const out: { legacyId: string; phone: string; name: string; email: string }[] =
    [];
  for (const row of rows) {
    const phone = toE164(row.userphone ?? "");
    if (!phone || seen.has(phone) || skipPhones.has(phone)) continue;
    seen.add(phone);
    out.push({
      legacyId: row.id,
      phone,
      name: row.username?.trim() || "Customer",
      email: phoneToSyntheticEmail(phone),
    });
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function main() {
  const legacy = loadLegacyExport(jsonPath);
  const ownerPhones = new Set(
    legacy.shops
      .map((s) => legacyShopPhone(s))
      .filter((p): p is string => Boolean(p))
  );
  const customers = dedupeCustomers(legacy.customers, ownerPhones);

  const lines: string[] = [
    "-- ============================================================",
    "-- Deligro — legacy customer accounts (generated)",
    "-- ------------------------------------------------------------",
    `-- Source: ${jsonPath}`,
    `-- Customers: ${customers.length} unique phones · generated ${new Date().toISOString()}`,
    "--",
    "-- Prereqs: migrations 0001–0006, vendor owners imported",
    "-- Run in Supabase → SQL Editor. Idempotent (skips existing phone/email).",
    "-- OTP login only — no legacy passwords imported.",
    "-- ============================================================",
    "",
    "BEGIN;",
    "",
  ];

  for (const [batchIdx, batch] of chunk(customers, BATCH).entries()) {
    const valueRows = batch
      .map(
        (c) =>
          `(${sqlStr(c.email)}, ${sqlStr(c.phone)}, ${sqlStr(c.name)}, ${sqlStr(c.legacyId)})`
      )
      .join(",\n    ");

    lines.push(
      `-- batch ${batchIdx + 1}`,
      "WITH incoming (email, phone, full_name, legacy_id) AS (",
      `  VALUES\n    ${valueRows}`,
      "),",
      "to_insert AS (",
      "  SELECT i.*",
      "  FROM incoming i",
      "  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.email = i.email)",
      "    AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.phone = i.phone)",
      "),",
      "inserted AS (",
      "  INSERT INTO auth.users (",
      "    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,",
      "    raw_app_meta_data, raw_user_meta_data, created_at, updated_at, phone, phone_confirmed_at,",
      "    is_sso_user, confirmation_token",
      "  )",
      "  SELECT",
      "    '00000000-0000-0000-0000-000000000000',",
      "    gen_random_uuid(),",
      "    'authenticated',",
      "    'authenticated',",
      "    t.email,",
      "    crypt(gen_random_uuid()::text, gen_salt('bf')),",
      "    now(),",
      "    '{\"provider\":\"email\",\"providers\":[\"email\",\"phone\"]}'::jsonb,",
      "    jsonb_build_object('full_name', t.full_name, 'legacy_user_id', t.legacy_id, 'phone', t.phone),",
      "    now(), now(), t.phone, now(), false, ''",
      "  FROM to_insert t",
      "  RETURNING id, email",
      ")",
      "INSERT INTO auth.identities (",
      "  id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at",
      ")",
      "SELECT",
      "  gen_random_uuid(),",
      "  i.id,",
      "  jsonb_build_object('sub', i.id::text, 'email', i.email),",
      "  'email',",
      "  i.id::text,",
      "  now(), now(), now()",
      "FROM inserted i;",
      "",
    );
  }

  lines.push("-- backfill names for any pre-existing customer profiles");
  for (const [batchIdx, batch] of chunk(customers, BATCH).entries()) {
    const valueRows = batch
      .map((c) => `(${sqlStr(c.phone)}, ${sqlStr(c.name)})`)
      .join(",\n    ");
    lines.push(
      `-- name backfill batch ${batchIdx + 1}`,
      "UPDATE public.profiles p",
      "SET full_name = v.full_name",
      `FROM (VALUES\n    ${valueRows}) AS v(phone, full_name)`,
      "WHERE p.phone = v.phone AND p.role = 'customer';",
      "",
    );
  }

  lines.push(
    "COMMIT;",
    "",
    "-- verify",
    "SELECT count(*) FILTER (WHERE role = 'customer') AS customer_profiles FROM public.profiles;",
  );

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${customers.length} customers → ${outPath}`);
  console.log(`Skipped ${ownerPhones.size} restaurant-owner phones`);
}

main();
