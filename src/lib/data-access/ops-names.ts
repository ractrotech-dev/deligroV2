import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Display names for the ids a page of results mentions — shops, zones,
 * people, dishes — in four bounded reads (ids are a page's worth, chunked so a
 * URL never carries hundreds). Unknown ids get a neutral word, never an error:
 * a deleted dish must not break a list. Names only; never a phone or address.
 */
export interface NameBook {
  shop: (id: string) => string;
  zone: (id: string | null) => { id: string; name: string } | null;
  zoneName: (id: string) => string;
  person: (id: string) => { name: string; role: string };
  personName: (id: string) => string;
  item: (id: string) => string;
}

const CHUNK = 150;

async function byIds<T extends { id: string }>(table: string, columns: string, ids: Set<string>): Promise<T[]> {
  const list = [...ids].filter(Boolean);
  const out: T[] = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const { data, error } = await createAdminClient().from(table).select(columns).in("id", list.slice(i, i + CHUNK));
    if (error) throw error;
    out.push(...((data ?? []) as unknown as T[]));
  }
  return out;
}

export async function loadNameBook(want: {
  shops?: Iterable<string | null | undefined>;
  zones?: Iterable<string | null | undefined>;
  people?: Iterable<string | null | undefined>;
  items?: Iterable<string | null | undefined>;
}): Promise<NameBook> {
  const set = (it?: Iterable<string | null | undefined>) => new Set([...(it ?? [])].filter((x): x is string => !!x));
  const [shops, zones, people, items] = await Promise.all([
    byIds<{ id: string; name: string }>("restaurants", "id, name", set(want.shops)),
    byIds<{ id: string; name: string }>("delivery_zones", "id, name", set(want.zones)),
    byIds<{ id: string; full_name: string | null; role: string }>("profiles", "id, full_name, role", set(want.people)),
    byIds<{ id: string; name: string }>("menu_items", "id, name", set(want.items)),
  ]);
  const shopMap = new Map(shops.map((s) => [s.id, s.name]));
  const zoneMap = new Map(zones.map((z) => [z.id, z.name]));
  const personMap = new Map(people.map((p) => [p.id, { name: p.full_name?.trim() || "Someone", role: String(p.role) }]));
  const itemMap = new Map(items.map((i) => [i.id, i.name]));
  return {
    shop: (id) => shopMap.get(id) ?? "Shop",
    zone: (id) => (id ? { id, name: zoneMap.get(id) ?? "Zone" } : null),
    zoneName: (id) => zoneMap.get(id) ?? "Zone",
    person: (id) => personMap.get(id) ?? { name: "Someone", role: "unknown" },
    personName: (id) => personMap.get(id)?.name ?? "Someone",
    item: (id) => itemMap.get(id) ?? "Dish",
  };
}
