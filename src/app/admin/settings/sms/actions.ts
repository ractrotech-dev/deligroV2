"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { isUuid } from "@/lib/auth/manager-scope";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { logOpsAction } from "@/lib/data-access/ops-audit";
import { saveOrderSmsSettings, saveVendorSms } from "@/lib/data-access/vendor-order-sms";

/**
 * Admin → Settings → Vendor SMS (migration 0175). Admin-only, re-gated here —
 * a Server Action is a public endpoint — rate-limited, and each change is
 * written to the ops audit log.
 */

export interface SmsActionResult {
  ok: boolean;
  error?: string;
}

const NOT_MIGRATED = "Vendor SMS needs migration 0175 applied first.";

async function gate(): Promise<{ adminId: string } | SmsActionResult> {
  const admin = await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: "Demo mode: connect Supabase to manage SMS." };
  const limit = await rateLimit(`admin-sms:${admin.id}`, 60, 60_000);
  if (!limit.ok) return { ok: false, error: "Too many changes at once. Wait a moment." };
  return { adminId: admin.id };
}

function failure(e: unknown): SmsActionResult {
  if (e && typeof e === "object" && isMissingTable(e as { code?: string })) return { ok: false, error: NOT_MIGRATED };
  if (e instanceof Error && e.message === "bad_phone") return { ok: false, error: "Enter a valid mobile number." };
  return { ok: false, error: "Couldn't save. Try again." };
}

async function audit(actorId: string, action: string, entityId: string | null, after: Record<string, unknown>) {
  // The change is saved; a failed audit write must not report it as failed.
  await logOpsAction({ actorId, action, entityType: entityId ? "restaurant" : "platform", entityId, after }).catch(
    () => undefined
  );
}

export async function saveSmsSettingsAction(input: { enabled: boolean; template: string }): Promise<SmsActionResult> {
  const g = await gate();
  if ("ok" in g) return g;
  const enabled = input.enabled === true;
  const template = typeof input.template === "string" ? input.template.trim() : "";
  if (template.length < 10 || template.length > 300) {
    return { ok: false, error: "The message must be 10–300 characters." };
  }
  try {
    await saveOrderSmsSettings(g.adminId, enabled, template);
  } catch (e) {
    return failure(e);
  }
  await audit(g.adminId, "sms.order_settings", null, { enabled, template });
  revalidatePath("/admin/settings/sms");
  return { ok: true };
}

export async function saveVendorSmsAction(input: {
  restaurantId: string;
  enabled: boolean;
  phone: string;
}): Promise<SmsActionResult> {
  const g = await gate();
  if ("ok" in g) return g;
  if (typeof input.restaurantId !== "string" || !isUuid(input.restaurantId)) return { ok: false, error: "Unknown shop." };
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  if (phone.length > 20) return { ok: false, error: "Enter a valid mobile number." };
  let saved: { enabled: boolean; phone: string | null };
  try {
    saved = await saveVendorSms(g.adminId, input.restaurantId, input.enabled === true, phone || null);
  } catch (e) {
    return failure(e);
  }
  await audit(g.adminId, "sms.vendor_settings", input.restaurantId, saved);
  revalidatePath("/admin/settings/sms");
  return { ok: true };
}
