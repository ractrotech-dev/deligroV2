/**
 * Reconciliation's query and permission rule (§7 tracking 9) — pure.
 *
 *   orders, online → manager.finance.view
 *   cash           → manager.finance.view OR manager.cash (a cash-desk manager
 *                    reconciles riders' deposits without seeing settlements)
 */
import type { DateRange } from "@/lib/metrics";
import { parseFinanceRange } from "@/lib/ops/finance-contract";
import { RECONCILIATION_STATES } from "@/lib/ops/finance-rules";
import { decodeKeyCursor } from "@/lib/ops/finance-contract";

export type ReconciliationSection = "orders" | "online" | "cash";

const STATES: Record<ReconciliationSection, readonly string[]> = {
  orders: RECONCILIATION_STATES,
  online: ["matched", "online_mismatch", "missing_payment"],
  cash: ["settled", "pending", "disputed"],
};

/** The permission the caller lacks for this section, or null when allowed. */
export function reconciliationPermission(
  section: ReconciliationSection,
  perms: Record<string, boolean>,
  isAdmin: boolean
): "manager.finance.view" | "manager.cash" | null {
  if (isAdmin) return null;
  if (perms["manager.finance.view"] === true) return null;
  if (section === "cash" && perms["manager.cash"] === true) return null;
  return "manager.finance.view";
}

export function parseReconciliationQuery(
  params: URLSearchParams,
  now: Date
):
  | { ok: true; section: ReconciliationSection; range: DateRange; zone: string | null; state: string | null; cursor: { at: string; id: string } | null }
  | { ok: false; error: "bad_range" | "bad_request"; field?: string } {
  const raw = params.get("section") || "orders";
  if (raw !== "orders" && raw !== "online" && raw !== "cash") return { ok: false, error: "bad_request", field: "section" };
  const section = raw as ReconciliationSection;
  const r = parseFinanceRange(params, now);
  if (!r.ok) return r;
  const state = params.get("state");
  if (state && !STATES[section].includes(state)) return { ok: false, error: "bad_request", field: "state" };
  const cursor = decodeKeyCursor(params.get("cursor"));
  if (cursor === "bad") return { ok: false, error: "bad_request", field: "cursor" };
  return { ok: true, section, range: r.range, zone: r.zone, state: state || null, cursor };
}
