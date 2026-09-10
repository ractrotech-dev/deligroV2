"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { VendorNotPinnedError } from "@/lib/vendors/readiness";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  updateVendor,
  setVendorStatus,
  deleteVendor,
  resetVendorPassword,
  setVendorPassword,
  verifyVendorPhone,
  VENDOR_STATUSES,
  type VendorInput,
  type VendorStatus,
} from "@/lib/data-access/admin-vendors";
import {
  DEFAULT_SETTLEMENT_CYCLE,
  isSettlementCycle,
  type SettlementCycle,
} from "@/lib/settlements/cycle";
import {
  createCategory,
  updateCategory,
  setCategoryEnabled,
  deleteCategory,
  type VendorCategoryInput,
} from "@/lib/data-access/vendor-categories";
import {
  clearVendorSlot,
  moveVendorSlot,
  setVendorPosition,
  setVendorSlotOrder,
  swapVendorSlots,
  SLOT_COUNT,
} from "@/lib/data-access/vendor-positions";
import {
  isRankBasis,
  listVendorRanking,
  pickSlotOrder,
  RANKING_WINDOW_DAYS,
  type RankBasis,
} from "@/lib/data-access/admin-vendor-ranking";
import {
  saveDraft,
  deleteDraft,
  createVendorAccount,
  lookupProfileByPhone,
  attachVendorToExistingUser,
  EmailTakenError,
  PhoneTakenError,
  type VendorDraftData,
} from "@/lib/data-access/vendor-registration";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const DEMO = "Demo mode: connect Supabase and apply 0017 to manage vendors.";

/** Shared wrapper for the fire-and-refresh row actions. */
async function mutate(fn: () => Promise<unknown>): Promise<ActionResult> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  try {
    await fn();
  } catch (err) {
    // A refusal an operator can act on must survive the generic handler.
    // "That didn't go through. Try again." is true of a dropped connection and
    // useless for a missing map pin — it invites retrying the one thing that
    // will keep failing until somebody opens the map. See lib/vendors/readiness.
    if (err instanceof VendorNotPinnedError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: "That didn't go through. Try again." };
  }
  revalidatePath("/admin/vendors");
  revalidatePath("/admin/vendors/slots");
  revalidatePath("/", "layout");
  return { ok: true };
}

// ---------- form parsing (FormData → VendorInput) ----------

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}
function strOrNull(form: FormData, key: string): string | null {
  return str(form, key) || null;
}
function num(form: FormData, key: string, fallback = 0): number {
  const n = Number(form.get(key));
  return Number.isFinite(n) ? n : fallback;
}
function bool(form: FormData, key: string): boolean {
  return form.get(key) === "on";
}

function parseVendor(form: FormData): VendorInput {
  const weeklyOff = form
    .getAll("weeklyOff")
    .filter((v): v is string => typeof v === "string");
  return {
    name: str(form, "name"),
    category: strOrNull(form, "category"),
    ownerName: strOrNull(form, "ownerName"),
    ownerMobile: strOrNull(form, "ownerMobile"),
    ownerAltMobile: strOrNull(form, "ownerAltMobile"),
    ownerEmail: strOrNull(form, "ownerEmail"),
    tagline: strOrNull(form, "tagline"),
    description: strOrNull(form, "description"),
    // Blank = inherit the platform rate (stored as NULL, migration 0032). An
    // explicit 0 is a different statement — "this vendor pays nothing" — so it
    // must survive as 0 rather than collapse back to inherit.
    commissionPct: commissionOverride(form),
    minOrder: Math.max(0, Math.trunc(num(form, "minOrder"))),
    deliveryAvailable: bool(form, "deliveryAvailable"),
    selfPickup: bool(form, "selfPickup"),
    openingTime: strOrNull(form, "openingTime"),
    closingTime: strOrNull(form, "closingTime"),
    weeklyOff,
    address: strOrNull(form, "address"),
    landmark: strOrNull(form, "landmark"),
    pincode: strOrNull(form, "pincode"),
    upiId: strOrNull(form, "upiId"),
    bankAccountName: strOrNull(form, "bankAccountName"),
    bankAccountNumber: strOrNull(form, "bankAccountNumber"),
    bankIfsc: strOrNull(form, "bankIfsc"),
    bankName: strOrNull(form, "bankName"),
    fssaiNumber: strOrNull(form, "fssaiNumber"),
    gstNumber: strOrNull(form, "gstNumber"),
    panNumber: strOrNull(form, "panNumber"),
    // Payment rules & payout terms (0034). Toggles arrive as "on"/absent, so an
    // unchecked box reads as false — which is the whole point of the control.
    acceptCod: bool(form, "acceptCod"),
    acceptOnline: bool(form, "acceptOnline"),
    codMaxOrder: Math.max(0, Math.trunc(num(form, "codMaxOrder"))),
    otherChargesPerOrder: Math.max(
      0,
      Math.trunc(num(form, "otherChargesPerOrder"))
    ),
    settlementCycle: isSettlementCycle(form.get("settlementCycle"))
      ? (form.get("settlementCycle") as SettlementCycle)
      : DEFAULT_SETTLEMENT_CYCLE,
  };
}

