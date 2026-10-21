/**
 * The Partner app's menu requests, checked before anything touches the
 * database (requirements §7). Pure; tested by scripts/qa/vendor-inputs.ts.
 * Bodies are untrusted: every field is type-checked, bounded and trimmed, and
 * only the fields present are returned, so a partial edit stays partial.
 */
import type { MenuItemInput } from "@/lib/data-access/vendor-menu";

export const MENU_LIMITS = {
  name: 120,
  description: 500,
  category: 40,
  price: 100_000,
  stock: 100_000,
  optionName: 60,
  variants: 20,
  groups: 10,
  addonsPerGroup: 30,
} as const;

type Fail = { error: string };
const fail = (error: string): Fail => ({ error });

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const intIn = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** "HH:MM" or "HH:MM:SS" (24 h) → "HH:MM", else null. */
export function parseClock(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/.exec(v.trim());
  return m ? `${m[1]}:${m[2]}` : null;
}

function parseDays(v: unknown): number[] | null | Fail {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > 7 || !v.every((d) => intIn(d, 0, 6))) return fail("invalid_days");
  const days = [...new Set(v as number[])].sort();
  return days.length === 0 || days.length === 7 ? null : days;
}

/**
 * A dish to create (`partial: false`) or the changed fields of one (`partial:
 * true`). Stock, schedule fields are 0062's; `null` clears them.
 */
export function parseMenuItemBody(body: unknown, partial: boolean): Partial<MenuItemInput> | Fail {
  if (!isObj(body)) return fail("bad_request");
  const out: Partial<MenuItemInput> = {};
  const has = (k: string) => k in body && body[k] !== undefined;

  if (has("name") || !partial) {
    if (typeof body.name !== "string" || !body.name.trim()) return fail("name_required");
    if (body.name.trim().length > MENU_LIMITS.name) return fail("name_too_long");
    out.name = body.name.trim();
  }
  if (has("price") || !partial) {
    if (!intIn(body.price, 0, MENU_LIMITS.price)) return fail("invalid_price");
    out.price = body.price as number;
  }
  if (has("category") || !partial) {
    const c = typeof body.category === "string" ? body.category.trim() : "";
    if (c.length > MENU_LIMITS.category) return fail("category_too_long");
    out.category = c || "Popular";
  }
  if (has("veg") || !partial) {
    if (typeof body.veg !== "boolean") return fail("invalid_veg");
    out.veg = body.veg;
  }
  if (has("description")) {
    if (typeof body.description !== "string" || body.description.length > MENU_LIMITS.description) return fail("invalid_description");
    out.description = body.description;
  }
  for (const flag of ["available", "popular", "bestseller"] as const) {
    if (has(flag)) {
      if (typeof body[flag] !== "boolean") return fail(`invalid_${flag}`);
      out[flag] = body[flag] as boolean;
    }
  }
  if (has("imageUrl")) {
    const u = body.imageUrl;
    if (u !== null && (typeof u !== "string" || (u !== "" && !/^https:\/\//.test(u)) || u.length > 600)) return fail("invalid_image");
    out.imageUrl = (u as string | null) ?? "";
  }
  for (const k of ["stockQty", "lowStockAt"] as const) {
    if (has(k)) {
      const v = body[k];
      if (v !== null && !intIn(v, 0, MENU_LIMITS.stock)) return fail(`invalid_${k}`);
      out[k] = v as number | null;
    }
  }
  if (has("availableDays")) {
    const d = parseDays(body.availableDays);
    if (d && !Array.isArray(d)) return d;
    out.availableDays = d as number[] | null;
  }
  for (const k of ["availableFrom", "availableTo"] as const) {
    if (has(k)) {
      if (body[k] === null) out[k] = null;
      else {
        const t = parseClock(body[k]);
        if (!t) return fail(`invalid_${k}`);
        out[k] = t;
      }
    }
  }
  if (has("availableFrom") !== has("availableTo") && !partial) return fail("invalid_schedule");
  return out;
}

export interface MenuOptionsInput {
  variants: { id?: string; name: string; price: number; available: boolean }[];
  addonGroups: {
    id?: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    addons: { id?: string; name: string; price: number; available: boolean }[];
  }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const optId = (v: unknown) => (v === undefined || v === null ? undefined : typeof v === "string" && UUID.test(v) ? v : null);
const optName = (v: unknown) => (typeof v === "string" && v.trim() && v.trim().length <= MENU_LIMITS.optionName ? v.trim() : null);

/** A dish's whole set of variants and add-on groups, replacing what it had. */
export function parseMenuOptions(body: unknown): MenuOptionsInput | Fail {
  if (!isObj(body)) return fail("bad_request");
  const { variants = [], addonGroups = [] } = body as { variants?: unknown; addonGroups?: unknown };
  if (!Array.isArray(variants) || variants.length > MENU_LIMITS.variants) return fail("too_many_variants");
  if (!Array.isArray(addonGroups) || addonGroups.length > MENU_LIMITS.groups) return fail("too_many_groups");

  const out: MenuOptionsInput = { variants: [], addonGroups: [] };
  for (const v of variants) {
    if (!isObj(v)) return fail("invalid_variant");
    const id = optId(v.id), name = optName(v.name);
    if (id === null || !name || !intIn(v.price, 0, MENU_LIMITS.price)) return fail("invalid_variant");
    out.variants.push({ id, name, price: v.price as number, available: v.available !== false });
  }
  for (const g of addonGroups) {
    if (!isObj(g)) return fail("invalid_group");
    const id = optId(g.id), name = optName(g.name);
    const min = g.minSelect ?? 0, max = g.maxSelect ?? 1;
    if (id === null || !name || !intIn(min, 0, MENU_LIMITS.addonsPerGroup) || !intIn(max, 1, MENU_LIMITS.addonsPerGroup) || (max as number) < (min as number)) {
      return fail("invalid_group");
    }
    if (!Array.isArray(g.addons) || g.addons.length === 0 || g.addons.length > MENU_LIMITS.addonsPerGroup) return fail("invalid_group");
    const addons: MenuOptionsInput["addonGroups"][number]["addons"] = [];
    for (const a of g.addons) {
      if (!isObj(a)) return fail("invalid_addon");
      const aid = optId(a.id), aname = optName(a.name);
      if (aid === null || !aname || !intIn(a.price ?? 0, 0, MENU_LIMITS.price)) return fail("invalid_addon");
      addons.push({ id: aid, name: aname, price: (a.price as number | undefined) ?? 0, available: a.available !== false });
    }
    if ((min as number) > addons.length) return fail("invalid_group");
    out.addonGroups.push({ id, name, minSelect: min as number, maxSelect: max as number, addons });
  }
  return out;
}
