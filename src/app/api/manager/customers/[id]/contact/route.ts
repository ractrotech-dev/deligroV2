import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { revealContact } from "@/lib/data-access/manager-customers";
import { parseContactBody } from "@/lib/ops/customer-contract";
import { actionFailed, actorOf, badField, failure, notFound } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/**
 * POST …/customers/[id]/contact — reveal this customer's phone and email,
 * with a reason (§10.2, §10.9). Needs manager.customers.contact; one audited
 * row per reveal (the contact itself is never written to the audit log);
 * 10 a minute per manager. The only manager payload that carries contact.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.customers.view");
  if (ctx instanceof Response) return ctx;
  if (ctx.permissions["manager.customers.contact"] !== true) {
    return NextResponse.json({ error: "permission_denied", permission: "manager.customers.contact" }, { status: 403 });
  }
  const limited = await managerWriteLimit(ctx, "customer-contact", 10);
  if (limited) return limited;
  const { id: raw } = await params;
  if (!isUuid(raw)) return notFound();
  const parsed = parseContactBody(await readJsonObject(request));
  if (!parsed.ok) return badField(parsed.field, parsed.error);
  try {
    const r = await revealContact(actorOf(ctx.profile), ctx.scope, raw.toLowerCase(), parsed.reason, parsed.note, parsed.clientActionId);
    return r.ok ? NextResponse.json({ phone: r.phone, email: r.email }, { headers: { "Cache-Control": "no-store" } }) : failure(r);
  } catch {
    return actionFailed();
  }
}
