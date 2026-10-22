import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { RiderSchemaPendingError } from "@/lib/data-access/rider-status";
import { maskPayoutAccount, type PayoutAccountInput } from "@/lib/rider/profile-rules";

/**
 * Riders' bank and UPI details (migration 0086) — the ONLY module that reads or
 * writes `rider_payout_accounts` and `rider_payout_accounts_staged`.
 *
 * Read the 0086 header before changing anything here. The details are
 * money-routing data, kept with the `vendor_login_credentials` containment
 * (AGENTS.md rule 4):
 *
 *   * their own tables, never a column on a table a client can read;
 *   * RLS on with NO policies and every privilege revoked from anon and
 *     authenticated, so the service role is the only thing that can see them;
 *   * `createAdminClient()` bypasses RLS, so nothing here gates by itself and
 *     every caller has authorised first (AGENTS.md rule 5).
 *
 * Two kinds of caller, and the names say which is which:
 *
 *   * the rider's own routes (`/api/rider/*`, behind `requireRiderApi()`, the
 *     rider id from the session): `getMaskedPayoutAccount`,
 *     `getMaskedStagedAccount`, `stagePayoutAccount`,
 *     `discardStagedPayoutAccount`. These never return a full number;
 *   * the admin console, behind `requireRole("admin")`: the `…ForAdmin`
 *     functions return the details in full — shown only on the rider's
 *     Profile tab.
 *
 * Applying an approved change (staged → live) is not here: it is
 * `rider_decide_change_request` in the database, atomic with the decision.
 */

const LIVE = "rider_payout_accounts";
const STAGED = "rider_payout_accounts_staged";

export interface PayoutAccount {
  kind: "bank" | "upi";
  holderName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  upiId: string | null;
}

interface AccountRow {
  kind: "bank" | "upi";
  holder_name: string | null;
  account_number: string | null;
  ifsc: string | null;
  upi_id: string | null;
}

const COLUMNS = "kind, holder_name, account_number, ifsc, upi_id";

function toAccount(row: AccountRow): PayoutAccount {
  return {
    kind: row.kind,
    holderName: row.holder_name,
    accountNumber: row.account_number,
    ifsc: row.ifsc,
    upiId: row.upi_id,
  };
}

function toRow(value: PayoutAccountInput): AccountRow {
  return value.kind === "bank"
    ? { kind: "bank", holder_name: value.holderName, account_number: value.accountNumber, ifsc: value.ifsc, upi_id: null }
    : { kind: "upi", holder_name: value.holderName, account_number: null, ifsc: null, upi_id: value.upiId };
}

function fail(error: { code?: string; message?: string }): never {
  if (isMissingTable(error)) {
    throw new RiderSchemaPendingError("migration_pending: rider_payout_accounts (0086) is not applied");
  }
  throw error;
}

async function readLive(driverId: string): Promise<(AccountRow & { updated_at: string; updated_by: string | null }) | null> {
  const { data, error } = await createAdminClient()
    .from(LIVE)
    .select(`${COLUMNS}, updated_at, updated_by`)
    .eq("driver_id", driverId)
    .maybeSingle()
    .overrideTypes<AccountRow & { updated_at: string; updated_by: string | null }>();
  if (error) fail(error);
  return data ?? null;
}

async function readStaged(driverId: string, stagedId: string): Promise<AccountRow | null> {
  const { data, error } = await createAdminClient()
    .from(STAGED)
    .select(COLUMNS)
    .eq("id", stagedId)
    .eq("driver_id", driverId)
    .maybeSingle()
    .overrideTypes<AccountRow>();
  if (error) fail(error);
  return data ?? null;
}

// ---------------------------------------------------------------------------
// the rider's own routes: masked only
// ---------------------------------------------------------------------------

/** The rider's approved account as they may see it, or null. */
export async function getMaskedPayoutAccount(driverId: string): Promise<{ kind: "bank" | "upi"; masked: string } | null> {
  const row = await readLive(driverId);
  if (!row) return null;
  return { kind: row.kind, masked: maskPayoutAccount(toAccount(row)) };
}

