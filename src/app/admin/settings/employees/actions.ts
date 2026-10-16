"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
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
  await requireRole("admin");
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
    });
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
