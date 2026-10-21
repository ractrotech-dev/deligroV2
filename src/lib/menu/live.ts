/**
 * What a customer may see and order (migration 0146): a dish that is approved,
 * or approved with a price change waiting (it sells at the old price), and not
 * hidden by Deligro. RLS applies this to anon and authenticated customers; any
 * read that reaches a customer through the service role, or through a staff
 * account that can see more, must apply it too.
 */
export const LIVE_DISH_FILTER = "approval_status.eq.approved,and(approval_status.eq.pending,pending_price.not.is.null)";

/** The two builder methods this needs. */
interface Filterable {
  or(filter: string, opts?: { referencedTable?: string }): Filterable;
  eq(column: string, value: unknown): Filterable;
}

/**
 * Keep only live dishes. `table` names the embedded menu_items relation when
 * the dishes come through another table's select (e.g. "menu_items").
 * Generic over any query builder, cast inside: a constraint on the builder
 * type is too deep for TypeScript on the typed Supabase builders.
 */
export function onlyLiveDishes<Q>(query: Q, table?: string): Q {
  const q = query as unknown as Filterable;
  const out = table
    ? q.or(LIVE_DISH_FILTER, { referencedTable: table }).eq(`${table}.hidden_by_ops`, false)
    : q.or(LIVE_DISH_FILTER).eq("hidden_by_ops", false);
  return out as unknown as Q;
}

/** The same rule over a row already read. Absent columns (a pre-0146 database) mean no moderation: live. */
export function isLiveDishRow(r: { approval_status?: string | null; pending_price?: number | null; hidden_by_ops?: boolean | null }): boolean {
  if (r.hidden_by_ops === true) return false;
  if (r.approval_status === undefined || r.approval_status === null) return true;
  return r.approval_status === "approved" || (r.approval_status === "pending" && r.pending_price !== null && r.pending_price !== undefined);
}

/** null = not asked yet; false once a read proved the database predates 0146. */
let moderationColumns: boolean | null = null;
const MODERATION_COLUMN = /\b(approval_status|pending_price|hidden_by_ops)\b/;

type Read<R> = PromiseLike<R & { error: { code?: string; message?: string } | null }>;

/**
 * Run a customer-facing dish read with the live filter applied by `live`.
 *
 * Deploying this code before migration 0146 must not take checkout down: on a
 * database without the moderation columns the filtered read fails with 42703
 * naming one of them, and there is then no moderation to apply — every dish is
 * live — so the read is retried unfiltered and the answer remembered for the
 * life of the process. That is not failing open: nothing can be pending or
 * hidden where the columns don't exist. Any other error is returned as is.
 */
export async function readLiveDishes<R>(run: (live: <Q>(query: Q, table?: string) => Q) => Read<R>): Promise<R & { error: { code?: string; message?: string } | null }> {
  const identity = <Q,>(query: Q) => query;
  if (moderationColumns === false) return run(identity);
  const result = await run(onlyLiveDishes);
  const e = result.error;
  if (e && e.code === "42703" && MODERATION_COLUMN.test(e.message ?? "")) {
    moderationColumns = false;
    return run(identity);
  }
  if (!e) moderationColumns = true;
  return result;
}
