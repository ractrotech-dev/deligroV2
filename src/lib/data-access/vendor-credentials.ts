import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  columnKnownMissing,
  rememberColumn,
} from "@/lib/data-access/schema-probe";

/**
 * The admin-visible copy of each vendor's login password (migration 0039).
 *
 * Read the migration header before changing anything here — storing this at all
 * is a deliberate, documented reversal of audit finding C-2, and the reason it
 * is defensible is the containment, not the value:
 *
 *   * the secret lives in its own table, never on the publicly-readable
 *     `restaurants` row;
 *   * that table has RLS on with no policies and no grants to anon or
 *     authenticated, so `service_role` is the only thing that can see it;
 *   * `createAdminClient()` bypasses RLS, so every exported function here is
 *     only ever called from a path that has already run `requireRole("admin")`
 *     (AGENTS.md §5). Nothing in this module gates by itself.
 *
 * Supabase Auth still holds the bcrypt hash that actually authenticates. What
 * is stored here is a copy for the support desk to read back, written in the
 * same operation that sets the real password — so the two never drift.
 */

/** Probe key: has 0039 been applied? */
const CREDENTIALS_TABLE = "vendor_login_credentials";

/** Table missing (pre-0039). Degrade to "no stored password", never throw. */
function isMissingTable(
  error: { code?: string; message?: string } | null
): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const msg = (error.message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    msg.includes("schema cache") ||
    msg.includes("does not exist")
  );
}

export interface VendorCredential {
  password: string;
  updatedAt: string;
  ownerId: string | null;
}

/**
 * The stored password for one shop, or null when there is none (or the
 * migration hasn't been applied).
 */
export async function getVendorCredential(
  restaurantId: string
): Promise<VendorCredential | null> {
  if (columnKnownMissing(CREDENTIALS_TABLE)) return null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("vendor_login_credentials")
    .select("password, updated_at, owner_id")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) {
      rememberColumn(CREDENTIALS_TABLE, false);
      return null;
    }
    throw error;
  }
  rememberColumn(CREDENTIALS_TABLE, true);
  if (!data) return null;

  const row = data as {
    password: string;
    updated_at: string;
    owner_id: string | null;
  };
  return {
    password: row.password,
    updatedAt: row.updated_at,
    ownerId: row.owner_id,
  };
}

/**
 * Stored passwords for a page of shops, keyed by restaurant id.
 *
 * One query for the whole page rather than one per row — the list screen shows
 * up to 100 vendors, and a per-row read would be 100 round trips to render one
 * column.
 */
export async function listVendorCredentials(
  restaurantIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (restaurantIds.length === 0) return out;
  if (columnKnownMissing(CREDENTIALS_TABLE)) return out;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("vendor_login_credentials")
    .select("restaurant_id, password")
    .in("restaurant_id", restaurantIds);

  if (error) {
    if (isMissingTable(error)) {
      rememberColumn(CREDENTIALS_TABLE, false);
      return out;
    }
    throw error;
  }
  rememberColumn(CREDENTIALS_TABLE, true);

  for (const row of (data ?? []) as {
    restaurant_id: string;
    password: string;
  }[]) {
    out.set(row.restaurant_id, row.password);
  }
  return out;
}

/**
 * Record the password an admin just set on the auth user.
 *
 * Best-effort by design: the credential the vendor logs in with is the one
 * Supabase Auth holds, and that write has already succeeded by the time this is
 * called. If 0039 hasn't been applied the admin still gets the value on screen
 * once — losing the stored copy is not a reason to fail the reset.
 */
export async function storeVendorCredential(
  restaurantId: string,
  ownerId: string | null,
  password: string,
  updatedBy: string | null
): Promise<void> {
  if (columnKnownMissing(CREDENTIALS_TABLE)) return;

  const admin = createAdminClient();
  const { error } = await admin.from("vendor_login_credentials").upsert(
    {
      restaurant_id: restaurantId,
      owner_id: ownerId,
      password,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    },
    { onConflict: "restaurant_id" }
  );

  if (error) {
    if (isMissingTable(error)) {
      rememberColumn(CREDENTIALS_TABLE, false);
      return;
    }
    throw error;
  }
  rememberColumn(CREDENTIALS_TABLE, true);
}

