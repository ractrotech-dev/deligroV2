import { readFormLimited } from "@/lib/http/limited-body";
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
  // The limit holds while the body streams in (a chunked upload has no Content-Length).
  const read = await readFormLimited(request, MAX_BODY);
  if (read === "too_large" || read === "bad") return badField("file");
  const f = read.get("file");
  const file = f instanceof File ? f : null;
  if (!file) return badField("file");
  try {
    const r = await uploadCampaignImage(ctx.scope, raw.toLowerCase(), file);
    return r.ok ? NextResponse.json({ imageUrl: r.imageUrl }) : failure(r);
  } catch {
    return actionFailed();
  }
}
