/**
 * Next and Back for the audit log. The log pages by cursor (the last row seen), so
 * there is no page number to step back to: the URL carries the cursors behind this
 * page in `back`. Pure. Cursors are base64url, so a comma is a safe separator.
 */

/** Most pages Back can retrace; past that it returns to the newest page. */
const MAX_TRAIL = 25;

function cleanTrail(raw: string | null): string[] {
  return (raw ?? "").split(",").filter((c) => /^[A-Za-z0-9_-]+$/.test(c)).slice(-MAX_TRAIL);
}

function hrefOf(base: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export interface AuditPager {
  /** 1 for the newest page. */
  page: number;
  next: string | null;
  back: string | null;
}

export function auditPager(base: string, current: URLSearchParams, nextCursor: string | null): AuditPager {
  const cursor = current.get("cursor");
  const trail = cursor ? cleanTrail(current.get("back")) : [];

  const filters = new URLSearchParams(current);
  filters.delete("cursor");
  filters.delete("back");

  let next: string | null = null;
  if (nextCursor) {
    const p = new URLSearchParams(filters);
    p.set("cursor", nextCursor);
    const behind = cursor ? [...trail, cursor] : [];
    if (behind.length > 0) p.set("back", behind.slice(-MAX_TRAIL).join(","));
    next = hrefOf(base, p);
  }

  let back: string | null = null;
  if (cursor) {
    const p = new URLSearchParams(filters);
    const previous = trail[trail.length - 1];
    if (previous) {
      p.set("cursor", previous);
      if (trail.length > 1) p.set("back", trail.slice(0, -1).join(","));
    }
    back = hrefOf(base, p);
  }

  return { page: cursor ? trail.length + 2 : 1, next, back };
}
