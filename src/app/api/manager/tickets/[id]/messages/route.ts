import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { opsTicketMessage } from "@/lib/data-access/manager-tickets";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import { parseTicketMessageBody } from "@/lib/ops/vendor-actions";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES, checkAttachment } from "@/lib/ops/support-contract";

export const dynamic = "force-dynamic";

/** The largest body accepted at all: four full files plus the form's text. */
const MAX_BODY_BYTES = ATTACHMENT_MAX_FILES * ATTACHMENT_MAX_BYTES + 64 * 1024;

/**
 * POST /api/manager/tickets/[id]/messages — reply to the requester, or leave
 * an internal note they never see (§11.6–11.7). JSON { body: 1–4000, internal,
 * clientActionId }, or multipart/form-data with the same fields plus up to
 * four `files` (JPEG, PNG, WebP or PDF, 5 MB each, checked by their first
 * bytes). The first public staff reply sets first_response_at and moves an
 * open ticket to in_progress; the requester is pushed for public replies only.
 *
 * → 201 { ok: true }   → 400 bad_request | reason_required | bad_file   → 404 not_found
 * → 409 invalid_transition (closed) | stale   → 413 too_large   → 429
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.support.manage");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "ticket-messages");
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Refuse an oversized upload before reading it.
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  let body: Record<string, unknown> | null;
  const files: { bytes: Uint8Array; mime: string; ext: string }[] = [];
  if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json({ error: "bad_request", field: "body" }, { status: 400 });
    }
    // `files[]` is how the app names the field; `files` works too.
    const uploads = [...form.getAll("files"), ...form.getAll("files[]")].filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
    if (uploads.length > ATTACHMENT_MAX_FILES) return NextResponse.json({ error: "bad_file" }, { status: 400 });
    for (const f of uploads) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const checked = checkAttachment({ type: f.type, size: bytes.byteLength }, bytes.slice(0, 16));
      if (!checked.ok) return NextResponse.json({ error: "bad_file" }, { status: 400 });
      files.push({ bytes, mime: checked.mime, ext: checked.ext });
    }
    const internal = form.get("internal");
    body = {
      body: form.get("body"),
      internal: internal === "true" ? true : internal === "false" || internal === null ? false : internal,
      clientActionId: form.get("clientActionId"),
    };
  } else {
    body = await readJsonObject(request);
  }

  const parsed = parseTicketMessageBody(body);
  if (!parsed.ok) {
    return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });
  }

  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const m = parsed.message;
    const result = await opsTicketMessage(actor, ctx.scope, id.toLowerCase(), m.body, m.internal, m.clientActionId, files);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