/**
 * An empty commission field means "no override" and stores NULL. Anything else
 * is clamped to the column's 0–100 CHECK.
 */
function commissionOverride(form: FormData): number | null {
  const raw = form.get("commissionPct");
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

function validateVendor(input: VendorInput): string | null {
  if (!input.name) return "Shop name is required.";
  if (
    input.commissionPct !== null &&
    (input.commissionPct < 0 || input.commissionPct > 100)
  )
    return "Commission must be between 0 and 100%.";
  // Mandatory, not optional. The vendor's login is an email/password account in
  // Supabase Auth — mobile + password sign-in resolves the owner's profile and
  // then signs in with this address. A shop saved without one cannot be issued
  // a password at all, which is a support call nobody can resolve.
  if (!input.ownerEmail)
    return "An email address is required — the vendor's login is issued against it.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.ownerEmail))
    return "That email address doesn't look right.";
  // A shop with both methods off cannot take a single order. Refuse the save
  // rather than let the operator discover it from a customer complaint.
  if (!input.acceptCod && !input.acceptOnline)
    return "Turn on at least one payment method — cash on delivery or online payment.";
  // A cash limit with cash switched off is a setting that does nothing. Saying
  // so is cheaper than letting someone believe the limit is in force.
  if (input.codMaxOrder > 0 && !input.acceptCod)
    return "The cash limit only applies when cash on delivery is on. Turn it on, or clear the limit.";
  return null;
}

// ---------- vendor edit ----------

/** Edit a vendor's business fields. `id` is bound by the form. */
export async function saveVendorAction(
  id: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  if (!id) return { ok: false, error: "Missing vendor id." };

  const input = parseVendor(form);
  const problem = validateVendor(input);
  if (problem) return { ok: false, error: problem };

  try {
    await updateVendor(id, input);
  } catch {
    return { ok: false, error: "Couldn't save the vendor. Try again." };
  }

  revalidatePath("/admin/vendors");
  revalidatePath(`/admin/vendors/${id}`);
  revalidatePath("/", "layout");
  redirect(`/admin/vendors/${id}`);
}

// ---------- row actions ----------

export async function setVendorStatusAction(id: string, status: VendorStatus) {
  if (!VENDOR_STATUSES.includes(status)) {
    return { ok: false, error: "Unknown status." };
  }
  return mutate(() => setVendorStatus(id, status));
}

/**
 * Decline a signup from the approval queue.
 *
 * Suspends rather than deletes. A rejection is a judgement that can be wrong —
 * a licence arrives the next day, an operator hits the wrong card — and a
 * suspended shop is one Approve away from live, with its documents and owner
 * login intact. Erasing a signup is the separate, twice-confirmed delete on the
 * catalogue card, where the order-history guard lives.
 *
 * Suspending also takes the shop out of `status = 'pending'`, which is what the
 * queue, the nav badge and the dashboard list all count — so the decision
 * actually clears the work item instead of leaving it there for ever.
 */
export async function rejectVendorAction(id: string): Promise<ActionResult> {
  return mutate(() => setVendorStatus(id, "suspended"));
}

/** Reject anything the 0021 CHECK would: a slot is an integer 1–SLOT_COUNT. */
function validSlot(position: number): boolean {
  return Number.isInteger(position) && position >= 1 && position <= SLOT_COUNT;
}

/** Pin a vendor to a customer-feed slot 1–10, or null to unrank it. */
export async function setVendorPositionAction(
  id: string,
  position: number | null
): Promise<ActionResult> {
  if (position != null && !validSlot(position)) {
    return { ok: false, error: `Position must be between 1 and ${SLOT_COUNT}.` };
  }
  return mutate(() => setVendorPosition(id, position));
}

/**
 * Slots board: put a vendor in a slot, or pass null to empty it. Assigning
 * evicts the slot's current occupant (setVendorPosition enforces that), and
 * moves the vendor out of any other slot it held — one shop, one rank.
 */
export async function assignVendorSlotAction(
  position: number,
  vendorId: string | null
): Promise<ActionResult> {
  if (!validSlot(position)) {
    return { ok: false, error: `Position must be between 1 and ${SLOT_COUNT}.` };
  }
  return mutate(() =>
    vendorId ? setVendorPosition(vendorId, position) : clearVendorSlot(position)
  );
}

/** Slots board: exchange two slots' occupants — the move up/down control. */
export async function swapVendorSlotsAction(
  a: number,
  b: number
): Promise<ActionResult> {
  if (!validSlot(a) || !validSlot(b)) {
    return { ok: false, error: `Position must be between 1 and ${SLOT_COUNT}.` };
  }
  return mutate(() => swapVendorSlots(a, b));
}

/**
 * Slots board: drag row `from` and drop it on row `to`.
 *
 * A move, not a swap — see moveVendorSlot. The arrows keep using
 * swapVendorSlotsAction because an adjacent swap and an adjacent move are the
 * same operation, and the arrows are also the keyboard path to it.
 */
export async function moveVendorSlotAction(
  from: number,
  to: number
): Promise<ActionResult> {
  if (!validSlot(from) || !validSlot(to)) {
    return { ok: false, error: `Position must be between 1 and ${SLOT_COUNT}.` };
  }
  if (from === to) return { ok: true };
  return mutate(() => moveVendorSlot(from, to));
}

export interface AutoFillActionResult extends ActionResult {
  /** How many slots ended up filled. */
  filled?: number;
  /** How many slots the board holds, so the caller can phrase "6 of 10". */
  slots?: number;
}

/**
 * Slots board: rank the catalogue and pin the top shops to slots 1…N.
 *
 * Destructive by design — it clears the board first, so the result is exactly
 * the requested ranking rather than a merge into whatever an operator had
 * arranged by hand. The UI confirms before calling it.
 *
 * Fills fewer than SLOT_COUNT when fewer shops qualify (no sales in the window,
 * or too few ratings to rank honestly), and returns the count so the UI can say
 * so instead of implying a full board.
 */
export async function autoFillVendorSlotsAction(
  basis: RankBasis
): Promise<AutoFillActionResult> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  if (!isRankBasis(basis)) {
    return { ok: false, error: "Unknown ranking basis." };
  }

  let filled = 0;
  try {
    const ranking = await listVendorRanking();
    const picks = pickSlotOrder(ranking, basis);
    if (picks.length === 0) {
      return {
        ok: false,
        error:
          basis === "sales"
            ? `No approved shop has a delivered order in the last ${RANKING_WINDOW_DAYS} days, so there is nothing to rank by sales.`
            : "No approved shop has enough ratings to be ranked yet.",
      };
    }
    filled = await setVendorSlotOrder(picks.map((v) => v.id));
  } catch {
    return { ok: false, error: "That didn't go through. Try again." };
  }

  revalidatePath("/admin/vendors");
  revalidatePath("/admin/vendors/slots");
  revalidatePath("/", "layout");
  return { ok: true, filled, slots: SLOT_COUNT };
}

