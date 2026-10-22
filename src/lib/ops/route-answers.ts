import { NextResponse } from "next/server";
import { isDayKey } from "@/lib/metrics/ist";
import type { DateRange } from "@/lib/metrics/types";
import type { OpsResult } from "@/lib/ops/order-actions";
import { errorBody, httpStatusOf } from "@/lib/ops/marketing-contract";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

/** A failed Phase 7 action → its JSON answer (reason_required is 422). */
export function failure(r: Extract<OpsResult, { ok: false }>): Response {
  return NextResponse.json(errorBody(r), { status: httpStatusOf(r) });
}

/** A body or query field that failed validation. */
export function badField(field: string, error = "bad_request"): Response {
  return NextResponse.json({ error, field }, { status: error === "reason_required" ? 422 : 400 });
}

export const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });
export const actionFailed = () => NextResponse.json({ error: "action_failed" }, { status: 500 });
export const loadFailed = () => NextResponse.json({ error: "load_failed" }, { status: 500 });

export function actorOf(profile: { id: string; role: string }): OpsActor {
  return { id: profile.id, role: profile.role === "admin" ? "admin" : "manager" };
}

/** Optional `from`/`to` (IST day keys, both or neither, ≤ 366 days). */
export function parseOptionalRange(p: URLSearchParams): { ok: true; range: DateRange | null } | { ok: false; field: string } {
  const from = p.get("from"), to = p.get("to");
  if (!from && !to) return { ok: true, range: null };
  if (!from || !isDayKey(from)) return { ok: false, field: "from" };
  if (!to || !isDayKey(to) || to < from) return { ok: false, field: "to" };
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) return { ok: false, field: "to" };
  return { ok: true, range: { from, to } };
}
