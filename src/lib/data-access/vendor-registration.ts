import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { slugify } from "@/lib/data-access/vendor-categories";
import { legiblePassword } from "@/lib/utils/password";
import { toE164 } from "@/lib/auth/phone";
import { storeVendorCredential } from "@/lib/data-access/vendor-credentials";
import type { Role } from "@/lib/auth";

/**
 * The vendor registration wizard's backend (migration 0018). Drafts are stored
 * as JSON and read/written through the admin-gated `is_admin()` RLS via the
 * cookie-bound client. The final account creation reaches for the service-role
 * client — it must create an auth user and set role='restaurant' past the
 * `lock_role` trigger, which RLS cannot express.
 */

export interface DraftMenuItem {
  name: string;
  category?: string | null;
  description?: string | null;
  price: number;
  veg: boolean;
  available: boolean;
}

/** The whole wizard form, as persisted (minus the password, which is stripped). */
export interface VendorDraftData {
  shopName?: string;
  ownerName?: string;
  mobile?: string;
  altMobile?: string;
  email?: string;
  /** Only present in-flight from the client; never saved to a draft. */
  password?: string;
  logoUrl?: string;
  coverUrl?: string;
  category?: string;
  description?: string;
  openingTime?: string;
  closingTime?: string;
  weeklyOff?: string[];
  deliveryAvailable?: boolean;
  selfPickup?: boolean;
  minOrder?: number;
  address?: string;
  landmark?: string;
  pincode?: string;
  lat?: number | null;
  lng?: number | null;
  upiId?: string;
  bankAccountName?: string;
  bankName?: string;
  bankAccountNumber?: string;
  bankIfsc?: string;
  commissionPct?: number;
  fssaiNumber?: string;
  gstNumber?: string;
  panNumber?: string;
  menuItems?: DraftMenuItem[];
  tcAccepted?: boolean;
  tcVersion?: string;
  /** Set once the owner's mobile has been OTP-verified in the wizard (non-blocking). */
  phoneVerified?: boolean;
}

export interface RegistrationDraft {
  id: string;
  data: VendorDraftData;
  step: number;
  updatedAt: string;
}

export interface DraftSummary {
  id: string;
  shopName: string;
  step: number;
  updatedAt: string;
}

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

/** Passwords never touch the draft — strip them before persisting. */
function stripSecrets(data: VendorDraftData): VendorDraftData {
  const clone = { ...data };
  delete clone.password;
  return clone;
}

/** Create (id null) or update a draft; returns the draft id for resume. */
export async function saveDraft(
  id: string | null,
  data: VendorDraftData,
  step: number
): Promise<string> {
  const supabase = await createClient();
  const payload = stripSecrets(data);

  if (id) {
    const { error } = await supabase
      .from("vendor_registration_drafts")
      .update({ data: payload, step, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
    return id;
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("unauthorized");

  const { data: row, error } = await supabase
    .from("vendor_registration_drafts")
    .insert({ created_by: user.id, data: payload, step })
    .select("id")
    .single();
  if (error) throw error;
  return row.id as string;
}

export async function loadDraft(id: string): Promise<RegistrationDraft | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vendor_registration_drafts")
    .select("id, data, step, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  if (!data) return null;
  const row = data as {
    id: string;
    data: VendorDraftData;
    step: number;
    updated_at: string;
  };
  return {
    id: row.id,
    data: row.data ?? {},
    step: row.step ?? 0,
    updatedAt: row.updated_at,
  };
}

export async function listDrafts(): Promise<DraftSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vendor_registration_drafts")
    .select("id, data, step, updated_at")
    .order("updated_at", { ascending: false })
    .limit(20);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (data ?? []).map((r) => {
    const row = r as {
      id: string;
      data: VendorDraftData;
      step: number;
      updated_at: string;
    };
    return {
      id: row.id,
      shopName: row.data?.shopName?.trim() || "Untitled vendor",
      step: row.step ?? 0,
      updatedAt: row.updated_at,
    };
  });
}

export async function deleteDraft(id: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("vendor_registration_drafts")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

// ---------- account creation (service-role) ----------

type AdminClient = ReturnType<typeof createAdminClient>;

/** Page through auth.users to find an email (a single listUsers call is one page). */
async function findUserId(
  admin: AdminClient,
  email: string
): Promise<string | undefined> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < 1000) break;
  }
  return undefined;
}

/** A restaurant slug that isn't taken, suffixing -2, -3, … on collision. */
async function uniqueRestaurantSlug(
  admin: AdminClient,
  base: string
): Promise<string> {
  const root = base || "shop";
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? root : `${root}-${n}`;
    const { data } = await admin
      .from("restaurants")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (!data) return candidate;
  }
  return `${root}-${Date.now()}`;
}

