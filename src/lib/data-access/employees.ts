import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { legiblePassword } from "@/lib/utils/password";
import { toE164 } from "@/lib/auth/phone";

/**
 * Platform staff accounts, created by an operator from Settings → Team.
 *
 * A "manager" is a real, scoped `manager` profile role (migrations 0022/0023,
 * 0141): they work the delivery zones assigned to them (staff_zones), with the
 * powers switched on for them in Feature access — sensitive ones off until
 * granted. It is no longer an alias for
 * `admin`. The two UI roles map 1:1 onto real profile roles: manager → manager
 * and driver → driver. Account creation reaches for the service-role client
 * because it must create an auth user and set a privileged role past the
 * `lock_role` trigger, which RLS can't express.
 */

export type EmployeeRole = "manager" | "driver";

export const EMPLOYEE_ROLES: readonly EmployeeRole[] = ["manager", "driver"];

/** UI role → real profile role (1:1 now that `manager` is a real role). */
const TO_PROFILE_ROLE: Record<EmployeeRole, "manager" | "driver"> = {
  manager: "manager",
  driver: "driver",
};

/** Real profile role → UI role, for listing existing staff. */
function toEmployeeRole(role: string): EmployeeRole {
  return role === "manager" ? "manager" : "driver";
}

export interface EmployeeInput {
  fullName: string;
  email: string;
  phone?: string | null;
  role: EmployeeRole;
  /** Operator-chosen password; auto-generated when absent or too short. */
  password?: string | null;
}

export interface EmployeeListItem {
  id: string;
  fullName: string | null;
  phone: string | null;
  role: EmployeeRole;
  createdAt: string | null;
}

export interface CreateEmployeeResult {
  userId: string;
  /** The initial login password to hand off. */
  password: string;
}

export class EmployeeEmailTakenError extends Error {
  constructor() {
    super("email_taken");
    this.name = "EmployeeEmailTakenError";
  }
}

export class EmployeePhoneTakenError extends Error {
  constructor() {
    super("phone_taken");
    this.name = "EmployeePhoneTakenError";
  }
}

type AdminClient = ReturnType<typeof createAdminClient>;

/** Page through auth.users to find an email (one listUsers call is one page). */
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

/**
 * Create a staff login: an auth user plus a profile with the privileged role.
 * Auth + SQL aren't one transaction, so the auth user is created first and
 * deleted again if the profile write fails (leaving nothing behind).
 */
export async function createEmployee(
  input: EmployeeInput
): Promise<CreateEmployeeResult> {
  const email = input.email?.trim();
  const fullName = input.fullName?.trim();
  if (!email) throw new Error("email_required");
  if (!fullName) throw new Error("name_required");
  const profileRole = TO_PROFILE_ROLE[input.role];
  if (!profileRole) throw new Error("invalid_role");

  const admin = createAdminClient();

  // A pre-existing account isn't silently hijacked — the operator picks another
  // email (linking an existing user to a staff role is a separate concern).
  const existing = await findUserId(admin, email);
  if (existing) throw new EmployeeEmailTakenError();

  const password =
    input.password && input.password.length >= 8
      ? input.password
      : legiblePassword();

  // Store the mobile in E.164 on the profile so OTP login can resolve this staff
  // member. We deliberately do NOT set `phone` on the auth user: auth.users.phone
  // is globally unique and a number already used for a customer OTP would collide
  // and fail the whole account creation.
  const phoneToStore = input.phone
    ? toE164(input.phone) ?? (input.phone.trim() || null)
    : null;

  // profiles.phone carries a partial UNIQUE index (migration 0005). A mobile
  // already on another profile — often an existing customer — would fail the
  // upsert with a 23505 that surfaces only as a generic error. Check up front so
  // the operator gets an actionable message and we don't create+roll back a user.
  if (phoneToStore) {
    const { data: clash } = await admin
      .from("profiles")
      .select("id")
      .eq("phone", phoneToStore)
      .maybeSingle();
    if (clash) throw new EmployeePhoneTakenError();
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (createErr) throw createErr;
  const userId = created.user.id;

  try {
    // The signup trigger already inserted a `customer` profile row; upsert lifts
    // it to the staff role (service-role bypasses the lock_role trigger).
    const { error: profErr } = await admin.from("profiles").upsert(
      {
        id: userId,
        role: profileRole,
        full_name: fullName,
        phone: phoneToStore,
      },
      { onConflict: "id" }
    );
    // Belt-and-suspenders: a phone can be claimed between the check above and
    // here — map the unique violation to the same clear error.
    if (profErr) {
      if (profErr.code === "23505") throw new EmployeePhoneTakenError();
      throw profErr;
    }
    // Riders too: a manager sees the riders who share one of their zones.
    await placeInDefaultZone(admin, userId);
    return { userId, password };
  } catch (err) {
    // Roll back the auth user so a failed write leaves nothing behind.
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw err;
  }
}

/**
 * A new manager or rider starts in the default zone (migration 0141), so a
 * manager's board is not empty on day one and the rider is visible to that
 * zone's managers; the admin changes it on Team. Best effort: before 0141
 * there are no zones and nothing to do.
 */
async function placeInDefaultZone(admin: AdminClient, userId: string): Promise<void> {
  try {
    const { data } = await admin.from("delivery_zones").select("id").eq("is_default", true).maybeSingle();
    const zoneId = (data as { id: string } | null)?.id;
    if (zoneId) await admin.from("staff_zones").insert({ user_id: userId, zone_id: zoneId });
  } catch {
    // No zones table yet — the manager is assigned once 0141 is applied.
  }
}

/** Every manager and driver on the platform, newest first. (Super-admins are a
 * separate concern and are not listed as staff.) */
export async function listEmployees(): Promise<EmployeeListItem[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select("id, role, full_name, phone, created_at")
    .in("role", ["manager", "driver"])
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => {
    const row = r as {
      id: string;
      role: string;
      full_name: string | null;
      phone: string | null;
      created_at: string | null;
    };
    return {
      id: row.id,
      fullName: row.full_name,
      phone: row.phone,
      role: toEmployeeRole(row.role),
      createdAt: row.created_at,
    };
  });
}
