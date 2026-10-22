import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { uploadCampaignImage } from "@/lib/data-access/manager-marketing";
import { actionFailed, badField, failure, notFound } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

const MAX_BODY = 2 * 1024 * 1024 + 64 * 1024;

/**
 * POST …/campaigns/[id]/image — multipart `file` (JPEG or PNG by its first
 * bytes, ≤ 2 MB) into the public banner-images bucket. Answers the URL; the
 * app then sets it on the banner with a PATCH, which is what is audited.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.marketing.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "marketing-image", 20);
  if (limited) return limited;
  const { id: raw } = await params;
  if (!isUuid(raw)) return notFound();
  // Refuse an oversized body before reading it.
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_BODY) return badField("file");
  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
  } catch {
    return badField("file");
  }
  if (!file) return badField("file");
  try {
    const r = await uploadCampaignImage(ctx.scope, raw.toLowerCase(), file);
    return r.ok ? NextResponse.json({ imageUrl: r.imageUrl }) : failure(r);
  } catch {
    return actionFailed();
  }
}
