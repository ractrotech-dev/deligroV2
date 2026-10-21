/**
 * The Partner app's store requests (requirements §8), checked before anything
 * touches the database. Pure; tested by scripts/qa/vendor-inputs.ts. Only the
 * fields present come back, so a partial edit stays partial.
 */
import { parseClock } from "@/lib/vendor/menu-input";

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface StoreUpdate {
  name?: string;
  tagline?: string | null;
  description?: string | null;
  cuisines?: string[];
  imageUrl?: string | null;
  shopPhone?: string | null;
  address?: string;
  landmark?: string | null;
  pincode?: string | null;
  lat?: number;
  lng?: number;
  openingTime?: string | null;
  closingTime?: string | null;
  weeklyOff?: string[];
  deliveryAvailable?: boolean;
  selfPickup?: boolean;
  prepMinutes?: number | null;
}

type Fail = { error: string };
const fail = (error: string): Fail => ({ error });
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | null | false =>
  v === null ? null : typeof v === "string" && v.length <= max ? v.trim() || null : false;

export function parseStoreUpdate(body: unknown): StoreUpdate | Fail {
  if (!isObj(body)) return fail("bad_request");
  const has = (k: string) => k in body && body[k] !== undefined;
  const out: StoreUpdate = {};

  if (has("name")) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) return fail("invalid_name");
    out.name = body.name.trim();
  }
  for (const [k, max] of [["tagline", 120], ["description", 600], ["landmark", 120]] as const) {
    if (has(k)) {
      const t = text(body[k], max);
      if (t === false) return fail(`invalid_${k}`);
      out[k] = t;
    }
  }
  if (has("cuisines")) {
    const c = body.cuisines;
    if (!Array.isArray(c) || c.length > 8 || !c.every((x) => typeof x === "string" && x.trim() && x.length <= 30)) return fail("invalid_cuisines");
    out.cuisines = [...new Set((c as string[]).map((x) => x.trim()))];
  }
  if (has("imageUrl")) {
    const u = body.imageUrl;
    if (u !== null && (typeof u !== "string" || !/^https:\/\//.test(u) || u.length > 600)) return fail("invalid_image");
    out.imageUrl = u as string | null;
  }
  if (has("shopPhone")) {
    const p = body.shopPhone;
    if (p !== null && (typeof p !== "string" || !/^\+?[0-9 -]{6,20}$/.test(p.trim()))) return fail("invalid_phone");
    out.shopPhone = p === null ? null : (p as string).trim();
  }
  if (has("pincode")) {
    const p = body.pincode;
    if (p !== null && (typeof p !== "string" || !/^\d{6}$/.test(p.trim()))) return fail("invalid_pincode");
    out.pincode = p === null ? null : (p as string).trim();
  }
  if (has("address") || has("lat") || has("lng")) {
    const { address, lat, lng } = body;
    if (typeof address !== "string" || !address.trim() || address.length > 300) return fail("invalid_address");
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return fail("invalid_location");
    }
    out.address = address.trim();
    out.lat = lat;
    out.lng = lng;
  }
  if (has("openingTime") || has("closingTime")) {
    const o = body.openingTime, c = body.closingTime;
    if (o === null && c === null) {
      out.openingTime = null;
      out.closingTime = null;
    } else {
      const ot = parseClock(o), ct = parseClock(c);
      if (!ot || !ct) return fail("invalid_hours");
      if (ot === ct) return fail("invalid_hours");
      out.openingTime = ot;
      out.closingTime = ct;
    }
  }
  if (has("weeklyOff")) {
    const w = body.weeklyOff;
    if (!Array.isArray(w) || !w.every((d) => (WEEKDAYS as readonly string[]).includes(d as string))) return fail("invalid_weekly_off");
    if (new Set(w).size === 7) return fail("invalid_weekly_off");
    out.weeklyOff = WEEKDAYS.filter((d) => (w as string[]).includes(d));
  }
  for (const k of ["deliveryAvailable", "selfPickup"] as const) {
    if (has(k)) {
      if (typeof body[k] !== "boolean") return fail(`invalid_${k}`);
      out[k] = body[k] as boolean;
    }
  }
  if (out.deliveryAvailable === false && out.selfPickup === false) return fail("no_fulfilment");
  if (has("prepMinutes")) {
    const p = body.prepMinutes;
    if (p !== null && !(typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 180)) return fail("invalid_prep_minutes");
    out.prepMinutes = p as number | null;
  }
  return out;
}

export function parseHoliday(body: unknown): { startsOn: string; endsOn: string; note: string | null } | Fail {
  if (!isObj(body)) return fail("bad_request");
  const day = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
  if (!day(body.startsOn) || !day(body.endsOn)) return fail("invalid_dates");
  if ((body.endsOn as string) < (body.startsOn as string)) return fail("invalid_dates");
  const note = body.note === undefined || body.note === null ? null : typeof body.note === "string" && body.note.length <= 120 ? body.note.trim() || null : false;
  if (note === false) return fail("invalid_note");
  return { startsOn: body.startsOn as string, endsOn: body.endsOn as string, note };
}
