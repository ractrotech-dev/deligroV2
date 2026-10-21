"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { decideMarketingRequest } from "@/lib/data-access/marketing";
import { adminReply, setTicketStatus } from "@/lib/data-access/support";
import { createAnnouncement, endAnnouncement } from "@/lib/data-access/user-notifications";
import {
  parseAnnouncement,
  parseMarketingDecision,
  parseTicketMessage,
  TICKET_STATUSES,
  type TicketStatus,
} from "@/lib/vendor/growth-input";

/**
 * Admin answers to the Partner app (and the rider app's) growth and support
 * flows: marketing decisions, support replies and status, announcements.
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

export async function replyTicketAction(id: string, _prev: AdminActionResult | null, form: FormData): Promise<AdminActionResult> {
  const profile = await guard("admin-support");
  if (!profile) return { ok: false, error: "Too many replies — wait a minute." };
  if (!isUuid(id)) return { ok: false, error: "Not found." };
  const message = parseTicketMessage({ body: form.get("body"), internal: form.get("internal") === "on" }, profile.id, { allowInternal: true });
  if ("error" in message) return { ok: false, error: "Write a reply first." };
  const raw = String(form.get("status") ?? "");
  const status = (TICKET_STATUSES as readonly string[]).includes(raw) ? (raw as TicketStatus) : undefined;
  const ok = await adminReply(id, profile.id, message, status);
  if (!ok) return { ok: false, error: "Not found." };
  revalidatePath(`/admin/support/${id}`);
  revalidatePath("/admin/support");
  return { ok: true, message: message.internal ? "Note saved." : "Reply sent." };
}

export async function setTicketStatusAction(id: string, status: TicketStatus): Promise<AdminActionResult> {
  const profile = await guard("admin-support");
  if (!profile) return { ok: false, error: "Too many changes — wait a minute." };
  if (!isUuid(id) || !(TICKET_STATUSES as readonly string[]).includes(status)) return { ok: false, error: "Not found." };
  await setTicketStatus(id, status, profile.id);
  revalidatePath(`/admin/support/${id}`);
  revalidatePath("/admin/support");
  return { ok: true };
}

export async function createAnnouncementAction(_prev: AdminActionResult | null, form: FormData): Promise<AdminActionResult> {
  const profile = await guard("admin-announcements");
  if (!profile) return { ok: false, error: "Too many announcements — wait a minute." };
  const ist = (v: FormDataEntryValue | null) => (typeof v === "string" && v ? `${v}:00+05:30` : null);
  const input = parseAnnouncement({
    audience: form.get("audience"),
    title: form.get("title"),
    body: form.get("body"),
    startsAt: ist(form.get("startsAt")),
    endsAt: ist(form.get("endsAt")),
    push: form.get("push") === "on",
  });
  if ("error" in input) {
    const words: Record<string, string> = {
      invalid_audience: "Pick who it's for.",
      invalid_title: "Give it a title (3–120 characters).",
      invalid_body: "Write the message.",
      invalid_dates: "The end has to come after the start.",
    };
    return { ok: false, error: words[input.error] ?? "Check the form." };
  }
  const { reached } = await createAnnouncement(profile.id, input);
  revalidatePath("/admin/announcements");
  return { ok: true, message: reached > 0 ? `Published and sent to ${reached} people.` : "Published." };
}

export async function endAnnouncementAction(id: string): Promise<AdminActionResult> {
  const profile = await guard("admin-announcements");
  if (!profile || !isUuid(id)) return { ok: false, error: "Not allowed." };
  await endAnnouncement(id);
  revalidatePath("/admin/announcements");
  return { ok: true };
}