/** A proposed account (the rider's own staged row), masked; null if it is gone. */
export async function getMaskedStagedAccount(driverId: string, stagedId: string): Promise<string | null> {
  const row = await readStaged(driverId, stagedId);
  return row ? maskPayoutAccount(toAccount(row)) : null;
}

/**
 * Hold a proposed account while its change request waits. The value has been
 * validated (`parsePayoutAccount`); the id goes into the request, the details
 * never do.
 */
export async function stagePayoutAccount(driverId: string, value: PayoutAccountInput): Promise<string> {
  const { data, error } = await createAdminClient()
    .from(STAGED)
    .insert({ driver_id: driverId, ...toRow(value) })
    .select("id")
    .single<{ id: string }>();
  if (error) fail(error);
  return data.id;
}

/** Remove a proposal whose request could not be filed. Never throws. */
export async function discardStagedPayoutAccount(driverId: string, stagedId: string): Promise<void> {
  try {
    await createAdminClient().from(STAGED).delete().eq("id", stagedId).eq("driver_id", driverId);
  } catch {
    // An orphan staged row is contained like the rest and holds nothing live.
  }
}

// ---------------------------------------------------------------------------
// the admin console: full values (callers have run requireRole("admin"))
// ---------------------------------------------------------------------------

export interface AdminPayoutView {
  /** The approved account, or null when the rider has none. */
  account: (PayoutAccount & { masked: string; updatedAt: string; updatedBy: string | null }) | null;
  /** The account waiting in a pending change request, if any. */
  pending: (PayoutAccount & { masked: string; requestId: string; requestedAt: string }) | null;
}

/**
 * ADMIN ONLY. The rider's approved account in full and, beside it, the one a
 * pending change request proposes — so a payout being recorded is checked
 * against the right account ("change pending" next to it, Review Focus 3).
 */
export async function getPayoutAccountForAdmin(driverId: string): Promise<AdminPayoutView> {
  const live = await readLive(driverId);
  const { data: req, error } = await createAdminClient()
    .from("rider_profile_change_requests")
    .select("id, new_value, created_at")
    .eq("driver_id", driverId)
    .eq("field", "payout_account")
    .eq("status", "pending")
    .maybeSingle()
    .overrideTypes<{ id: string; new_value: { stagedId?: unknown } | null; created_at: string }>();
  if (error) fail(error);
  let pending: AdminPayoutView["pending"] = null;
  const stagedId = typeof req?.new_value?.stagedId === "string" ? req.new_value.stagedId : null;
  if (req && stagedId) {
    const row = await readStaged(driverId, stagedId);
    if (row) pending = { ...toAccount(row), masked: maskPayoutAccount(toAccount(row)), requestId: req.id, requestedAt: req.created_at };
  }
  return {
    account: live
      ? { ...toAccount(live), masked: maskPayoutAccount(toAccount(live)), updatedAt: live.updated_at, updatedBy: live.updated_by }
      : null,
    pending,
  };
}

/** ADMIN ONLY. One staged proposal in full (the change-request review). */
export async function getStagedPayoutAccountForAdmin(driverId: string, stagedId: string): Promise<PayoutAccount | null> {
  const row = await readStaged(driverId, stagedId);
  return row ? toAccount(row) : null;
}

/**
 * ADMIN ONLY. Set a rider's account directly (the rider gave it to the desk).
 * `adminId` is the session admin's id, recorded as `updated_by`. A pending
 * rider proposal is left for the admin to decide on its own.
 */
export async function setPayoutAccountByAdmin(driverId: string, value: PayoutAccountInput, adminId: string): Promise<void> {
  const { error } = await createAdminClient()
    .from(LIVE)
    .upsert(
      { driver_id: driverId, ...toRow(value), updated_at: new Date().toISOString(), updated_by: adminId },
      { onConflict: "driver_id" }
    );
  if (error) fail(error);
}
