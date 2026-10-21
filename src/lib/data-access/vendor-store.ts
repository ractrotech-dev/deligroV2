import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  columnKnownMissing,
  isMissingColumn,
  isMissingTable,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import {
  getVendorPace,
  STORE_COLUMN,
  StoreNeedsMigrationError,
  type OwnedRestaurant,
  type VendorPace,
} from "@/lib/data-access/vendor-restaurant";
import { isShopStatus, type ShopStatus } from "@/lib/orders/order-options";

/**
 * The Partner app's Store screen (requirements §8): everything the shop owner
 * can see and change about their storefront, for one shop. Payout details,
 * commission and approval are not here; they are admin-only and never leave
 * the admin screens.
 */
export interface VendorStore {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  cuisines: string[];
  imageUrl: string | null;
  address: string | null;
  landmark: string | null;
  pincode: string | null;
  lat: number | null;
  lng: number | null;
  openingTime: string | null;
  closingTime: string | null;
  weeklyOff: string[];
  deliveryAvailable: boolean;
  selfPickup: boolean;
  /** The shop's own prep time; null = it uses `defaultPrepMinutes`. */
  prepMinutes: number | null;
  approved: boolean;
  /** The owner's master switch. */
  isOpen: boolean;
  /** 0062 fields: null on a database without it. */
  shopPhone: string | null;
  closedUntil: string | null;
  /** What customers see right now (restaurant_status_now). */
  status: ShopStatus;
  holidays: StoreHoliday[];
  pace: VendorPace;
  /** False until 0062 is applied: the app hides phone, holidays and timed closing. */
  scheduleSupported: boolean;
}

export interface StoreHoliday {
  id: string;
  startsOn: string;
  endsOn: string;
  note: string | null;
}

interface DbStore {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  cuisines: string[] | null;
  image_url: string | null;
  address: string | null;
  landmark: string | null;
  pincode: string | null;
  lat: number | null;
  lng: number | null;
  opening_time: string | null;
  closing_time: string | null;
  weekly_off: string[] | null;
  delivery_available: boolean;
  self_pickup: boolean;
  prep_minutes: number | null;
  approved: boolean;
  is_open: boolean;
  shop_phone?: string | null;
  closed_until?: string | null;
}

const BASE =
  "id, slug, name, tagline, description, cuisines, image_url, address, landmark, pincode, lat, lng, opening_time, closing_time, weekly_off, delivery_available, self_pickup, prep_minutes, approved, is_open";

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

/** Today in IST as YYYY-MM-DD. */
function istToday(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

export async function getVendorStore(shop: OwnedRestaurant): Promise<VendorStore | null> {
  const supabase = await createClient();
  const select = (cols: string) =>
    supabase.from("restaurants").select(cols).eq("id", shop.id).maybeSingle().overrideTypes<DbStore>();

  let supported = !columnKnownMissing(STORE_COLUMN);
  let res = supported ? await select(`${BASE}, shop_phone, closed_until`) : await select(BASE);
  if (res.error && supported && isMissingColumn(res.error)) {
    rememberColumn(STORE_COLUMN, false);
    supported = false;
    res = await select(BASE);
  } else if (!res.error && supported) {
    rememberColumn(STORE_COLUMN, true);
  }
  if (res.error) throw res.error;
  const row = res.data;
  if (!row) return null;

  const [status, holidays, pace] = await Promise.all([
    supported ? statusNow(shop.id) : Promise.resolve(null),
    supported ? listHolidays(shop.id) : Promise.resolve([]),
    getVendorPace(shop.id),
  ]);

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    cuisines: row.cuisines ?? [],
    imageUrl: row.image_url,
    address: row.address,
    landmark: row.landmark,
    pincode: row.pincode,
    lat: row.lat,
    lng: row.lng,
    openingTime: hhmm(row.opening_time),
    closingTime: hhmm(row.closing_time),
    weeklyOff: row.weekly_off ?? [],
    deliveryAvailable: row.delivery_available,
    selfPickup: row.self_pickup,
    prepMinutes: row.prep_minutes,
    approved: row.approved,
    isOpen: row.is_open,
    shopPhone: row.shop_phone ?? null,
    closedUntil: row.closed_until && Date.parse(row.closed_until) > Date.now() ? row.closed_until : null,
    // Before 0062 the master switch is the whole story.
    status: status ?? (row.is_open ? "open" : "closed"),
    holidays,
    pace,
    scheduleSupported: supported,
  };
}

