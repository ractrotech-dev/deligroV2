/**
 * Campaign rules — pure, no I/O. The same checks 0160's SQL makes, so the
 * route can answer 400 with a field before a round trip, and the state a list
 * shows is computed one way everywhere (manager app, admin, customer feed).
 *
 * A campaign's customer-facing effect is decided by its window, never its
 * stored status: a scheduler that missed a run must not leave a featured shop
 * showing after its end or hidden after its start.
 */

/** The customer feed's pinned slots. vendor-positions.ts re-exports this. */
export const SLOT_COUNT = 10;

export type CampaignKind = "featured_store" | "banner" | "seasonal" | "sponsored_product";
export type CampaignStatus = "approved" | "in_progress" | "completed" | "cancelled";
export type CampaignState = "scheduled" | "active" | "expired";
export type FundedBy = "vendor" | "deligro" | "shared";

export const CAMPAIGN_KINDS: readonly CampaignKind[] = ["featured_store", "banner", "seasonal", "sponsored_product"];
export const BANNER_TARGETS = ["restaurant", "product", "category", "food", "external"] as const;
export const MAX_CAMPAIGN_DAYS = 180;

export interface BannerFields {
  headline: string;
  description: string;
  ctaLabel: string;
  targetType: (typeof BANNER_TARGETS)[number];
  targetValue: string | null;
  imageUrl: string | null;
  placements: string[];
}

export interface CampaignInput {
  kind: CampaignKind;
  title: string;
  zoneId: string;
  vendorIds: string[];
  itemIds: string[];
  startsAt: string;
  endsAt: string;
  budget: number | null;
  fundedBy: FundedBy;
  vendorSharePct: number | null;
  slotPosition: number | null;
  banner: BannerFields | null;
  offerCode: string | null;
  requestId: string | null;
  notes: string | null;
}

/** What happened to a campaign, as the lists show it. */
export function campaignState(c: { status: string; startsAt: string; endsAt: string }, now: Date): CampaignState {
  if (c.status === "completed" || c.status === "cancelled") return "expired";
  const t = now.getTime();
  if (t >= Date.parse(c.endsAt)) return "expired";
  if (t < Date.parse(c.startsAt)) return "scheduled";
  return "active";
}

/** Live on customer surfaces right now (window only, plus not cancelled). */
export function campaignLive(c: { status: string; startsAt: string; endsAt: string }, now: Date): boolean {
  return c.status !== "cancelled" && Date.parse(c.startsAt) <= now.getTime() && now.getTime() < Date.parse(c.endsAt);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const intOrNull = (v: unknown): number | null | undefined =>
  v === null || v === undefined || v === "" ? null : typeof v === "number" && Number.isInteger(v) ? v : undefined;
const uuidList = (v: unknown, max: number): string[] | undefined => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max || !v.every(isUuid)) return undefined;
  return [...new Set(v.map((x) => x.toLowerCase()))];
};

