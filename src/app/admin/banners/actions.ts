"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { safeExternalHref } from "@/lib/banner-href";
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
import type {
  BannerKind,
  BannerPlacement,
  BannerStatus,
  BannerTargetType,
} from "@/types";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const PLACEMENTS: BannerPlacement[] = [
  "home_hero",
  "home_food",
  "stores_top",
  "grocery_top",
  "pharmacy_top",
  "checkout",
];

/** Split a comma/newline list into trimmed, non-empty values. */
function toList(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toInt(raw: FormDataEntryValue | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** A datetime-local value → ISO, or null when blank. */
function toIso(raw: FormDataEntryValue | null): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Read the campaign form into the shape the data layer writes. */
function parse(form: FormData): BannerInput {
  const placements = PLACEMENTS.filter((p) => form.get(`placement:${p}`) === "on");
  const kind = (form.get("kind") as BannerKind) ?? "internal";
  return {
    name: formString(form, "name").trim(),
    headline: formString(form, "headline").trim(),
    description: formString(form, "description").trim(),
    ctaLabel: formString(form, "ctaLabel", "Explore").trim() || "Explore",
    kind,
    status: (form.get("status") as BannerStatus) ?? "draft",
    targetType: (form.get("targetType") as BannerTargetType) ?? "food",
    targetValue: formString(form, "targetValue").trim() || null,
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
    targetCities: toList(form.get("targetCities")),
    targetZones: toList(form.get("targetZones")),
    targetSegments: toList(form.get("targetSegments")),
    startsAt: toIso(form.get("startsAt")),
    endsAt: toIso(form.get("endsAt")),
  };
}

function validate(input: BannerInput): string | null {
  if (!input.name) return "Campaign name is required.";
  if (!input.headline) return "A headline is required.";
  if (input.placements.length === 0) return "Pick at least one placement.";
  if (
    (input.targetType === "restaurant" ||
      input.targetType === "store" ||
      input.targetType === "product" ||
      input.targetType === "external") &&
    !input.targetValue
  ) {
    return "This target type needs a value (slug or URL).";
  }

  // Reject non-http(s) schemes at the write end so a javascript:/data: target
  // never reaches the database. bannerHref() also filters on read — this is the
  // pair, so a bad value can neither be stored nor rendered.
  if (input.targetType === "external" && input.targetValue) {
    if (safeExternalHref(input.targetValue) === "/") {
      return "External campaigns need a full http:// or https:// URL.";
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
  await requireRole("admin");
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

  try {
    if (id) {
      await updateBanner(id, input);
    } else {
      await createBanner(input);
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
  return mutate(() => setBannerStatus(id, status));
}

export async function duplicateBannerAction(id: string) {
  return mutate(() => duplicateBanner(id));
}

export async function deleteBannerAction(id: string) {
  return mutate(() => deleteBanner(id));
}