function newPassword(): string {
  return legiblePassword();
}

export class EmailTakenError extends Error {
  constructor() {
    super("email_taken");
    this.name = "EmailTakenError";
  }
}

export class PhoneTakenError extends Error {
  constructor() {
    super("phone_taken");
    this.name = "PhoneTakenError";
  }
}

export interface CreateVendorResult {
  restaurantId: string;
  slug: string;
  ownerId: string;
  /** The initial login password to hand off (chosen by the operator or generated). */
  password: string;
}

/** Who is onboarding, and into which zone (null = the default zone; admins only). */
export interface OnboardingOptions {
  zoneId?: string | null;
  /** Idempotency key for the audit row; a fresh one when omitted. */
  clientActionId?: string;
}

/**
 * Insert the restaurant row (status='pending') and any seed menu for `ownerId`,
 * from a completed draft, through `ops_onboard_vendor` (migration 0145): the
 * shop, its menu and the audit row are one transaction, the actor's zone is
 * checked in the database, and money terms and bank details are honoured only
 * when the actor is an admin. Shared by both onboarding paths — a brand-new
 * vendor account, and a shop attached to an existing customer's account — and
 * by the Manager app. The caller owns the profile/role decision.
 */
async function insertVendorRestaurant(
  admin: AdminClient,
  ownerId: string,
  data: VendorDraftData,
  operatorId: string,
  opts: OnboardingOptions = {}
): Promise<{ restaurantId: string; slug: string }> {
  const email = data.email?.trim() ?? null;
  const mobileE164 = data.mobile ? toE164(data.mobile) : null;

  const slug = await uniqueRestaurantSlug(admin, slugify(data.shopName ?? ""));
  const shop = {
    slug,
    name: (data.shopName ?? "").trim(),
    description: data.description ?? null,
    category: data.category ?? null,
    image_url: data.logoUrl ?? null,
    owner_name: data.ownerName ?? null,
    owner_mobile: mobileE164 ?? data.mobile ?? null,
    owner_alt_mobile: data.altMobile ?? null,
    owner_email: email,
    owner_phone_verified: Boolean(mobileE164 && data.phoneVerified),
    // A password was issued at creation. The value itself goes to the
    // service-role-only `vendor_login_credentials` table (0039), never onto
    // this publicly-readable row — that was audit finding C-2.
    password_issued: true,
    // Left unset, a new vendor inherits the platform rate (NULL, migration
    // 0032). The old `?? 0` would register every new shop as an explicit 0%
    // override. Honoured for an admin actor only (0145).
    commission_pct:
      data.commissionPct === undefined || data.commissionPct === null
        ? null
        : Math.min(100, Math.max(0, data.commissionPct)),
    min_order: Math.max(0, Math.trunc(data.minOrder ?? 0)),
    delivery_available: data.deliveryAvailable ?? true,
    self_pickup: data.selfPickup ?? false,
    opening_time: data.openingTime || null,
    closing_time: data.closingTime || null,
    weekly_off: data.weeklyOff ?? [],
    address: data.address ?? null,
    landmark: data.landmark ?? null,
    pincode: data.pincode ?? null,
    lat: data.lat ?? null,
    lng: data.lng ?? null,
    upi_id: data.upiId ?? null,
    bank_account_name: data.bankAccountName ?? null,
    bank_name: data.bankName ?? null,
    bank_account_number: data.bankAccountNumber ?? null,
    bank_ifsc: data.bankIfsc ?? null,
    fssai_number: data.fssaiNumber ?? null,
    gst_number: data.gstNumber ?? null,
    pan_number: data.panNumber ?? null,
    tc_version: data.tcVersion ?? null,
  };
  const menu = (data.menuItems ?? [])
    .filter((m) => m.name?.trim())
    .map((m) => ({
      name: m.name.trim(),
      description: m.description ?? null,
      price: Math.max(0, Math.trunc(m.price ?? 0)),
      veg: m.veg ?? true,
      available: m.available ?? true,
      category: m.category ?? null,
    }));

  const { data: result, error } = await admin.rpc("ops_onboard_vendor", {
    p_actor: operatorId,
    p_owner: ownerId,
    p_zone: opts.zoneId ?? null,
    p_shop: shop,
    p_menu: menu,
    p_client_action_id: opts.clientActionId ?? randomUUID(),
  });
  if (error) throw error;
  const r = result as { restaurant_id: string; slug: string };
  return { restaurantId: r.restaurant_id, slug: r.slug };
}

export interface PhoneOwner {
  id: string;
  role: Role;
  fullName: string | null;
}

/**
 * Who, if anyone, already owns this mobile number (in E.164). Used by the vendor
 * wizard to offer "this number is a customer — also make them a vendor?" instead
 * of failing on the unique-phone constraint. Service-role: it must see profiles
 * other than the caller's.
 */
