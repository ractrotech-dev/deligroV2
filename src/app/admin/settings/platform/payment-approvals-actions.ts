"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { setSingleAdminPayments } from "@/lib/data-access/payment-approvals";

/**
 * Turns one-admin payments on or off (0152 section 5). Admin-only and
 * rate-limited — a Server Action is a public endpoint — and the RPC re-checks
 * the admin, requires the reason and writes the audit row with the change.
 */
export async function setSingleAdminPaymentsAction(input: {
  enabled: boolean;
  reason: string;
}): Promise<{ ok: boolean; error?: string }> {
  const admin = await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: "Demo mode: connect Supabase to change this." };
  const limit = await rateLimit(`single-admin-payments:${admin.id}`, 10, 60_000);
  if (!limit.ok) return { ok: false, error: "Too many changes at once. Wait a moment." };
  if (typeof input.enabled !== "boolean") return { ok: false, error: "Choose on or off." };

  const result = await setSingleAdminPayments(admin.id, input.enabled, String(input.reason ?? "").trim(), randomUUID());
  if (!result.ok) {
    switch (result.error) {
      case "reason_required":
        return { ok: false, error: "Give a reason of at least 3 characters." };
      case "forbidden":
        return { ok: false, error: "Only an admin can change this." };
      case "not_migrated":
        return { ok: false, error: "This needs migration 0152 applied first." };
      default:
        return { ok: false, error: "Couldn't save. Try again." };
    }
  }
  revalidatePath("/admin/settings/platform");
  return { ok: true };
}
