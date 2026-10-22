import { NextResponse } from "next/server";
import { managerWriteLimit, type ManagerApiContext } from "@/lib/auth/manager-api.server";
import { decodeKeyCursor } from "@/lib/ops/finance-contract";

/**
 * Small shared pieces of the /api/manager/finance and /reports routes: the
 * read budget (these are the heaviest manager reads, so they get one, as the
 * dashboard does) and the cursor parsing every list repeats.
 */

/** 120 finance reads a minute per person. Null when within it. */
export function financeReadLimit(ctx: ManagerApiContext): Promise<Response | null> {
  return managerWriteLimit(ctx, "finance-read", 120, 60_000);
}

export function badRequest(field: string): Response {
  return NextResponse.json({ error: "bad_request", field }, { status: 400 });
}

/** `cursor` param → value, null when absent, or a 400 response. */
export function cursorParam(p: URLSearchParams): { at: string; id: string } | null | Response {
  const c = decodeKeyCursor(p.get("cursor"));
  return c === "bad" ? badRequest("cursor") : c;
}

export const loadFailed = () => NextResponse.json({ error: "load_failed" }, { status: 500 });
