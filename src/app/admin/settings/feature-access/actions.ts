"use server";

import { requireRole } from "@/lib/auth";
import { saveFeatureSwitch } from "@/lib/features/save-switch.server";
import type { SwitchInput, SwitchResult } from "@/lib/features/switch-types";

/**
 * Admin → Feature access: grant or withdraw what vendors, managers and riders
 * may use — including the manager powers that default off (finance approval,
 * customer contact, corrections). Admin only (AGENTS.md rule 3).
 */
export async function setFeatureSwitchAsAdminAction(input: SwitchInput): Promise<SwitchResult> {
  const admin = await requireRole("admin");
  return saveFeatureSwitch(admin.id, input);
}
