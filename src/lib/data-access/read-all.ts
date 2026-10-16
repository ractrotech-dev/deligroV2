/**
 * Read every row of a query that PostgREST would otherwise cut off.
 *
 * A bare `select` answers with at most 1000 rows (the project's `max_rows`) and
 * no signal that anything was left out. Anything that SUMS what comes back —
 * lifetime earnings, units sold, a cash ledger — then reports a smaller number
 * than the truth, and keeps doing so as the shop grows. Reading in pages until
 * one comes back short removes the ceiling.
 *
 * `page` must build a FRESH query each call and put a total order on it
 * (`.order("id")`, or a timestamp then `id`): offset paging over an unordered or
 * tied sort can skip or repeat rows between pages.
 *
 * The result has the `{ data, error }` shape of a Supabase response, so call
 * sites that destructured one keep working. It never throws; exceeding the page
 * ceiling is reported as an error rather than as a silently short list.
 */

export const READ_PAGE = 1000;
const MAX_PAGES = 200; // 200k rows: far beyond any shop, a stop for a runaway query

type Page<T> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>;

export async function readAllRows<T>(
  page: Page<T>,
  opts: { maxRows?: number } = {}
): Promise<{ data: T[]; error: unknown; truncated: boolean }> {
  const { maxRows } = opts;
  const rows: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const from = i * READ_PAGE;
    const { data, error } = await page(from, from + READ_PAGE - 1);
    if (error) return { data: rows, error, truncated: false };
    const got = data ?? [];
    rows.push(...got);
    // A deliberate ceiling (a report that refuses to render a year of orders).
    // Reading one row past it is what distinguishes "exactly maxRows" from
    // "more than maxRows", so the caller's warning is true. Checked before the
    // short-page exit: the page that crosses the ceiling is often the last one.
    if (maxRows !== undefined && rows.length > maxRows) {
      return { data: rows.slice(0, maxRows), error: null, truncated: true };
    }
    if (got.length < READ_PAGE) return { data: rows, error: null, truncated: false };
  }
  return { data: rows, error: new Error("read-all: page ceiling exceeded"), truncated: false };
}

/**
 * Run `fetch` over `ids` in chunks, in parallel, and concatenate.
 *
 * A PostgREST `in.(…)` filter travels in the URL: 37 characters per uuid means
 * a few hundred ids already exceed what a proxy in front of the API accepts, and
 * the failure is a plain error — which a caller that treats the lookup as
 * decorative turns into "no rows", i.e. a wrong number with no warning.
 * 100 ids is about 4 KB.
 */
export async function readInChunks<T>(
  ids: readonly string[],
  fetch: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
  size = 100
): Promise<{ data: T[]; error: unknown }> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  const results = await Promise.all(chunks.map((c) => fetch(c)));
  const rows: T[] = [];
  for (const r of results) {
    if (r.error) return { data: rows, error: r.error };
    rows.push(...(r.data ?? []));
  }
  return { data: rows, error: null };
}
