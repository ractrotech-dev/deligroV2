"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { isUuid } from "@/lib/auth/manager-scope";
import { alertAction, resetRule, setRule } from "@/lib/data-access/manager-alerts";
import { parseRuleBody } from "@/lib/ops/alerts-contract";
import { isOpsAlertKind } from "@/lib/ops-alerts/kinds";

/**
 * Admin → Alerts and Settings → Alert thresholds. Each action starts with the
 * admin gate and a rate limit (AGENTS.md rules 3 and 6) and goes through the
 * same audited RPCs as the Manager app, with the admin as the actor.
 */

export type AlertActionResult = { ok: true } | { ok: false; error: string };

const MESSAGES: Record<string, string> = {
  reason_required: "Write what was done (3–300 characters).",
  already_resolved: "Someone already resolved it.",
  not_found: "That alert is gone. Refresh the page.",
  bad_threshold: "That threshold is outside the allowed range.",
  stale: "Someone else just changed it. Refresh and try again.",
};
const say = (code: string) => MESSAGES[code] ?? "That didn't save. Try again.";

async function gate(): Promise<{ id: string } | AlertActionResult> {
  const admin = await requireRole("admin");
  if (!(await rateLimit(`admin-alerts:${admin.id}`, 60, 60_000)).ok) return { ok: false, error: "Too many changes in a minute." };
  if (!isSupabaseConfigured) return { ok: false, error: "Demo mode: nothing was saved." };
  return { id: admin.id };
}

export async function alertDecisionAction(id: string, action: "acknowledge" | "resolve", note: string | null): Promise<AlertActionResult> {
  const g = await gate();
  if ("ok" in g) return g;
  if (!isUuid(id) || (action !== "acknowledge" && action !== "resolve")) return { ok: false, error: say("not_found") };
  const trimmed = note?.trim() ?? null;
  if (action === "resolve" && (!trimmed || trimmed.length < 3 || trimmed.length > 300)) return { ok: false, error: say("reason_required") };
  const r = await alertAction({ id: g.id, role: "admin" }, { all: true }, { admin: true, permissions: {} }, id, action, trimmed, randomUUID());
  if (!r.ok) return { ok: false, error: say(r.error) };
  revalidatePath("/admin/alerts");
  return { ok: true };
}

export async function saveRuleAction(input: { kind: string; zoneId: string | null; enabled: boolean; threshold: number | null; windowMinutes: number | null }): Promise<AlertActionResult> {
  const g = await gate();
  if ("ok" in g) return g;
  const parsed = parseRuleBody({ ...input, clientActionId: randomUUID() });
  if (!parsed.ok) return { ok: false, error: say(parsed.error) };
  const r = await setRule({ id: g.id, role: "admin" }, parsed.value);
  if (!r.ok) return { ok: false, error: say(r.error) };
  revalidatePath("/admin/settings/alerts");
  return { ok: true };
}

export async function resetRuleAction(kind: string, zoneId: string): Promise<AlertActionResult> {
  const g = await gate();
  if ("ok" in g) return g;
  if (!isOpsAlertKind(kind) || !isUuid(zoneId)) return { ok: false, error: say("not_found") };
  const r = await resetRule({ id: g.id, role: "admin" }, kind, zoneId, randomUUID());
  if (!r.ok) return { ok: false, error: say(r.error) };
  revalidatePath("/admin/settings/alerts");
  return { ok: true };
}
