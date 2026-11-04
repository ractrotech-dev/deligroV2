/**
 * Types and display labels for the cash-on-delivery handover chain and
 * operational expenses (0047). Deliberately NOT "server-only": the manager's
 * record form is a Client Component and needs these labels at runtime, so
 * they live here rather than in the server-only data-access files that read
 * and write the tables. src/lib/data-access/cod-handovers.ts and
 * operational-expenses.ts re-export from here for a server caller's
 * convenience.
 */

export type CashHandoverLeg = "rider_to_manager" | "rider_to_owner" | "manager_to_owner";

/** Cash that left a rider's hands: to a manager, or straight to the owner (0195). */
export function isRiderLeg(leg: string): boolean {
  return leg === "rider_to_manager" || leg === "rider_to_owner";
}

export type ExpenseCategory =
  | "rider_salary"
  | "ev_bike_maintenance"
  | "ev_bike_charging"
  | "rider_other"
  | "small_expense"
  | "other";

export type ExpensePaymentMethod = "offline_cash" | "offline_bank" | "upi" | "other";

export const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  rider_salary: "Rider salary",
  ev_bike_maintenance: "EV bike maintenance",
  ev_bike_charging: "EV bike charging",
  rider_other: "Other rider expense",
  small_expense: "Small operational expense",
  other: "Other",
};

export const EXPENSE_PAYMENT_METHOD_LABEL: Record<ExpensePaymentMethod, string> = {
  offline_cash: "Cash (offline)",
  offline_bank: "Bank transfer (offline)",
  upi: "UPI",
  other: "Other",
};
