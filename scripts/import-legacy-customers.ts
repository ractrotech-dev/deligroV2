/**
 * Import legacy customer phones into Supabase Auth + profiles for OTP login.
 *
 * Creates phone-based accounts (synthetic email) so returning customers can
 * sign in with OTP. NEVER imports user.auth plaintext passwords.
 *
 *   npm run db:import-legacy-customers
 *   npm run db:import-legacy-customers -- --dry-run
 *   LEGACY_CUSTOMER_LIMIT=100 npm run db:import-legacy-customers  # test batch
 *   LEGACY_CUSTOMER_OFFSET=500 npm run db:import-legacy-customers # resume
 *   LEGACY_IMPORT_CONCURRENCY=4 npm run db:import-legacy-customers
 *
 * Faster bulk path: npm run db:generate-legacy-customers-sql → paste in Supabase SQL Editor.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { phoneToSyntheticEmail, toE164 } from "../src/lib/auth/phone";
import { loadLegacyExport } from "./lib/legacy-db";
import {
  findAuthUserByEmail,
  findProfileByPhone,
  loadEnvFile,
  sleep,
  withRetry,
} from "./lib/import-env";

const g = globalThis as { WebSocket?: unknown };
if (g.WebSocket === undefined) {
  g.WebSocket = createRequire(import.meta.url)("ws");
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = Number(process.env.LEGACY_CUSTOMER_LIMIT ?? "0") || Infinity;
const OFFSET = Number(process.env.LEGACY_CUSTOMER_OFFSET ?? "0") || 0;
const THROTTLE_MS = Number(process.env.LEGACY_IMPORT_THROTTLE_MS ?? "50") || 0;
const CONCURRENCY = Number(process.env.LEGACY_IMPORT_CONCURRENCY ?? "4") || 1;

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
    join(__dirname, "..", "..", "u231346219_deligro.json")
);

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function dedupeCustomers(
  rows: ReturnType<typeof loadLegacyExport>["customers"]
) {
  const seen = new Set<string>();
  const out: { legacyId: string; phone: string; name: string }[] = [];
  for (const row of rows) {
    const phone = toE164(row.userphone ?? "");
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    const name = row.username?.trim() || "Customer";
    out.push({ legacyId: row.id, phone, name });
  }
  return out;
}

function userExistsError(message: string | undefined) {
  return /already|registered|exists|duplicate/i.test(message ?? "");
}

async function ensureCustomer(row: {
  legacyId: string;
  phone: string;
  name: string;
}): Promise<"created" | "updated" | "skipped" | "error"> {
  const email = phoneToSyntheticEmail(row.phone);

  if (DRY_RUN) return "updated";

  const existingProfile = await withRetry(
    () => findProfileByPhone(admin, row.phone),
    `profile:${row.phone}`
  );
  if (existingProfile?.id) {
    if (existingProfile.role !== "customer") return "skipped";
    await withRetry(
      () =>
        admin
          .from("profiles")
          .update({ full_name: row.name })
          .eq("id", existingProfile.id),
      `profile-update:${row.phone}`
    );
    return "updated";
  }

  let userId: string | undefined;
  let created = false;

  const { data: createdUser, error: createErr } = await withRetry(
    () =>
      admin.auth.admin.createUser({
        email,
        phone: row.phone,
        email_confirm: true,
        phone_confirm: true,
        user_metadata: {
          full_name: row.name,
          legacy_user_id: row.legacyId,
          phone: row.phone,
        },
      }),
    `create:${row.phone}`
  );

  if (createErr || !createdUser?.user) {
    if (!userExistsError(createErr?.message)) return "error";
    const existingUser = await withRetry(
      () => findAuthUserByEmail(admin, email),
      `lookup:${email}`
    );
    if (!existingUser) return "error";
    userId = existingUser.id;
  } else {
    userId = createdUser.user.id;
    created = true;
  }

  const { error: profileErr } = await withRetry(
    () =>
      admin
        .from("profiles")
        .update({
          full_name: row.name,
          phone: row.phone,
          role: "customer",
        })
        .eq("id", userId!),
    `profile-link:${row.phone}`
  );

  if (profileErr) return "error";
  return created ? "created" : "updated";
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
) {
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
}

async function main() {
  const legacy = loadLegacyExport(jsonPath);
  const all = dedupeCustomers(legacy.customers);
  const customers = all.slice(OFFSET, OFFSET + LIMIT);

  console.log(`Legacy JSON: ${jsonPath}`);
  console.log(
    `Customer phones: ${customers.length} (offset ${OFFSET}, total unique ${all.length})`
  );
  if (DRY_RUN) console.log("DRY RUN\n");
  else if (CONCURRENCY > 1) console.log(`Concurrency: ${CONCURRENCY}\n`);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let done = 0;

  await runPool(customers, CONCURRENCY, async (row) => {
    try {
      const status = await ensureCustomer(row);
      if (status === "created") created++;
      else if (status === "updated") updated++;
      else if (status === "skipped") skipped++;
      else errors++;
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${row.phone}: ${msg}`);
    }

    if (THROTTLE_MS > 0) await sleep(THROTTLE_MS);

    done++;
    if (done % 100 === 0 || done === customers.length) {
      console.log(
        `  … ${OFFSET + done}/${all.length} (+${created} new, ~${updated} updated, ${skipped} skipped, ${errors} err)`
      );
    }
  });

  if (!DRY_RUN) {
    const outDir = join(__dirname, "..", ".local");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "legacy-customer-import-summary.json"),
      JSON.stringify(
        {
          offset: OFFSET,
          batch: customers.length,
          created,
          updated,
          skipped,
          errors,
          totalUnique: all.length,
        },
        null,
        2
      )
    );
  }

  console.log(
    `\nDone: ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors`
  );
  if (errors) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
