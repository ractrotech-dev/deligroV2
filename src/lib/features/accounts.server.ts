import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { customerSearchNeedle } from "@/lib/data-access/admin-customers";
import {
  ROLE_SUBJECT,
  featureDef,
  featuresFor,
  isDefaultOn,
  type FeatureKey,
  type FeatureRole,
} from "@/lib/features/catalog";
import { listAccountSwitches, type StoredSwitch } from "@/lib/features/flags.server";
import type {
  AccountFeatureRole,
  AccountSwitch,
  FeatureAccount,
  FeatureAccountExceptions,
  FeatureRow,
} from "@/lib/features/switch-types";

/**
 * The accounts behind Admin → App features: find one customer, shop, rider or
 * manager, and name the ones with a different setting.
 *
 * Service-role reads. **Every caller has already checked for an admin or a
 * developer** (the screen's page, or that page's own Server Actions).
 */

const PROFILE_ROLE: Record<Exclude<AccountFeatureRole, "vendor">, string> = {
  customer: "customer",
  driver: "driver",
  manager: "manager",
};

const NOUN: Record<Exclude<AccountFeatureRole, "vendor">, string> = {
  customer: "Customer",
  driver: "Rider",
  manager: "Manager",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_RESULTS = 20;
/** The most accounts the "different setting" list names, per section. */
const MAX_EXCEPTIONS = 200;

export async function searchFeatureAccounts(role: AccountFeatureRole, q: string): Promise<FeatureAccount[]> {
  const needle = customerSearchNeedle(q.slice(0, 80));
  const admin = createAdminClient();
  if (role === "vendor") {
    let query = admin.from("restaurants").select("id, name, address");
    if (needle) query = query.ilike("name", needle.replace(/\*/g, "%"));
    const { data, error } = await query.order("name", { ascending: true }).limit(MAX_RESULTS);
    if (error) throw error;
    return ((data ?? []) as { id: string; name: string | null; address: string | null }[]).map((r) => ({
      id: r.id,
      name: r.name?.trim() || "Unnamed shop",
      detail: r.address,
    }));
  }
  let query = admin.from("profiles").select("id, full_name, phone").eq("role", PROFILE_ROLE[role]);
  if (needle) query = query.or(`full_name.ilike.${needle},phone.ilike.${needle}`);
  const { data, error } = await query.order("full_name", { ascending: true }).limit(MAX_RESULTS);
  if (error) throw error;
  return ((data ?? []) as { id: string; full_name: string | null; phone: string | null }[]).map((p) => ({
    id: p.id,
    name: p.full_name?.trim() || p.phone || NOUN[role],
    detail: p.phone,
  }));
}

/** One account by id, for a deep link from the Team list or a shop's page. Null when it's gone. */
export async function featureAccountById(role: AccountFeatureRole, id: string): Promise<FeatureAccount | null> {
  const [account] = (await namesFor(role, [id])).values();
  return account ?? null;
}

async function namesFor(role: AccountFeatureRole, ids: string[]): Promise<Map<string, FeatureAccount>> {
  const out = new Map<string, FeatureAccount>();
  if (!ids.length) return out;
  const admin = createAdminClient();
  if (role === "vendor") {
    const { data } = await admin.from("restaurants").select("id, name, address").in("id", ids);
    for (const r of (data ?? []) as { id: string; name: string | null; address: string | null }[]) {
      out.set(r.id, { id: r.id, name: r.name?.trim() || "Unnamed shop", detail: r.address });
    }
    return out;
  }
  const { data } = await admin.from("profiles").select("id, full_name, phone").in("id", ids);
  for (const p of (data ?? []) as { id: string; full_name: string | null; phone: string | null }[]) {
    out.set(p.id, { id: p.id, name: p.full_name?.trim() || p.phone || NOUN[role], detail: p.phone });
  }
  return out;
}

/** One account's own settings, with who set each one. */
export async function accountSwitches(role: AccountFeatureRole, id: string): Promise<AccountSwitch[]> {
  if (!UUID.test(id)) return [];
  const rows = await listAccountSwitches(ROLE_SUBJECT[role], id);
  return rows.map((r) => ({
    feature: r.feature,
    own: r.enabled,
    changedBy: r.changedBy ?? null,
    changedAt: r.changedAt ?? null,
  }));
}

/** The role-wide state of one feature: its row, else its default. */
export function everyoneOn(switches: readonly StoredSwitch[], key: FeatureKey): boolean {
  const row = switches.find((s) => s.feature === key && s.subjectKind === "role");
  return row ? row.enabled : isDefaultOn(featureDef(key));
}

/** One section's table: each feature, what everyone gets, and how many differ. */
export function featureRows(role: AccountFeatureRole, switches: readonly StoredSwitch[]): FeatureRow[] {
  const kind = ROLE_SUBJECT[role];
  return featuresFor(role).map((f) => {
    const key = f.key as FeatureKey;
    const on = everyoneOn(switches, key);
    return {
      key: f.key,
      group: f.group,
      label: f.label,
      offMeans: f.offMeans,
      pending: f.pending ?? null,
      defaultOn: isDefaultOn(f),
      on,
      // A row that says the same as everyone isn't a different setting.
      different: switches.filter((s) => s.feature === key && s.subjectKind === kind && s.enabled !== on).length,
    };
  });
}

/** Accounts whose own settings differ from everyone's, most differences first. */
export async function featureExceptions(
  role: FeatureRole & AccountFeatureRole,
  switches: readonly StoredSwitch[]
): Promise<FeatureAccountExceptions[]> {
  const kind = ROLE_SUBJECT[role];
  const keys = new Set<string>(featuresFor(role).map((f) => f.key));
  const byAccount = new Map<string, string[]>();
  for (const s of switches) {
    if (s.subjectKind !== kind || !s.subjectId || !keys.has(s.feature)) continue;
    if (s.enabled === everyoneOn(switches, s.feature)) continue;
    byAccount.set(s.subjectId, [...(byAccount.get(s.subjectId) ?? []), s.feature]);
  }
  const top = [...byAccount].sort((a, b) => b[1].length - a[1].length).slice(0, MAX_EXCEPTIONS);
  const names = await namesFor(role, top.map(([id]) => id));
  return top.map(([id, features]) => ({
    account: names.get(id) ?? { id, name: "Removed account", detail: null },
    features,
  }));
}
