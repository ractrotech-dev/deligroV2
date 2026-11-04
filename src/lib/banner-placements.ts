import type { BannerPlacement, BannerTargetType } from "@/types";

/**
 * What actually works on a banner, in one place: the form offers these, the
 * server refuses anything else, and the list marks what falls outside them.
 *
 * Only `home_hero` is read, by the web home page and by the customer app
 * (`repo.banners('home_hero')`). Add a placement here only once a screen reads it.
 * The other values stay valid on old rows, so nothing is lost; they just show
 * nowhere, and the banner list says so.
 */
export const LIVE_PLACEMENTS: readonly BannerPlacement[] = ["home_hero"];

export const PLACEMENT_LABEL: Partial<Record<string, string>> = {
  home_hero: "Home page carousel",
};

/** Does this banner have a placement some screen reads? */
export function bannerShowsAnywhere(placements: readonly string[] | null | undefined): boolean {
  return (placements ?? []).some((p) => (LIVE_PLACEMENTS as readonly string[]).includes(p));
}

/**
 * The placements a campaign banner is stored with. The Manager app sends
 * ['home_top'] on every banner, which no screen reads, and an older build may
 * send nothing, so the server turns anything unreadable into the home carousel.
 */
export function campaignPlacements(raw: readonly string[] | undefined): string[] {
  const live = (raw ?? []).filter((p) => (LIVE_PLACEMENTS as readonly string[]).includes(p));
  return live.length > 0 ? live : ["home_hero"];
}

/**
 * Link types that lead somewhere. Left out only what truly goes nowhere:
 * membership, refer and product (no such page) and store (no page for one store).
 * Pharmacy opens on the website; the customer app has no route for it yet, so a
 * tap there does nothing until the app team adds one.
 */
export const LIVE_TARGETS: readonly { id: BannerTargetType; label: string; needsValue: boolean; hint?: string }[] = [
  { id: "food", label: "Food home", needsValue: false },
  { id: "grocery", label: "Grocery", needsValue: false },
  { id: "pick_drop", label: "Pick & Drop", needsValue: false },
  { id: "shops", label: "All shops", needsValue: false },
  { id: "pharmacy", label: "Pharmacy", needsValue: false },
  { id: "restaurant", label: "One shop", needsValue: true, hint: "The shop's web address name, like royal-biryani." },
  { id: "category", label: "Search by category", needsValue: true, hint: "The category, like Biryani." },
  { id: "external", label: "Outside link", needsValue: true, hint: "A full web address, starting https://" },
];

export function isLiveTarget(type: string): boolean {
  return LIVE_TARGETS.some((t) => t.id === type);
}

export function targetNeedsValue(type: string): boolean {
  return LIVE_TARGETS.find((t) => t.id === type)?.needsValue ?? false;
}
