import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formString } from "@/lib/utils/form-data";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import {
  addFoodImage,
  DuplicateTitleError,
} from "@/lib/data-access/food-images";

/**
 * POST multipart/form-data { file, title, description?, tags?, veg? }
 *   → store the photo in the public `food-library` bucket and index it.
 *
 * A route handler rather than a Server Action because Server Actions cap the
 * request body at 1 MB and the bucket allows 2 MB — the same reason the vendor
 * documents upload is a route.
 *
 * Admin-gated, and rate-limited on the admin's own id: this is a write endpoint
 * that puts bytes in a world-readable bucket (AGENTS.md §6).
 *
 * The ceiling is set for the folder upload, which sends one request per photo
 * at a concurrency of three (`useFoodUpload`) — 60/minute stopped a folder of
 * a hundred dead. 240 is still a real limit on a single authenticated admin,
 * and the client honours the Retry-After rather than failing the file, so the
 * limiter throttles a big batch instead of breaking it.
 */
export async function POST(request: Request) {
  const admin = await requireRole("admin");
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }

  const limit = await rateLimit(`food-images:${admin.id}`, 240, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const file = form.get("file");
  const title = formString(form, "title").trim();
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file_required" }, { status: 400 });
  }
  if (!title) {
    return NextResponse.json({ error: "title_required" }, { status: 400 });
  }

  const vegRaw = form.get("veg");
  let veg: boolean | null = null;
  if (vegRaw === "veg") veg = true;
  else if (vegRaw === "nonveg") veg = false;

  const tags = formString(form, "tags")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  try {
    const image = await addFoodImage({
      file,
      title,
      description: formString(form, "description"),
      tags,
      veg,
      adminId: admin.id,
    });
    revalidatePath("/admin/storage");
    revalidatePath("/admin/food-images");
    return NextResponse.json({ image }, { status: 201 });
  } catch (err) {
    if (err instanceof DuplicateTitleError) {
      return NextResponse.json(
        {
          error: "duplicate_title",
          message: `There is already a photo called “${err.title}”. Open it to replace or rename it.`,
        },
        { status: 409 }
      );
    }
    const message = err instanceof Error ? err.message : "server_error";
    if (message === "invalid_type") {
      return NextResponse.json(
        { error: "invalid_type", message: "Use a JPG, PNG or WebP image." },
        { status: 400 }
      );
    }
    if (message === "too_large") {
      return NextResponse.json(
        { error: "too_large", message: "That image is over 2 MB. Use a smaller one." },
        { status: 400 }
      );
    }
    console.error("[food-images] upload failed:", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