export async function lookupProfileByPhone(
  phone: string
): Promise<PhoneOwner | null> {
  const e164 = toE164(phone) ?? phone.trim();
  if (!e164) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id, role, full_name")
    .eq("phone", e164)
    .maybeSingle();
  if (!data) return null;
  const row = data as { id: string; role: Role; full_name: string | null };
  return { id: row.id, role: row.role, fullName: row.full_name };
}

/**
 * Attach a shop to an EXISTING customer's account (the "stay both" path). Their
 * profile is left as `customer` on purpose — order-insert RLS requires that role,
 * so they keep the ability to shop — and vendor access is granted by restaurant
 * ownership. No auth user is created (they already have one and sign in with
 * their existing number via OTP), so there is no phone-uniqueness collision.
 */
export async function attachVendorToExistingUser(
  customerId: string,
  data: VendorDraftData,
  operatorId: string,
  opts: OnboardingOptions = {}
): Promise<{ restaurantId: string }> {
  const admin = createAdminClient();

  // Defensive: only ever attach onto a real customer profile.
  const { data: prof } = await admin
    .from("profiles")
    .select("id, role")
    .eq("id", customerId)
    .maybeSingle();
  if (!prof) throw new Error("customer_not_found");
  if ((prof as { role: Role }).role !== "customer") {
    throw new Error("not_a_customer");
  }

  const { restaurantId } = await insertVendorRestaurant(
    admin,
    customerId,
    data,
    operatorId,
    opts
  );
  return { restaurantId };
}

/**
 * Turn a completed draft into a live vendor: an auth user (role='restaurant'),
 * its restaurant row (status='pending'), and any menu items. Auth + SQL aren't
 * one transaction, so the auth user is created first and deleted again if the
 * restaurant insert fails.
 */
export async function createVendorAccount(
  data: VendorDraftData,
  operatorId: string,
  opts: OnboardingOptions = {}
): Promise<CreateVendorResult> {
  const email = data.email?.trim();
  if (!email) throw new Error("email_required");
  if (!data.shopName?.trim()) throw new Error("shop_name_required");

  const admin = createAdminClient();

  // A pre-existing account isn't silently hijacked — the operator picks another
  // email. (Linking an existing customer to a vendor role is a separate flow.)
  const existing = await findUserId(admin, email);
  if (existing) throw new EmailTakenError();

  const password =
    data.password && data.password.length >= 8 ? data.password : newPassword();

  // Store the mobile in E.164 so OTP login resolves this owner (the OTP flow
  // looks the phone up in E.164; a raw 10-digit value would never match and the
  // vendor would land in a blank customer account instead of their portal).
  const mobileE164 = data.mobile ? toE164(data.mobile) : null;

  // profiles.phone is globally unique (migration 0005). The owner is very often
  // already a *customer* (they ordered before we onboarded their shop), and a
  // second profile row with their number fails the upsert below with a 23505
  // that surfaces only as the generic "couldn't create" error. Check up front so
  // the operator gets an actionable message and we don't create-then-delete an
  // auth user. `phoneVerified` is irrelevant here — uniqueness is absolute.
  const ownerPhone = mobileE164 ?? data.mobile?.trim() ?? null;
  if (ownerPhone) {
    const { data: phoneClash } = await admin
      .from("profiles")
      .select("id")
      .eq("phone", ownerPhone)
      .maybeSingle();
    if (phoneClash) throw new PhoneTakenError();
  }

  // Note: we deliberately do NOT set `phone` on the auth user. OTP login resolves
  // a vendor by `profiles.phone` (set below), and auth.users.phone is globally
  // unique — a mobile previously used for a customer OTP would collide here and
  // fail the whole account creation.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: data.ownerName ?? data.shopName },
  });
  if (createErr) throw createErr;
  const ownerId = created.user.id;

  try {
    const { error: profErr } = await admin.from("profiles").upsert(
      {
        id: ownerId,
        role: "restaurant",
        full_name: data.ownerName ?? data.shopName ?? null,
        phone: mobileE164 ?? data.mobile ?? null,
      },
      { onConflict: "id" }
    );
    if (profErr) throw profErr;

    const { restaurantId, slug } = await insertVendorRestaurant(
      admin,
      ownerId,
      data,
      operatorId,
      opts
    );

    // Keep an admin-readable copy so the desk can read the login back to the
    // owner later. Best-effort: the account already exists and the wizard shows
    // the value once regardless.
    await storeVendorCredential(restaurantId, ownerId, password, operatorId);

    return { restaurantId, ownerId, password, slug };
  } catch (err) {
    // Roll back the auth user we just created so a failed insert leaves nothing.
    await admin.auth.admin.deleteUser(ownerId).catch(() => {});
    throw err;
  }
}