function parseBanner(v: unknown): BannerFields | undefined {
  if (!v || typeof v !== "object") return undefined;
  const b = v as Record<string, unknown>;
  const headline = str(b.headline);
  const description = typeof b.description === "string" ? b.description : "";
  const ctaLabel = str(b.ctaLabel);
  const targetType = b.targetType as BannerFields["targetType"];
  if (headline.length < 1 || headline.length > 60 || description.length > 140 || ctaLabel.length < 1 || ctaLabel.length > 20) return undefined;
  if (!BANNER_TARGETS.includes(targetType)) return undefined;
  const targetValue = b.targetValue == null || b.targetValue === "" ? null : typeof b.targetValue === "string" ? b.targetValue.trim() : undefined;
  if (targetValue === undefined || (targetValue && targetValue.length > 300)) return undefined;
  if (targetType === "external" && !(targetValue && /^https:\/\//.test(targetValue))) return undefined;
  const imageUrl = b.imageUrl == null || b.imageUrl === "" ? null : typeof b.imageUrl === "string" && /^https:\/\//.test(b.imageUrl) ? b.imageUrl : undefined;
  if (imageUrl === undefined) return undefined;
  const placements = Array.isArray(b.placements) && b.placements.every((p) => typeof p === "string") && b.placements.length <= 6
    ? (b.placements as string[]) : b.placements === undefined ? ["home_top"] : undefined;
  if (!placements) return undefined;
  return { headline, description, ctaLabel, targetType, targetValue, imageUrl, placements };
}

/** Validate a CampaignInput body. `field` names the first bad one. */
export function validateCampaignInput(
  input: unknown,
  now: Date,
): { ok: true; value: CampaignInput } | { ok: false; field: string } {
  if (!input || typeof input !== "object") return { ok: false, field: "body" };
  const i = input as Record<string, unknown>;
  const kind = i.kind as CampaignKind;
  if (!CAMPAIGN_KINDS.includes(kind)) return { ok: false, field: "kind" };
  const title = str(i.title);
  if (title.length < 3 || title.length > 80) return { ok: false, field: "title" };
  if (!isUuid(i.zoneId)) return { ok: false, field: "zoneId" };
  const vendorIds = uuidList(i.vendorIds, 50);
  if (!vendorIds) return { ok: false, field: "vendorIds" };
  const itemIds = uuidList(i.itemIds, 20);
  if (!itemIds) return { ok: false, field: "itemIds" };
  if (!isIso(i.startsAt)) return { ok: false, field: "startsAt" };
  if (!isIso(i.endsAt)) return { ok: false, field: "endsAt" };
  const start = Date.parse(i.startsAt), end = Date.parse(i.endsAt);
  if (start < now.getTime() - 5 * 60_000) return { ok: false, field: "startsAt" };
  if (end <= start || end - start > MAX_CAMPAIGN_DAYS * 86_400_000) return { ok: false, field: "endsAt" };
  const budget = intOrNull(i.budget);
  if (budget === undefined || (budget !== null && (budget < 0 || budget > 10_000_000))) return { ok: false, field: "budget" };
  const fundedBy = i.fundedBy as FundedBy;
  if (!["vendor", "deligro", "shared"].includes(fundedBy)) return { ok: false, field: "fundedBy" };
  const share = intOrNull(i.vendorSharePct);
  if (share === undefined || (fundedBy === "shared") !== (share !== null && share >= 1 && share <= 99)) {
    return { ok: false, field: "vendorSharePct" };
  }
  const slot = intOrNull(i.slotPosition);
  if (slot === undefined || (kind === "featured_store") !== (slot !== null) || (slot !== null && (slot < 1 || slot > SLOT_COUNT))) {
    return { ok: false, field: "slotPosition" };
  }
  if ((kind === "featured_store" || kind === "sponsored_product") && vendorIds.length !== 1) return { ok: false, field: "vendorIds" };
  if (kind === "banner" && vendorIds.length > 1) return { ok: false, field: "vendorIds" };
  if (kind === "sponsored_product" ? itemIds.length < 1 : itemIds.length > 0) return { ok: false, field: "itemIds" };
  let banner: BannerFields | null = null;
  if (kind === "banner" || kind === "seasonal") {
    const b = parseBanner(i.banner);
    if (!b) return { ok: false, field: "banner" };
    banner = b;
  }
  const offerCode = i.offerCode == null || i.offerCode === "" ? null : str(i.offerCode).toUpperCase();
  if (offerCode !== null && (kind !== "seasonal" || !/^[A-Z0-9]{3,20}$/.test(offerCode))) return { ok: false, field: "offerCode" };
  const requestId = i.requestId == null || i.requestId === "" ? null : isUuid(i.requestId) ? i.requestId : undefined;
  if (requestId === undefined) return { ok: false, field: "requestId" };
  const notes = i.notes == null ? null : typeof i.notes === "string" && i.notes.length <= 1000 ? i.notes.trim() || null : undefined;
  if (notes === undefined) return { ok: false, field: "notes" };
  return {
    ok: true,
    value: {
      kind, title, zoneId: i.zoneId as string, vendorIds, itemIds,
      startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(),
      budget, fundedBy, vendorSharePct: share, slotPosition: slot, banner, offerCode, requestId, notes,
    },
  };
}

/** Fields that may change once a campaign has started. */
export const CAMPAIGN_FIELDS_AFTER_START = ["endsAt", "budget", "notes", "banner"] as const;

/** What the detail screen may offer. */
export function campaignEditable(
  c: { kind: CampaignKind; status: string; startsAt: string; endsAt: string },
  now: Date,
): { edit: boolean; editWindowOnly: boolean; cancel: boolean; endNow: boolean; uploadImage: boolean } {
  const state = campaignState(c, now);
  const open = state !== "expired";
  return {
    edit: open,
    editWindowOnly: state === "active",
    cancel: state === "scheduled" && c.status === "approved",
    endNow: state === "active",
    uploadImage: open && (c.kind === "banner" || c.kind === "seasonal"),
  };
}

/**
 * The feed's slot layout with featured campaigns on top: each live featured
 * shop takes its slot; manually pinned shops keep their order and move down to
 * the next free slot; anything past SLOT_COUNT drops off. A shop that is both
 * pinned and featured appears once, at its campaign slot.
 */
export function effectiveVendorPositions(
  manual: Map<string, number>,
  featured: { restaurantId: string; slot: number }[],
): Map<string, number> {
  const slots: (string | null)[] = new Array(SLOT_COUNT).fill(null);
  const placed = new Set<string>();
  for (const f of featured) {
    const i = f.slot - 1;
    if (i < 0 || i >= SLOT_COUNT || slots[i] || placed.has(f.restaurantId)) continue;
    slots[i] = f.restaurantId;
    placed.add(f.restaurantId);
  }
  const rest = [...manual.entries()]
    .filter(([id, pos]) => !placed.has(id) && Number.isFinite(pos))
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  for (const [id, pos] of rest) {
    let i = Math.max(0, Math.trunc(pos) - 1);
    while (i < SLOT_COUNT && slots[i]) i++;
    if (i >= SLOT_COUNT) continue;
    slots[i] = id;
  }
  const out = new Map<string, number>();
  slots.forEach((id, i) => { if (id) out.set(id, i + 1); });
  return out;
}
