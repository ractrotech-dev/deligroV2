import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  Banner,
  BannerKind,
  BannerPlacement,
  BannerStatus,
  BannerTargetType,
} from "@/types";

/**
 * Promotional banners / ad campaigns, from Supabase.
 *
 * Reads for the app go through the "banners — read live" RLS policy, so a
 * customer only ever receives campaigns that are active and inside their
 * schedule window — the `where` clauses here are for ordering and placement,
 * not authorization. Admin reads/writes ride the "banners — admin all" policy;
 * a non-admin session silently sees nothing rather than erroring.
 */

const SELECT = `
  id, name, headline, description, cta_label, kind, status,
  target_type, target_value, placements, priority, display_order,
  auto_slide_ms, image_url, mobile_image_url, tint, glyph, sponsor_name,
  target_cities, target_zones, target_segments, starts_at, ends_at,
  impressions, clicks, conversions, orders_count
`;

// The DB row shape returned by SELECT. camelCased into `Banner` by mapBanner.
interface BannerRow {
  id: string;
  name: string;
  headline: string;
  description: string | null;
  cta_label: string | null;
  kind: string;
  status: string;
  target_type: string;
  target_value: string | null;
  placements: string[] | null;
  priority: number | null;
  display_order: number | null;
  auto_slide_ms: number | null;
  image_url: string | null;
  mobile_image_url: string | null;
  tint: string | null;
  glyph: string | null;
  sponsor_name: string | null;
  target_cities: string[] | null;
  target_zones: string[] | null;
  target_segments: string[] | null;
  starts_at: string | null;
  ends_at: string | null;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  orders_count: number | null;
}

/**
 * Thrown when the `banners` table hasn't been created yet (migration 0014 not
 * applied). The facade treats this specially — it falls back to the demo set so
 * the carousel still renders during rollout, exactly like the schema-probe
 * fallback the catalog uses for un-migrated columns. A table that exists but is
 * empty is NOT this: that legitimately means "no campaigns", so we return [].
 */
export class BannersNotMigratedError extends Error {
  constructor() {
    super("banners_not_migrated");
    this.name = "BannersNotMigratedError";
  }
}

/** Does this PostgREST error mean the table/relation is missing entirely? */
function isMissingTable(
  error: { code?: string; message?: string } | null
): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const msg = (error.message ?? "").toLowerCase();
  // 42P01 = undefined_table (direct PG); PGRST205 = not found in schema cache.
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    msg.includes("schema cache") ||
    msg.includes("does not exist")
  );
}

function mapBanner(row: BannerRow): Banner {
  const impressions = Number(row.impressions ?? 0);
  const clicks = Number(row.clicks ?? 0);
  return {
    id: row.id,
    name: row.name,
    headline: row.headline,
    description: row.description ?? "",
    ctaLabel: row.cta_label ?? "Explore",
    kind: (row.kind as BannerKind) ?? "internal",
    status: (row.status as BannerStatus) ?? "draft",
    target: {
      type: (row.target_type as BannerTargetType) ?? "food",
      value: row.target_value ?? undefined,
    },
    placements: (row.placements ?? []) as BannerPlacement[],
    priority: row.priority ?? 0,
    displayOrder: row.display_order ?? 0,
    autoSlideMs: row.auto_slide_ms ?? 4500,
    imageUrl: row.image_url ?? undefined,
    mobileImageUrl: row.mobile_image_url ?? undefined,
    tint: row.tint ?? "linear-gradient(135deg,#f2a71b,#d98600)",
    glyph: row.glyph ?? undefined,
    sponsorName: row.sponsor_name ?? undefined,
    targeting: {
      cities: row.target_cities ?? [],
      zones: row.target_zones ?? [],
      segments: row.target_segments ?? [],
    },
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    analytics: {
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : 0,
      conversions: Number(row.conversions ?? 0),
      orders: Number(row.orders_count ?? 0),
    },
  };
}

/** The live campaigns for one placement, best-priority first. */
export async function listActiveBannersFromDb(
  placement: BannerPlacement
): Promise<Banner[]> {
  const supabase = await createClient();
  // RLS already restricts rows to active + in-window; we only add placement and
  // ordering. `.contains` matches rows whose placements array holds this value.
  const { data, error } = await supabase
    .from("banners")
    .select(SELECT)
    .contains("placements", [placement])
    .order("priority", { ascending: false })
    .order("display_order", { ascending: true });

  if (error) {
    if (isMissingTable(error)) throw new BannersNotMigratedError();
    return [];
  }
  if (!data) return [];
  return (data as BannerRow[]).map(mapBanner);
}

/** Every campaign, any status — the Admin list. Empty for non-admins. */
export async function listAllBannersFromDb(): Promise<Banner[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("banners")
    .select(SELECT)
    .order("status", { ascending: true })
    .order("priority", { ascending: false })
    .order("display_order", { ascending: true });

  if (error) {
    if (isMissingTable(error)) throw new BannersNotMigratedError();
    return [];
  }
  if (!data) return [];
  return (data as BannerRow[]).map(mapBanner);
}

export async function getBannerFromDb(id: string): Promise<Banner | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("banners")
    .select(SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) throw new BannersNotMigratedError();
    return null;
  }
  if (!data) return null;
  return mapBanner(data as BannerRow);
}

