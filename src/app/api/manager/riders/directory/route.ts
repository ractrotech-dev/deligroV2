import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readAllRows } from "@/lib/data-access/read-all";
import { readByIds, scopedRiderIds } from "@/lib/data-access/scoped-riders";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/riders/directory — the riders of the manager's zones by name
 * and rider ID, for pickers (the support queue's rider filter). Names and
 * codes only: no phone, no position, no account state. Any manager may read
 * it (the support queue needs it without `manager.riders.view`).
 *
 * → 200 { riders: [{ id, name, code }] }   (alphabetical)   → 500 load_failed
 */
export async function GET() {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  try {
    const scoped = await scopedRiderIds(ctx.scope);
    let ids: string[];
    if (scoped === null) {
      const all = await readAllRows<{ id: string }>((from, to) =>
        createAdminClient().from("profiles").select("id").eq("role", "driver").order("id").range(from, to) as unknown as PromiseLike<{ data: { id: string }[] | null; error: unknown }>
      );
      if (all.error) throw all.error;
      ids = all.data.map((r) => r.id);
    } else {
      ids = [...scoped];
    }
    const [people, codes] = await Promise.all([
      readByIds<{ id: string; full_name: string | null }>("profiles", "id, full_name", "id", ids),
      readByIds<{ driver_id: string; rider_code: string | null }>("rider_profiles", "driver_id, rider_code", "driver_id", ids).catch(() => []),
    ]);
    const code = new Map(codes.map((c) => [c.driver_id, c.rider_code]));
    const riders = people
      .map((p) => ({ id: p.id, name: p.full_name?.trim() || "Rider", code: code.get(p.id) ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ riders }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
