"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { rateLimit } from "@/lib/rate-limit";
import { captureError } from "@/lib/obs/emit";
import { staffAccessMessage, type StaffDecision } from "@/lib/auth/staff-access";
import { resetStaffPassword, setStaffAccess } from "@/lib/data-access/staff-access";
import { isUuid } from "@/lib/auth/manager-scope";
import type { Profile } from "@/lib/auth";
import {
  createEmployee,
  EmployeeEmailTakenError,
  EmployeePhoneTakenError,
  EMPLOYEE_ROLES,
  type EmployeeInput,
} from "@/lib/data-access/employees";

export interface CreateEmployeeActionResult {
  ok: boolean;
  error?: string;
  /** The initial login password to hand off, on success. */
  password?: string;
}

const DEMO = "Demo mode: connect Supabase to create employees.";
// Domain labels exclude the dot that separates them, so the match is linear
// rather than backtracking over every way to split the domain.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Create a manager or driver login. Re-gated with requireRole("admin") — the UI
 * never decides access on its own — and validated before it touches the
 * service-role account creation.
 */
export async function createEmployeeAction(
  input: EmployeeInput
): Promise<CreateEmployeeActionResult> {
  const admin = await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const fullName = input.fullName?.trim() ?? "";
  const email = input.email?.trim() ?? "";
  if (!fullName) return { ok: false, error: "Full name is required." };
  if (!email || !EMAIL_RE.test(email))
    return { ok: false, error: "A valid email address is required." };
  if (!EMPLOYEE_ROLES.includes(input.role))
    return { ok: false, error: "Choose a role for this employee." };
  if (input.password && input.password.length < 8)
    return { ok: false, error: "Password must be at least 8 characters." };

  try {
    const { password } = await createEmployee({
      fullName,
      email,
      phone: input.phone ?? null,
      role: input.role,
      password: input.password ?? null,
    }, admin.id);
    revalidatePath("/admin/settings/employees");
    revalidatePath("/", "layout");
    return { ok: true, password };
  } catch (err) {
    if (err instanceof EmployeeEmailTakenError) {
      return {
        ok: false,
        error: "An account with this email already exists. Use a different email.",
      };
    }
    if (err instanceof EmployeePhoneTakenError) {
      return {
        ok: false,
        error:
          "That mobile number is already registered to another account. Use a different number or leave Mobile blank.",
      };
    }
    return { ok: false, error: "Couldn't create the employee. Try again." };
  }
}

export interface StaffActionResult {
  ok: boolean;
  error?: string;
  /** A new password, shown once. */
  password?: string;
}

function refreshStaffPages(id: string): void {
  revalidatePath("/admin/settings/employees");
  revalidatePath("/admin/riders");
  revalidatePath(`/admin/riders/${id}`);
}

async function changeAccess(admin: Profile, id: string, decision: StaffDecision, reason: string): Promise<StaffActionResult> {
  if (!(await rateLimit(`admin-staff-access:${admin.id}`, 20, 60_000)).ok) return { ok: false, error: staffAccessMessage("too_fast") };
  if (!isSupabaseConfigured) return { ok: false, error: staffAccessMessage("demo") };
  if (!isUuid(id)) return { ok: false, error: staffAccessMessage("not_found") };
  try {
    const r = await setStaffAccess(admin, id, decision, reason);
    if (!r.ok) return { ok: false, error: staffAccessMessage(r.error) };
  } catch (e) {
    captureError(e, { source: "staff-access", attrs: { event: "staff_access_failed", decision } });
    return { ok: false, error: staffAccessMessage("failed") };
  }
  refreshStaffPages(id);
  return { ok: true };
}

/** Stop a manager or rider. Refuses yourself and any admin, on the server. */
export async function stopStaffAction(id: string, reason: string): Promise<StaffActionResult> {
  const admin = await requireRole("admin");
  return changeAccess(admin, id, "stop", reason);
}

/** Let a stopped manager or rider back in. */
export async function startStaffAction(id: string, reason: string): Promise<StaffActionResult> {
  const admin = await requireRole("admin");
  return changeAccess(admin, id, "start", reason);
}

/** A new password for a manager or rider, shown once and not stored. */
export async function resetStaffPasswordAction(id: string): Promise<StaffActionResult> {
  const admin = await requireRole("admin");
  if (!(await rateLimit(`admin-staff-access:${admin.id}`, 20, 60_000)).ok) return { ok: false, error: staffAccessMessage("too_fast") };
  if (!isSupabaseConfigured) return { ok: false, error: staffAccessMessage("demo") };
  if (!isUuid(id)) return { ok: false, error: staffAccessMessage("not_found") };
  try {
    const r = await resetStaffPassword(admin, id);
    if (!r.ok) return { ok: false, error: staffAccessMessage(r.error) };
    return { ok: true, password: r.password };
  } catch (e) {
    captureError(e, { source: "staff-access", attrs: { event: "staff_password_failed" } });
    return { ok: false, error: staffAccessMessage("failed") };
  }
}
