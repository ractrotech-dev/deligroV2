/**
 * Page numbers in a URL, and how a list split into two runs is paged. Pure, so
 * scripts/qa/admin-money-screens.ts can run it under tsx.
 */

/** A page number from the URL: a whole number, 1 or more. Anything else is page 1. */
export function toPage(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.trunc(n));
}

/** How many pages `total` rows need. Always at least 1, so "page 1 of 1" reads true. */
export function pageCountOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** A zero-based, inclusive row range; null when that run has no rows on this page. */
export type RowRange = { from: number; to: number } | null;

/**
 * One page across two runs of rows laid end to end: the first run in full, then
 * the second. Admin → Orders shows what is still moving before what has finished,
 * and each run has its own query and order, so a page may hold the tail of one
 * and the head of the other. No row lands on two pages and none is skipped.
 */
export function pageAcrossRuns(
  page: number,
  pageSize: number,
  firstTotal: number,
  secondTotal: number
): { first: RowRange; second: RowRange } {
  const start = (Math.max(1, page) - 1) * pageSize;
  const end = start + pageSize;
  const range = (lo: number, hi: number, total: number): RowRange => {
    const from = Math.max(0, lo);
    const to = Math.min(total, hi) - 1;
    return from <= to ? { from, to } : null;
  };
  return {
    first: range(start, end, firstTotal),
    second: range(start - firstTotal, end - firstTotal, secondTotal),
  };
}
