/**
 * A short-lived, in-process memo for expensive read-only figures.
 *
 * Every open Manager app asks for the dashboard every 30 s; within one city
 * most of those questions are the same question. Answers are kept for a few
 * seconds per key, and a burst of identical requests shares one in-flight
 * promise instead of each running the rollup. A failed load is never cached.
 *
 * **The key must carry everything that decides the answer** — the scope's
 * zone list above all. Two managers with different zones must never share an
 * entry; `scopeCacheKey` is the one way to spell a scope in a key.
 */
interface Entry<T> {
  expires: number;
  value: Promise<T>;
}

const MAX_ENTRIES = 500;
const store = new Map<string, Entry<unknown>>();

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > now) return hit.value;

  if (store.size >= MAX_ENTRIES) {
    for (const [k, e] of store) if (e.expires <= now) store.delete(k);
    // Still full of live entries: drop the oldest insertion.
    if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value as string);
  }

  const value = load();
  store.set(key, { expires: now + ttlMs, value });
  value.catch(() => {
    if (store.get(key)?.value === value) store.delete(key);
  });
  return value;
}

/** Test hook. */
export function clearServerCache(): void {
  store.clear();
}

/** A scope in a cache key: "all", or its zone ids sorted. */
export function scopeCacheKey(zoneIds: readonly string[] | null): string {
  return zoneIds === null ? "all" : [...zoneIds].sort().join(",") || "none";
}