export interface DeleteVendorActionResult extends ActionResult {
  softDeleted?: boolean;
}

export async function deleteVendorAction(
  id: string
): Promise<DeleteVendorActionResult> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  try {
    const { softDeleted } = await deleteVendor(id);
    revalidatePath("/admin/vendors");
    revalidatePath("/", "layout");
    return { ok: true, softDeleted };
  } catch {
    return { ok: false, error: "Couldn't delete this vendor. Try again." };
  }
}

export interface ResetPasswordActionResult extends ActionResult {
  tempPassword?: string;
}

export async function resetVendorPasswordAction(
  id: string
): Promise<ResetPasswordActionResult> {
  const profile = await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  try {
    const { tempPassword } = await resetVendorPassword(id, profile.id);
    revalidatePath("/admin/vendors");
    revalidatePath(`/admin/vendors/${id}/edit`);
    revalidatePath(`/admin/vendors/${id}`);
    return { ok: true, tempPassword };
  } catch {
    return {
      ok: false,
      error: "Couldn't reset the password. Check the vendor has a login account.",
    };
  }
}

/** Shortest password an operator may type. Supabase Auth's own floor is 6. */
const MIN_PASSWORD = 8;

/**
 * Set a vendor's password to a value the operator chose, rather than a
 * generated one — for the owner who wants something they can remember. Stored
 * and shown exactly like a generated one.
 */
