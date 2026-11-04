import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { legiblePassword } from "@/lib/utils/password";
import { toE164 } from "@/lib/auth/phone";
import { isMissingColumn } from "@/lib/data-access/schema-probe";
import { removedStaffIds } from "@/lib/data-access/staff-removed";
import { hideMasterAccounts } from "@/lib/developers";

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

/** Who the Team list shows. Developer accounts and the master account are not on it. */
export type TeamRole = "admin" | EmployeeRole;
const TEAM_ROLES: readonly TeamRole[] = ["admin", "manager", "driver"];

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
  role: TeamRole;
  createdAt: string | null;
  /** An admin has stopped them (profiles.account_status). False before 0151. */
  stopped: boolean;
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

/**
 * The email each person signs in with, for the Team page. It lives in Supabase Auth,
 * so it is read per person rather than by paging every customer's login. One that
 * can't be read is simply missing from the map. The caller has passed
 * requireRole("admin") (AGENTS.md rule 5). Passwords can't be read: Auth holds only
 * a hash, and we keep no copy (AGENTS.md rule 4).
 */
export async function listStaffLoginEmails(ids: string[]): Promise<Map<string, string>> {
  const admin = createAdminClient();
  const found = await Promise.all(
    ids.map(async (id): Promise<[string, string] | null> => {
      const { data, error } = await admin.auth.admin.getUserById(id);
      return error || !data.user?.email ? null : [id, data.user.email];
    })
  );
  return new Map(found.filter((f): f is [string, string] => f !== null));
}

/** Every admin, manager and driver on the platform: admins first, then newest first. */
export async function listEmployees(): Promise<EmployeeListItem[]> {
  const admin = createAdminClient();
  const read = (columns: string) =>
    admin.from("profiles").select(columns).in("role", [...TEAM_ROLES]).order("created_at", { ascending: false });
  let { data, error } = await read("id, role, full_name, phone, created_at, account_status");
  // A database without 0151 has nobody stopped, and the list must still load.
  if (error && isMissingColumn(error)) ({ data, error } = await read("id, role, full_name, phone, created_at"));
  if (error) throw error;
  const removed = await removedStaffIds();
  const rows = hideMasterAccounts((data ?? []) as unknown as { id: string; phone?: string | null }[]);
  const team = (rows.filter((r) => !removed.has(r.id)) as unknown as Record<string, unknown>[]).map((r) => {
    const row = r as {
      id: string;
      role: string;
      full_name: string | null;
      phone: string | null;
      created_at: string | null;
      account_status?: string | null;
    };
    return {
      id: row.id,
      fullName: row.full_name,
      phone: row.phone,
      role: row.role as TeamRole,
      createdAt: row.created_at,
      stopped: Boolean(row.account_status) && row.account_status !== "active",
    };
  });
  return [...team.filter((e) => e.role === "admin"), ...team.filter((e) => e.role !== "admin")];
}
