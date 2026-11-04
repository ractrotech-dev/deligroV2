import { NextResponse } from "next/server";

/**
 * POST /api/refunds — closed. There are no refunds for customers (rule book).
 *
 * Kept as a plain refusal rather than removed because customer apps already on phones
 * still call it, and they should get an answer they can show, not a 404. Writes
 * nothing and reads nothing, so it needs no session and no rate limit.
 */
export async function POST() {
  return NextResponse.json({ error: "refunds_closed" }, { status: 410 });
}
