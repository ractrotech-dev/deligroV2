"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { decideMarketingRequest } from "@/lib/data-access/marketing";
import { parseMarketingDecision } from "@/lib/vendor/growth-input";

/**
 * Admin answers to the Partner app's growth flows: marketing decisions.
 * Support replies, ticket status and announcements are the shared support
 * desk's (`/admin/support/actions.ts`, `/admin/announcements/actions.ts`).
 * Every action re-checks the admin role and is rate-limited; the data layer
 * writes with the service role only after that.
 */
export type AdminActionResult = { ok: true; message?: string } | { ok: false; error: string };

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

async function guard(bucket: string) {
  const profile = await requireRole("admin");
  const limit = await rateLimit(`${bucket}:${profile.id}`, 60, 60_000);
  return limit.ok ? profile : null;
}

export async function decideMarketingAction(id: string, _prev: AdminActionResult | null, form: FormData): Promise<AdminActionResult> {
  const profile = await guard("admin-marketing");
  if (!profile) return { ok: false, error: "Too many changes — wait a minute." };
  if (!isUuid(id)) return { ok: false, error: "Not found." };
  const decision = parseMarketingDecision({ status: form.get("status"), remarks: form.get("remarks") });
  if ("error" in decision) {
    return { ok: false, error: decision.error === "remarks_required" ? "Say why when you reject a request." : "Pick a valid next step." };
  }
  const r = await decideMarketingRequest(id, profile.id, decision);
  if (!r.ok) return { ok: false, error: r.error === "not_found" ? "Not found." : "That request can't move to that step from where it is." };
  revalidatePath("/admin/marketing");
  return { ok: true, message: "Saved — the shop has been told." };
}
