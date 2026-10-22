import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getProfile } from "@/lib/auth";
import { campaignIsLive, recordCampaignEvent } from "@/lib/data-access/manager-marketing";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/campaigns/track — { campaignId, kind: "impression" | "click", itemId? }
 *
 * Beacon semantics, as /api/banners/track: always 200 { ok: true, recorded },
 * 120 a minute per IP, recorded only while the campaign is inside its window
 * (0160). A click by a signed-in customer carries their id, so an order they
 * place within 24 h can be attributed; staff are never stamped.
 */
export async function POST(request: Request) {
  if (!isSupabaseConfigured) return NextResponse.json({ ok: true, recorded: false });
  const limit = await rateLimit(`campaign-track:${clientIp(request)}`, 120, 60_000);
  if (!limit.ok) return NextResponse.json({ ok: true, recorded: false });

  let body: { campaignId?: unknown; kind?: unknown; itemId?: unknown; placement?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: true, recorded: false });
  }
  const { campaignId, kind, itemId, placement } = body;
  if (typeof campaignId !== "string" || !UUID.test(campaignId) || (kind !== "impression" && kind !== "click")) {
    return NextResponse.json({ ok: true, recorded: false });
  }
  if (placement === "preview") return NextResponse.json({ ok: true, recorded: false });
  const item = typeof itemId === "string" && UUID.test(itemId) ? itemId : null;

  try {
    if (!(await campaignIsLive(campaignId, new Date()))) return NextResponse.json({ ok: true, recorded: false });
    const profile = kind === "click" ? await getProfile().catch(() => null) : null;
    await recordCampaignEvent(campaignId, kind, profile?.role === "customer" ? profile.id : null, item);
    return NextResponse.json({ ok: true, recorded: true });
  } catch {
    return NextResponse.json({ ok: true, recorded: false });
  }
}
