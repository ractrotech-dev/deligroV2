"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { safeExternalHref } from "@/lib/banner-href";
import { LIVE_PLACEMENTS, isLiveTarget, targetNeedsValue } from "@/lib/banner-placements";
import { auditedChange } from "@/lib/data-access/ops-audit";
import { istInputToIso } from "@/lib/utils/ist-time";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formString } from "@/lib/utils/form-data";
import {
  createBanner,
  deleteBanner,
  duplicateBanner,
  setBannerStatus,
  updateBanner,
  type BannerInput,
} from "@/lib/data-access/banners";
import type { BannerKind, BannerStatus, BannerTargetType } from "@/types";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const STATUSES: readonly BannerStatus[] = ["draft", "active", "paused", "archived"];

function toInt(raw: FormDataEntryValue | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Read the campaign form into the shape the data layer writes. */
function parse(form: FormData): BannerInput {
  // Only what a screen actually reads. Anything else posted is dropped.
  const placements = LIVE_PLACEMENTS.filter((p) => form.get(`placement:${p}`) === "on");
  const kind = (form.get("kind") as BannerKind) ?? "internal";
  return {
    name: formString(form, "name").trim(),
    headline: formString(form, "headline").trim(),
    description: formString(form, "description").trim(),
    ctaLabel: formString(form, "ctaLabel", "Explore").trim() || "Explore",
    kind,
    status: (form.get("status") as BannerStatus) ?? "draft",
    targetType: (form.get("targetType") as BannerTargetType) ?? "food",
    targetValue: targetNeedsValue(formString(form, "targetType")) ? formString(form, "targetValue").trim() || null : null,
    placements,
    priority: toInt(form.get("priority"), 0),
    displayOrder: toInt(form.get("displayOrder"), 0),
    autoSlideMs: Math.min(8000, Math.max(3000, toInt(form.get("autoSlideMs"), 4500))),
    imageUrl: formString(form, "imageUrl").trim() || null,
    mobileImageUrl: formString(form, "mobileImageUrl").trim() || null,
    tint:
      formString(form, "tint").trim() ||
      "linear-gradient(135deg,#f2a71b,#d98600)",
    glyph: formString(form, "glyph").trim() || null,
    // A paid campaign carries its sponsor; internal ones never do.
    sponsorName:
      kind === "sponsored"
        ? formString(form, "sponsorName").trim() || null
        : null,
    // Both typed in India time, whatever zone the server runs in.
    startsAt: istInputToIso(form.get("startsAt")),
    endsAt: istInputToIso(form.get("endsAt")),
  };
}

function validate(input: BannerInput): string | null {
  if (!input.name) return "Campaign name is required.";
  if (!input.headline) return "A headline is required.";
  if (input.placements.length === 0) return "Pick where this banner shows.";
  if (!isLiveTarget(input.targetType)) return "Pick where this banner leads.";
  if (targetNeedsValue(input.targetType) && !input.targetValue) {
    return "This link needs a value.";
  }
  if (input.startsAt && input.endsAt && Date.parse(input.endsAt) <= Date.parse(input.startsAt)) {
    return "The end time must be after the start time.";
  }

  // Reject non-http(s) schemes at the write end so a javascript:/data: target
  // never reaches the database. bannerHref() also filters on read — this is the
  // pair, so a bad value can neither be stored nor rendered.
  if (input.targetType === "external" && input.targetValue) {
    if (safeExternalHref(input.targetValue) === "/") {
      return "An outside link needs a full web address, starting https://";
    }
  }
  return null;
}

/** Both create and edit come through here — `id` empty means create. */
export async function saveBannerAction(
  id: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const admin = await requireRole("admin");
  if (!isSupabaseConfigured) {
    return {
      ok: false,
      error:
        "Demo mode: connect Supabase to persist campaigns. The form and preview work, but saving needs a backend.",
    };
  }

  const input = parse(form);
  const problem = validate(input);
  if (problem) return { ok: false, error: problem };

  const after = { name: input.name, status: input.status, placements: input.placements, target: input.targetType, starts_at: input.startsAt ?? null, ends_at: input.endsAt ?? null };
  try {
    if (id) {
      await auditedChange(
        { action: "banner.update", actorId: admin.id, entityType: "banner", entityId: id, reason: "Changed in the admin console", after },
        () => updateBanner(id, input)
      );
    } else {
      const newId = randomUUID();
      await auditedChange(
        { action: "banner.create", actorId: admin.id, entityType: "banner", entityId: newId, reason: "Created in the admin console", after },
        () => createBanner(input, newId)
      );
    }
  } catch {
    return { ok: false, error: "Couldn't save the campaign. Try again." };
  }

  // The customer feed reads banners on every request; rebuild it and the list.
  revalidatePath("/", "layout");
  revalidatePath("/admin/banners");
  redirect("/admin/banners");
}

async function mutate(
  fn: () => Promise<unknown>
): Promise<ActionResult> {
  await requireRole("admin");
  if (!isSupabaseConfigured) {
    return { ok: false, error: "Demo mode: connect Supabase to manage campaigns." };
  }
  try {
    await fn();
  } catch {
    return { ok: false, error: "That didn't go through. Try again." };
  }
  revalidatePath("/", "layout");
  revalidatePath("/admin/banners");
  return { ok: true };
}

export async function setBannerStatusAction(id: string, status: BannerStatus) {
  const admin = await requireRole("admin");
  if (!STATUSES.includes(status)) return { ok: false, error: "Unknown status." };
  return mutate(() =>
    auditedChange(
      { action: "banner.status", actorId: admin.id, entityType: "banner", entityId: id, reason: "Changed in the admin console", after: { status } },
      () => setBannerStatus(id, status)
    )
  );
}

export async function duplicateBannerAction(id: string) {
  const admin = await requireRole("admin");
  const newId = randomUUID();
  return mutate(() =>
    auditedChange(
      { action: "banner.create", actorId: admin.id, entityType: "banner", entityId: newId, reason: "Copied in the admin console", after: { copied_from: id } },
      () => duplicateBanner(id, newId)
    )
  );
}

export async function deleteBannerAction(id: string) {
  const admin = await requireRole("admin");
  return mutate(() =>
    auditedChange(
      { action: "banner.delete", actorId: admin.id, entityType: "banner", entityId: id, reason: "Deleted in the admin console" },
      () => deleteBanner(id)
    )
  );
}
