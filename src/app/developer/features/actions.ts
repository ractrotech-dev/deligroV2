"use server";

import { requireRole } from "@/lib/auth";
import { saveFeatureSwitch } from "@/lib/features/save-switch.server";
import { accountSwitches, searchFeatureAccounts } from "@/lib/features/accounts.server";
import type {
  AccountFeatureRole,
  AccountSwitch,
  FeatureAccount,
  SwitchInput,
  SwitchResult,
} from "@/lib/features/switch-types";

/** Developer → Feature access. Developer only (AGENTS.md rule 3). */
export async function setFeatureSwitchAction(input: SwitchInput): Promise<SwitchResult> {
  const developer = await requireRole("developer");
  return saveFeatureSwitch(developer.id, input);
}

export async function searchFeatureAccountsAction(role: AccountFeatureRole, q: string): Promise<FeatureAccount[]> {
  await requireRole("developer");
  return searchFeatureAccounts(role, q);
}

export async function loadAccountSwitchesAction(role: AccountFeatureRole, id: string): Promise<AccountSwitch[]> {
  await requireRole("developer");
  return accountSwitches(role, id);
}