/**
 * Cheap probe: does the `banners` table exist? A head count returns no rows and
 * a tiny response. An RLS/permission error still means the table is there, so
 * only a missing-table error counts as "not ready".
 */
export async function bannersTableExists(): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("banners")
    .select("id", { head: true, count: "exact" })
    .limit(1);
  if (error) return !isMissingTable(error);
  return true;
}

/** Admin-authored fields. Analytics and timestamps are DB-owned, not sent. */
export type BannerInput = {
  name: string;
  headline: string;
  description: string;
  ctaLabel: string;
  kind: BannerKind;
  status: BannerStatus;
  targetType: BannerTargetType;
  targetValue?: string | null;
  placements: BannerPlacement[];
  priority: number;
  displayOrder: number;
  autoSlideMs: number;
  imageUrl?: string | null;
  mobileImageUrl?: string | null;
  tint: string;
  glyph?: string | null;
  sponsorName?: string | null;
  targetCities?: string[];
  targetZones?: string[];
  targetSegments?: string[];
  startsAt?: string | null;
  endsAt?: string | null;
};

// Input → DB column names. Writes throw (RLS rejects a non-admin), because a
// campaign that silently fails to save is worse than one that reports it.
function toRow(input: BannerInput) {
  return {
    name: input.name,
    headline: input.headline,
    description: input.description,
    cta_label: input.ctaLabel,
    kind: input.kind,
    status: input.status,
    target_type: input.targetType,
    target_value: input.targetValue ?? null,
    placements: input.placements,
    priority: input.priority,
    display_order: input.displayOrder,
    auto_slide_ms: input.autoSlideMs,
    image_url: input.imageUrl ?? null,
    mobile_image_url: input.mobileImageUrl ?? null,
    tint: input.tint,
    glyph: input.glyph ?? null,
    sponsor_name: input.sponsorName ?? null,
    target_cities: input.targetCities ?? [],
    target_zones: input.targetZones ?? [],
    target_segments: input.targetSegments ?? [],
    starts_at: input.startsAt ?? null,
    ends_at: input.endsAt ?? null,
    updated_at: new Date().toISOString(),
  };
}

export async function createBanner(input: BannerInput): Promise<string> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("banners")
    .insert(toRow(input))
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function updateBanner(
  id: string,
  input: BannerInput
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("banners")
    .update(toRow(input))
    .eq("id", id);
  if (error) throw error;
}

/** Flip status without touching the rest — powers pause/resume/archive. */
export async function setBannerStatus(
  id: string,
  status: BannerStatus
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("banners")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** Copy a campaign as a fresh draft with zeroed analytics. */
export async function duplicateBanner(id: string): Promise<string> {
  const existing = await getBannerFromDb(id);
  if (!existing) throw new Error("not_found");
  return createBanner({
    name: `${existing.name} (copy)`,
    headline: existing.headline,
    description: existing.description,
    ctaLabel: existing.ctaLabel,
    kind: existing.kind,
    status: "draft",
    targetType: existing.target.type,
    targetValue: existing.target.value ?? null,
    placements: existing.placements,
    priority: existing.priority,
    displayOrder: existing.displayOrder,
    autoSlideMs: existing.autoSlideMs,
    imageUrl: existing.imageUrl ?? null,
    mobileImageUrl: existing.mobileImageUrl ?? null,
    tint: existing.tint,
    glyph: existing.glyph ?? null,
    sponsorName: existing.sponsorName ?? null,
    targetCities: existing.targeting?.cities ?? [],
    targetZones: existing.targeting?.zones ?? [],
    targetSegments: existing.targeting?.segments ?? [],
    startsAt: existing.startsAt ?? null,
    endsAt: existing.endsAt ?? null,
  });
}

export async function deleteBanner(id: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.from("banners").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Log an impression/click and bump the row counter. Fire-and-forget: a tracking
 * failure must never break the page, so it returns rather than throws.
 *
 * Runs on the service-role client because migration 0022 revokes
 * `bump_banner_stat` from anon/authenticated. That RPC is SECURITY DEFINER, so
 * granting it to anon made the counters an unauthenticated write API anyone
 * could drive in a loop — inflating the numbers a campaign is judged (and
 * possibly billed) on. Funnelling it through here means the only way to reach
 * it is /api/banners/track, which is rate limited and validates the payload.
 */
export async function recordBannerEvent(
  bannerId: string,
  kind: "impression" | "click" | "conversion" | "order",
  meta?: { placement?: string; city?: string; customerId?: string | null }
): Promise<void> {
  const supabase = createAdminClient();
  const row: Record<string, unknown> = {
    banner_id: bannerId,
    kind,
    placement: meta?.placement ?? null,
    city: meta?.city ?? null,
  };
  // 0160: the signed-in customer, for 24 h campaign attribution. Omitted when
  // there is none, so a database without 0160 keeps working.
  if (meta?.customerId) row.customer_id = meta.customerId;
  const { error } = await supabase.from("banner_events").insert(row);
  if (error) return; // not live / not found — drop silently
  await supabase.rpc("bump_banner_stat", {
    p_banner_id: bannerId,
    p_kind: kind,
  });
}
