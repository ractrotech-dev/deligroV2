/**
 * Product rules for the Manager app (§12): how often and how long a dish was
 * unavailable in a range, restricted categories, price-change percentages,
 * what the detail screen offers, and seller ranking. Pure.
 */

export const FREQUENT_UNAVAILABLE_TIMES = 3;
export const FREQUENT_UNAVAILABLE_HOURS = 24;

/** One change of `menu_items.available` (menu_item_changes, field `available`), any order. */
export interface AvailabilityChange {
  itemId: string;
  at: string;
  to: boolean;
}

export interface Range {
  start: Date;
  endExclusive: Date;
}

const HOUR = 3_600_000;

/**
 * §12.6 for one item. The state at the range start is the last change before
 * it; with none, the opposite of the first change after it (that change moved
 * it out of the state it had been in); with no change at all, the item's
 * current value. Then walk the changes inside [start, endExclusive).
 */
export function availabilityStats(
  itemId: string,
  changes: AvailabilityChange[],
  currentAvailable: boolean,
  range: Range
): { timesUnavailable: number; hoursUnavailable: number } {
  const start = range.start.getTime();
  const end = range.endExclusive.getTime();
  const own = changes
    .filter((c) => c.itemId === itemId)
    .map((c) => ({ t: Date.parse(c.at), to: c.to }))
    .filter((c) => Number.isFinite(c.t))
    .sort((a, b) => a.t - b.t);

  const before = own.filter((c) => c.t < start);
  const after = own.filter((c) => c.t >= start);
  let available: boolean;
  if (before.length > 0) available = before[before.length - 1].to;
  else if (after.length > 0) available = !after[0].to;
  else available = currentAvailable;

  let times = 0;
  let downMs = 0;
  let cursor = start;
  for (const c of after) {
    if (c.t >= end) break;
    if (!available) downMs += c.t - cursor;
    if (available && !c.to) times += 1;
    available = c.to;
    cursor = c.t;
  }
  if (!available) downMs += end - cursor;
  return { timesUnavailable: times, hoursUnavailable: Math.round((downMs / HOUR) * 100) / 100 };
}

/** Items unavailable at least FREQUENT_UNAVAILABLE_TIMES times or HOURS in the range, longest first. */
export function frequentlyUnavailable<T extends { id: string; available: boolean }>(
  items: T[],
  changes: AvailabilityChange[],
  range: Range
): { item: T; timesUnavailable: number; hoursUnavailable: number }[] {
  return items
    .map((item) => ({ item, ...availabilityStats(item.id, changes, item.available, range) }))
    .filter((r) => r.timesUnavailable >= FREQUENT_UNAVAILABLE_TIMES || r.hoursUnavailable >= FREQUENT_UNAVAILABLE_HOURS)
    .sort((a, b) => b.hoursUnavailable - a.hoursUnavailable || b.timesUnavailable - a.timesUnavailable);
}

/** Restricted-category match: trimmed, case-insensitive (listing_restricted_categories, 0146). */
export function isRestrictedCategory(category: string | null, restricted: readonly string[]): boolean {
  if (!category) return false;
  const c = category.trim().toLowerCase();
  return c !== "" && restricted.some((r) => r.trim().toLowerCase() === c);
}

/** Percent change, one decimal; null when the old price was 0. */
export function priceChangePct(from: number, to: number): number | null {
  if (!from) return null;
  return Math.round(((to - from) / from) * 1000) / 10;
}

export interface AllowedProductActions {
  flag: boolean;
  hide: boolean;
  unhide: boolean;
  approve: boolean;
  reject: boolean;
  adjustStock: boolean;
  replacePhoto: boolean;
}

export function allowedProductActions(
  p: { approvalStatus: string; hidden: boolean; openFlags: number },
  perms: Record<string, boolean>
): AllowedProductActions {
  const view = perms["manager.products.view"] === true;
  const moderate = view && perms["manager.products.moderate"] === true;
  return {
    flag: view,
    hide: moderate && !p.hidden,
    unhide: moderate && p.hidden,
    approve: moderate && p.approvalStatus === "pending",
    reject: moderate && p.approvalStatus === "pending",
    adjustStock: view && perms["manager.products.adjust_stock"] === true,
    replacePhoto: view && perms["manager.products.replace_photo"] === true,
  };
}

/** Top sellers: most units then revenue. Slow sellers: fewest units then revenue. */
export function rankSellers<T extends { units: number; revenue: number }>(rows: T[], dir: "top" | "slow", limit: number): T[] {
  const sign = dir === "top" ? -1 : 1;
  return [...rows]
    .sort((a, b) => sign * (a.units - b.units) || sign * (a.revenue - b.revenue))
    .slice(0, Math.max(0, limit));
}
