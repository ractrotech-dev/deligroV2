import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { adminDocumentUrl } from "@/lib/data-access/admin-rider-profile";

/**
 * GET /admin/riders/:id/documents/:docId — open one of the rider's documents
 * (history included) through a fresh 10-minute signed link.
 *
 * The Documents tab shows images inline from links made when the page
 * rendered; this is the "Open" button, so a page left open past ten minutes
 * still works. PDFs open here in the browser's own viewer: the console's CSP
 * (`frame-src`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`) does not let
 * a storage URL be framed inside the page, and widening it for this is not
 * worth what it would open.
 *
 * Admin only (the role check is the first statement); a document that is not
 * this rider's answers 404 like one that does not exist. The redirect is never
 * cached and sends no referrer.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  await requireRole("admin");
  const { id, docId } = await params;
  const url = isSupabaseConfigured ? await adminDocumentUrl(id, docId) : null;
  if (!url) return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return NextResponse.redirect(url, {
    status: 303,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
