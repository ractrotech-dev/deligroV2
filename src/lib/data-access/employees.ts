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
 * The login half of a new staff account: an auth user with a confirmed email
 * and a password, and nothing else — the role, zone and profile are the
 * caller's (an RPC for riders, so the change and its audit row are one step).
 * The signup trigger gives the user a `customer` profile row meanwhile.
 *
 * Refuses an email that already has an account and a mobile already on another
 * profile (profiles.phone is unique, 0005). We deliberately do NOT set `phone`
 * on the auth user: auth.users.phone is globally unique and a number already
 * used for a customer OTP would fail the whole creation; OTP and mobile+password
 * sign-in resolve staff by `profiles.phone`.
 */
export async function createStaffLogin(input: {
  email: string;
  fullName: string;
  /** E.164, or null. */
  phone: string | null;
  password?: string | null;
}): Promise<{ userId: string; password: string }> {
  const admin = createAdminClient();
  const existing = await findUserId(admin, input.email);
  if (existing) throw new EmployeeEmailTakenError();
  if (input.phone) {
    const { data: clash } = await admin.from("profiles").select("id").eq("phone", input.phone).maybeSingle();
    if (clash) throw new EmployeePhoneTakenError();
  }
  const password = input.password && input.password.length >= 8 ? input.password : legiblePassword();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: input.email,
    password,
    email_confirm: true,
    user_metadata: { full_name: input.fullName },
  });
  if (createErr) throw createErr;
  return { userId: created.user.id, password };
}

/** Undo createStaffLogin when the rest of the account could not be written. */
export async function deleteStaffLogin(userId: string): Promise<void> {
  await createAdminClient().auth.admin.deleteUser(userId).catch(() => {});
}

/** The RPC is not on this database yet (0151 not applied). */
function rpcMissing(error: { code?: string } | null): boolean {
  return !!error && (error.code === "PGRST202" || error.code === "42883");
}

/**
 * Create a staff login: an auth user plus a profile with the privileged role.
 * Auth + SQL aren't one transaction, so the auth user is created first and
 * deleted again if the profile write fails (leaving nothing behind).
 *
 * A rider is made one through `ops_onboard_rider` (0151) with the admin as the
 * actor — the same audited step a manager's onboarding takes — into the default
 * zone; before 0151 is applied, the direct write below is the fallback.
 */
export async function createEmployee(
  input: EmployeeInput,
  actorId?: string
): Promise<CreateEmployeeResult> {
  const email = input.email?.trim();
  const fullName = input.fullName?.trim();
  if (!email) throw new Error("email_required");
  if (!fullName) throw new Error("name_required");
  const profileRole = TO_PROFILE_ROLE[input.role];
  if (!profileRole) throw new Error("invalid_role");

  // Store the mobile in E.164 on the profile so OTP login can resolve this staff member.
  const phoneToStore = input.phone ? toE164(input.phone) ?? (input.phone.trim() || null) : null;
  const { userId, password } = await createStaffLogin({ email, fullName, phone: phoneToStore, password: input.password });
  const admin = createAdminClient();

  try {
    if (profileRole === "driver" && actorId) {
      const { data: zone } = await admin.from("delivery_zones").select("id").eq("is_default", true).maybeSingle();
      const zoneId = (zone as { id: string } | null)?.id;
      if (zoneId) {
        const { error } = await admin.rpc("ops_onboard_rider", {
          p_actor: actorId,
          p_user: userId,
          p_zone: zoneId,
          p_profile: { fullName, phone: phoneToStore },
          p_client_action_id: null,
        });
        if (!error) return { userId, password };
        if ((error as { code?: string }).code === "23505") throw new EmployeePhoneTakenError();
        if (!rpcMissing(error)) throw error;
      }
    }
    // The signup trigger already inserted a `customer` profile row; upsert lifts
    // it to the staff role (service-role bypasses the lock_role trigger).
    const { error: profErr } = await admin.from("profiles").upsert(
      { id: userId, role: profileRole, full_name: fullName, phone: phoneToStore },
      { onConflict: "id" }
    );
    // A phone can be claimed between the check and here — same clear error.
    if (profErr) {
      if (profErr.code === "23505") throw new EmployeePhoneTakenError();
      throw profErr;
    }
    // Riders too: a manager sees the riders who share one of their zones.
    await placeInDefaultZone(admin, userId);
    return { userId, password };
  } catch (err) {
    await deleteStaffLogin(userId);
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
