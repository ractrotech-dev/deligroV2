"use server";

import { requireRole } from "@/lib/auth";
import { saveFeatureSwitch, saveFeatureSwitches } from "@/lib/features/save-switch.server";
import { accountSwitches, searchFeatureAccounts } from "@/lib/features/accounts.server";
import type {
  AccountFeatureRole,
  AccountSwitch,
  FeatureAccount,
  SwitchInput,
  SwitchResult,
} from "@/lib/features/switch-types";

/**
 * Admin → App features: what customers, shops, riders and managers can use,
 * including the manager powers that default off (finance approval, customer
 * contact, corrections). Admin only (AGENTS.md rule 3).
 */
export async function setFeatureSwitchAsAdminAction(input: SwitchInput): Promise<SwitchResult> {
  const admin = await requireRole("admin");
  return saveFeatureSwitch(admin.id, input);
}

/** Turn on / Turn off for several features. Each one is audited on its own. */
export async function setFeatureSwitchesAsAdminAction(inputs: SwitchInput[]): Promise<SwitchResult> {
  const admin = await requireRole("admin");
  return saveFeatureSwitches(admin.id, inputs);
}

export async function searchFeatureAccountsAsAdminAction(role: AccountFeatureRole, q: string): Promise<FeatureAccount[]> {
  await requireRole("admin");
  return searchFeatureAccounts(role, q);
}

export async function loadAccountSwitchesAsAdminAction(role: AccountFeatureRole, id: string): Promise<AccountSwitch[]> {
  await requireRole("admin");
  return accountSwitches(role, id);
}
