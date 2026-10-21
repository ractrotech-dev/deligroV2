import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { istDateKey } from "@/lib/utils/ist-time";
import { applyZoneScope, type ManagerScope } from "@/lib/auth/manager-scope";
import type { ExpenseCategory, ExpensePaymentMethod } from "@/lib/cash-ledger-types";

/**
 * A Deligro cost recorded here, whatever the underlying payment channel.
 *
 * This is deliberately not an accounts-payable system: no invoices, no
 * approval workflow, no payment execution. Small operational costs (rider
 * salary, EV bike maintenance and charging, other rider-related or small
 * spend) can be paid however is practical for a single tier-3 city — cash,
 * bank transfer, UPI — and this table is only the digital record that the
 * cost happened, for how much, and what it was for. Every write goes through
 * the service role behind requireRole(["manager", "admin"]). Since 0141 each
 * row belongs to a zone and every read takes the caller's `ManagerScope`.
 *
 * The types and display labels live in src/lib/cash-ledger-types.ts, not
 * here, because that module has to be importable from a Client Component
 * (the manager's record form) and this one carries "server-only".
 */

export type { ExpenseCategory, ExpensePaymentMethod };
export { EXPENSE_CATEGORY_LABEL, EXPENSE_PAYMENT_METHOD_LABEL } from "@/lib/cash-ledger-types";

export interface OperationalExpenseRow {
  id: string;
  category: ExpenseCategory;
  amount: number;
  riderName: string | null;
  paymentMethod: ExpensePaymentMethod;
  expenseDate: string;
  note: string | null;
  recordedByName: string | null;
  createdAt: string;
}

interface ExpenseRecordInput {
  category: ExpenseCategory;
  amount: number;
  riderId?: string | null;
  paymentMethod: ExpensePaymentMethod;
  note?: string | null;
  recordedBy: string;
  /** From `resolveRecordZone`; null only for an admin (the default zone). */
  zoneId: string | null;
}

export async function recordOperationalExpense(
  input: ExpenseRecordInput
): Promise<{ ok: boolean; error?: string }> {
  // Whole rupees above zero: an empty amount box reads as 0 and a decimal used
  // to be rounded silently.
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return { ok: false, error: "Enter the amount in whole rupees, more than zero." };
  }
  // Salary is paid TO someone. Without a rider it belongs to nobody's record and
  // a retried entry cannot be told from a second month's pay.
  if (input.category === "rider_salary" && !input.riderId) {
    return { ok: false, error: "Pick the rider this salary was paid to." };
  }

  const supabase = createAdminClient();
  const { error } = await supabase.from("operational_expenses").insert({
    category: input.category,
    amount: Math.round(input.amount),
    driver_id: input.riderId ?? null,
    payment_method: input.paymentMethod,
    expense_date: istDateKey(),
    note: input.note?.trim() || null,
    recorded_by: input.recordedBy,
    // Omitted for an admin's unspecified zone: the 0141 trigger fills it.
    ...(input.zoneId ? { zone_id: input.zoneId } : {}),
  });

  if (error) return { ok: false, error: "That didn't save. Try again." };
  return { ok: true };
}

type ProfileRef = { full_name: string | null } | { full_name: string | null }[] | null;

function name(ref: ProfileRef): string | null {
  const one = Array.isArray(ref) ? (ref[0] ?? null) : ref;
  return one?.full_name?.trim() || null;
}

export async function listOperationalExpenses(
  scope: ManagerScope,
  limit = 50
): Promise<OperationalExpenseRow[]> {
  const supabase = createAdminClient();
  const query = supabase
    .from("operational_expenses")
    .select(
      "id, category, amount, payment_method, expense_date, note, created_at, rider:profiles!operational_expenses_driver_id_fkey(full_name), recorded:profiles!operational_expenses_recorded_by_fkey(full_name)"
    );
  const { data, error } = await applyZoneScope(query, scope)
    .order("created_at", { ascending: false })
    .limit(limit)
    .overrideTypes<
      {
        id: string;
        category: ExpenseCategory;
        amount: number;
        payment_method: ExpensePaymentMethod;
        expense_date: string;
        note: string | null;
        created_at: string;
        rider: ProfileRef;
        recorded: ProfileRef;
      }[]
    >();

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    category: row.category,
    amount: row.amount,
    riderName: name(row.rider),
    paymentMethod: row.payment_method,
    expenseDate: row.expense_date,
    note: row.note,
    recordedByName: name(row.recorded),
    createdAt: row.created_at,
  }));
}

/** This calendar month's spend, grouped by category. For the admin summary tiles. */
export async function operationalExpenseMonthTotals(
  scope: ManagerScope
): Promise<Record<ExpenseCategory, number>> {
  const supabase = createAdminClient();
  const monthStart = `${istDateKey().slice(0, 7)}-01`;

  const { data, error } = await applyZoneScope(
    supabase.from("operational_expenses").select("category, amount"),
    scope
  )
    .gte("expense_date", monthStart)
    .overrideTypes<{ category: ExpenseCategory; amount: number }[]>();

  if (error) throw error;

  const totals = {
    rider_salary: 0,
    ev_bike_maintenance: 0,
    ev_bike_charging: 0,
    rider_other: 0,
    small_expense: 0,
    other: 0,
  } as Record<ExpenseCategory, number>;

  for (const row of data ?? []) {
    totals[row.category] = (totals[row.category] ?? 0) + row.amount;
  }
  return totals;
}