async function statusNow(restaurantId: string): Promise<ShopStatus | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("restaurant_status_now", { p_restaurant: restaurantId });
  if (error) return null;
  return isShopStatus(data) ? data : null;
}

/** Holidays that haven't ended yet, soonest first. */
export async function listHolidays(restaurantId: string): Promise<StoreHoliday[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("store_holidays")
    .select("id, starts_on, ends_on, note")
    .eq("restaurant_id", restaurantId)
    .gte("ends_on", istToday())
    .order("starts_on")
    .limit(50);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (data ?? []).map((h) => ({ id: h.id, startsOn: h.starts_on, endsOn: h.ends_on, note: h.note }));
}

/** At most this many upcoming holidays per shop: a calendar, not a log. */
export const MAX_UPCOMING_HOLIDAYS = 30;

export async function addHoliday(
  restaurantId: string,
  input: { startsOn: string; endsOn: string; note: string | null }
): Promise<StoreHoliday> {
  if (input.endsOn < istToday()) throw new Error("in_the_past");
  const existing = await listHolidays(restaurantId);
  if (existing.length >= MAX_UPCOMING_HOLIDAYS) throw new Error("too_many_holidays");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("store_holidays")
    .insert({ restaurant_id: restaurantId, starts_on: input.startsOn, ends_on: input.endsOn, note: input.note })
    .select("id, starts_on, ends_on, note")
    .single();
  if (error) {
    if (isMissingTable(error)) throw new StoreNeedsMigrationError();
    throw error;
  }
  return { id: data.id, startsOn: data.starts_on, endsOn: data.ends_on, note: data.note };
}

/** False when no such holiday belongs to this shop. */
export async function deleteHoliday(restaurantId: string, holidayId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("store_holidays")
    .delete()
    .eq("id", holidayId)
    .eq("restaurant_id", restaurantId)
    .select("id")
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) throw new StoreNeedsMigrationError();
    throw error;
  }
  return Boolean(data?.id);
}

/** What an invoice or receipt prints about the shop (requirements §11). */
export interface InvoiceProfile {
  name: string;
  address: string | null;
  phone: string | null;
  gstin: string | null;
  fssai: string | null;
}

/**
 * The active shop's details for its invoices. GSTIN and FSSAI are on the
 * 0024 deny list for client reads, so this uses the service role — only for
 * the shop `vendorApiContext()` resolved from the session, and only these
 * fields (never PAN or bank details).
 */
export async function getInvoiceProfile(restaurantId: string): Promise<InvoiceProfile | null> {
  const admin = createAdminClient();
  const base = "name, address, landmark, pincode, gst_number, fssai_number";
  let res = await admin.from("restaurants").select(`${base}, shop_phone`).eq("id", restaurantId).maybeSingle();
  if (res.error && isMissingColumn(res.error)) {
    res = await admin.from("restaurants").select(base).eq("id", restaurantId).maybeSingle();
  }
  if (res.error) throw res.error;
  const r = res.data as {
    name: string;
    address: string | null;
    landmark: string | null;
    pincode: string | null;
    gst_number: string | null;
    fssai_number: string | null;
    shop_phone?: string | null;
  } | null;
  if (!r) return null;
  const address = [r.address, r.landmark, r.pincode].filter((p) => p && p.trim()).join(", ");
  return {
    name: r.name,
    address: address || null,
    phone: r.shop_phone ?? null,
    gstin: r.gst_number?.trim() || null,
    fssai: r.fssai_number?.trim() || null,
  };
}
