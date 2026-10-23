import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { replyToMyAppTicket } from "@/lib/data-access/support";
import { parseTicketMessage } from "@/lib/vendor/growth-input";
import { isUuid } from "@/lib/vendor/uuid";

/**
 * POST /api/vendor/support/:id/messages — { body, attachments? }: reply on
 * one of the caller's tickets. A resolved ticket goes back in progress; a closed one is final (409 ticket_closed).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await vendorWriteContext(null, "vendor-support");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const message = parseTicketMessage(await readJsonBody(request), ctx.profile.id);
  if ("error" in message) return badRequest(message.error);
  try {
    const result = await replyToMyAppTicket(ctx.profile.id, "vendor", id, message);
    if (result === "bad_attachment") return badRequest("invalid_attachment");
    // A closed ticket is final: start a new one (0165).
    if (result === "ticket_closed") return NextResponse.json({ error: "ticket_closed" }, { status: 409 });
    return result === "ok"
      ? NextResponse.json({ ok: true }, { status: 201 })
      : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (e) {
    return vendorWriteError(e);
  }
}
