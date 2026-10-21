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