export async function setVendorPasswordAction(
  id: string,
  password: string
): Promise<ActionResult> {
  const profile = await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const value = password.trim();
  if (value.length < MIN_PASSWORD) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD} characters.`,
    };
  }
  if (/\s/.test(value)) {
    return { ok: false, error: "Password can't contain spaces." };
  }

  try {
    await setVendorPassword(id, value, profile.id);
  } catch {
    return {
      ok: false,
      error: "Couldn't set the password. Check the vendor has a login account.",
    };
  }

  revalidatePath("/admin/vendors");
  revalidatePath(`/admin/vendors/${id}/edit`);
  revalidatePath(`/admin/vendors/${id}`);
  return { ok: true };
}

/**
 * Confirm a vendor's mobile with an OTP code from the Edit screen. Returns the
 * raw error code so the shared OTP widget can map it to a message. On success the
 * phone is stored in E.164 and marked verified.
 */
export async function verifyVendorPhoneAction(
  id: string,
  phone: string,
  code: string
): Promise<{ ok: boolean; error?: string }> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: "backend_not_configured" };
  try {
    const res = await verifyVendorPhone(id, phone, code);
    if (res.ok) {
      revalidatePath(`/admin/vendors/${id}/edit`);
      revalidatePath(`/admin/vendors/${id}`);
    }
    return res;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

// ---------- categories ----------

function parseCategory(form: FormData): VendorCategoryInput {
  return {
    name: str(form, "name"),
    description: strOrNull(form, "description"),
    sortOrder: Math.trunc(num(form, "sortOrder")),
    enabled: bool(form, "enabled"),
  };
}

/** Create (empty id) or edit a vendor category. */
export async function saveCategoryAction(
  id: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const input = parseCategory(form);
  if (!input.name) return { ok: false, error: "Category name is required." };

  try {
    if (id) await updateCategory(id, input);
    else await createCategory(input);
  } catch (err) {
    // uniqueSlug already de-dupes the slug, so a 23505 here is the unique NAME
    // constraint (vendor_categories_name_key) — a definite duplicate, not a guess.
    if ((err as { code?: string })?.code === "23505") {
      return { ok: false, error: `A category named “${input.name}” already exists.` };
    }
    return { ok: false, error: "Couldn't save the category. Try again." };
  }

  revalidatePath("/admin/vendors/categories");
  revalidatePath("/admin/vendors");
  revalidatePath("/", "layout");
  redirect("/admin/vendors/categories");
}

export async function setCategoryEnabledAction(id: string, enabled: boolean) {
  return mutate(() => setCategoryEnabled(id, enabled));
}

export async function deleteCategoryAction(id: string) {
  return mutate(() => deleteCategory(id));
}

/**
 * Add a category from inside the registration wizard, without leaving it.
 * Returns the created name so the wizard can select it immediately.
 */
export async function createCategoryInlineAction(
  name: string
): Promise<{ ok: boolean; name?: string; error?: string }> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Category name is required." };
  try {
    await createCategory({
      name: clean,
      description: null,
      sortOrder: 100,
      enabled: true,
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      return { ok: false, error: `A category named “${clean}” already exists.` };
    }
    return { ok: false, error: "Couldn't add the category. Try again." };
  }
  revalidatePath("/admin/vendors");
  revalidatePath("/admin/vendors/categories");
  return { ok: true, name: clean };
}

// ---------- registration wizard ----------

export interface SaveDraftResult extends ActionResult {
  id?: string;
}

/** Persist wizard progress (password stripped in the data layer). */
export async function saveDraftAction(
  id: string | null,
  data: VendorDraftData,
  step: number
): Promise<SaveDraftResult> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  try {
    const draftId = await saveDraft(id, data, step);
    return { ok: true, id: draftId };
  } catch {
    return { ok: false, error: "Couldn't save the draft." };
  }
}

export async function deleteDraftAction(id: string): Promise<ActionResult> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  try {
    await deleteDraft(id);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't discard the draft." };
  }
}

function validateFullDraft(d: VendorDraftData): string | null {
  if (!d.shopName?.trim()) return "Shop name is required.";
  if (!d.ownerName?.trim()) return "Owner name is required.";
  if (!d.mobile?.trim()) return "Mobile number is required.";
  if (!d.email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email))
    return "A valid email address is required.";
  if (d.password && d.password.length < 8)
    return "Password must be at least 8 characters.";
  if (!d.category?.trim()) return "Select a vendor category.";
  if (!d.address?.trim()) return "Shop address is required.";
  const hasUpi = Boolean(d.upiId?.trim());
  const hasBank = Boolean(d.bankAccountNumber?.trim() && d.bankIfsc?.trim());
  if (!hasUpi && !hasBank)
    return "Add a UPI ID or bank account (number + IFSC) for payouts.";
  if (!d.tcAccepted) return "Accept the terms & conditions to continue.";
  return null;
}

export interface CreateVendorActionResult extends ActionResult {
  vendorId?: string;
  password?: string;
  /**
   * Set (with ok:false) when the mobile already belongs to a customer. The wizard
   * prompts "also make them a vendor?" and, on Yes, calls convertCustomerToVendorAction.
   */
  existingCustomer?: { id: string; name: string };
  /** True when the shop was attached to an existing account (no new password). */
  existing?: boolean;
}

/**
 * Final wizard step: create the real vendor account. Re-gated with
 * requireRole("admin"); the operator's id is the T&C acceptor on the record.
 */
export async function createVendorAccountAction(
  data: VendorDraftData,
  draftId?: string
): Promise<CreateVendorActionResult> {
  const profile = await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const problem = validateFullDraft(data);
  if (problem) return { ok: false, error: problem };

  // If this mobile is already registered, decide how to proceed instead of
  // failing on the unique-phone constraint:
  //   - a customer  → offer conversion (the wizard shows a Yes/No popup)
  //   - an operator → hard stop (can't re-home a vendor/driver/admin number)
  if (data.mobile?.trim()) {
    const owner = await lookupProfileByPhone(data.mobile);
    if (owner && owner.role === "customer") {
      return {
        ok: false,
        existingCustomer: { id: owner.id, name: owner.fullName ?? "this customer" },
      };
    }
    if (owner) {
      return {
        ok: false,
        error:
          "This mobile number is already registered to another operator account. Use a different number.",
      };
    }
  }

  try {
    const { restaurantId, password } = await createVendorAccount(data, profile.id);
    if (draftId) await deleteDraft(draftId).catch(() => {});
    revalidatePath("/admin/vendors");
    revalidatePath("/", "layout");
    return { ok: true, vendorId: restaurantId, password };
  } catch (err) {
    if (err instanceof EmailTakenError) {
      return {
        ok: false,
        error: "An account with this email already exists. Use a different email.",
      };
    }
    if (err instanceof PhoneTakenError) {
      return {
        ok: false,
        error:
          "This mobile number is already registered (often the owner's own customer account). Use a different number, or convert that existing account to a vendor.",
      };
    }
    // Surface the real cause server-side; the generic message stays in the UI.
    console.error("[createVendorAccount] failed:", err);
    // Belt-and-suspenders: a unique violation that slipped past the pre-checks
    // (e.g. a phone claimed between check and insert) still reads clearly.
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      return {
        ok: false,
        error:
          "That mobile or email is already used by another account. Use a different one.",
      };
    }
    return { ok: false, error: "Couldn't create the vendor. Try again." };
  }
}

/**
 * "Stay both": the operator confirmed that the mobile's existing CUSTOMER should
 * also become a vendor. Attach a shop to their existing account — no new login,
 * their role stays `customer` so they keep shopping, and vendor access comes from
 * owning the shop. Only reachable from the admin wizard's confirm popup.
 */
export async function convertCustomerToVendorAction(
  data: VendorDraftData,
  customerId: string,
  draftId?: string
): Promise<CreateVendorActionResult> {
  const profile = await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const problem = validateFullDraft(data);
  if (problem) return { ok: false, error: problem };

  try {
    const { restaurantId } = await attachVendorToExistingUser(
      customerId,
      data,
      profile.id
    );
    if (draftId) await deleteDraft(draftId).catch(() => {});
    revalidatePath("/admin/vendors");
    revalidatePath("/", "layout");
    return { ok: true, vendorId: restaurantId, existing: true };
  } catch (err) {
    console.error("[convertCustomerToVendor] failed:", err);
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      return {
        ok: false,
        error: "That shop name conflicts with an existing one. Try a different name.",
      };
    }
    return { ok: false, error: "Couldn't add the vendor to that account. Try again." };
  }
}
