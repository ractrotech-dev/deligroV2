/**
 * Orders strings by UTF-16 code unit, which is what `Array.prototype.sort()`
 * does when it is given nothing, but spelled out. Used where the order has to
 * be the same on every machine and in every locale (cache keys, the order a
 * field diff is listed in): `localeCompare` would reorder "_" and capitals with
 * the runtime's locale.
 */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
