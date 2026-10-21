"use server";

import { requireRole } from "@/lib/auth";
import { saveFeatureSwitch } from "@/lib/features/save-switch.server";
import type { SwitchInput, SwitchResult } from "@/lib/features/switch-types";

/** Developer → Feature access. Developer only (AGENTS.md rule 3). */
export async function setFeatureSwitchAction(input: SwitchInput): Promise<SwitchResult> {
  const developer = await requireRole("developer");
  return saveFeatureSwitch(developer.id, input);
}
