import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { uploadCampaignImage } from "@/lib/data-access/manager-marketing";
import { actionFailed, badField, failure, notFound } from "@/lib/ops/route-answers";
import { readLimitedForm } from "@/lib/http/limited-form";

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
  // Read the body as a stream and stop at the cap: a header check alone misses a chunked
  // body, and formData() would buffer all of it.
  const form = await readLimitedForm(request, MAX_BODY);
  const f = form?.get("file");
  const file = f instanceof File ? f : null;
  if (!file) return badField("file");
  try {
    const r = await uploadCampaignImage(ctx.scope, raw.toLowerCase(), file);
    return r.ok ? NextResponse.json({ imageUrl: r.imageUrl }) : failure(r);
  } catch {
    return actionFailed();
  }
}
