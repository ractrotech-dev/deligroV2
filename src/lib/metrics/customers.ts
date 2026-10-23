/**
 * Repeat orders and retention (§10.6) — the reference arithmetic, over per-customer
 * facts (counted, non-cancelled orders only; IST months). The app's figures come from
 * 0162's ops_retention (SQL, no row cap); scripts/qa/manager-retention-sql.ts holds
 * that to these functions, so they stay the definition.
 */
import { istDayKey } from "./ist";
import type { DateRange } from "./types";
import { rangeBounds } from "./ist";

export interface CustomerFact {
  customerId: string;
  /** First counted order ever (within the scope's zones). */
  firstOrderAt: string;
  secondOrderAt: string | null;
  ordersInRange: number;
  spentInRange: number;
  lastOrderAt: string;
}

export interface RetentionSummary {
  customers: number;
  newCustomers: number;
  returningCustomers: number;
  /** % of customers with two or more orders in the range, one decimal. */
  repeatRate: number;
  ordersPerCustomer: number;
  aovPerCustomer: number;
}

export interface RetentionCohort {
  cohort: string;
  customers: number;
  r30: number | null;
  r60: number | null;
  r90: number | null;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

export function retentionSummary(facts: CustomerFact[], range: DateRange): RetentionSummary {
  const { start, endExclusive } = rangeBounds(range);
  const active = facts.filter((f) => f.ordersInRange > 0);
  const customers = active.length;
  const newCustomers = active.filter((f) => {
    const t = Date.parse(f.firstOrderAt);
    return t >= start.getTime() && t < endExclusive.getTime();
  }).length;
  const orders = active.reduce((s, f) => s + f.ordersInRange, 0);
  const spent = active.reduce((s, f) => s + f.spentInRange, 0);
  return {
    customers,
    newCustomers,
    returningCustomers: customers - newCustomers,
    repeatRate: pct(active.filter((f) => f.ordersInRange >= 2).length, customers),
    ordersPerCustomer: customers > 0 ? round1(orders / customers) : 0,
    aovPerCustomer: orders > 0 ? Math.round(spent / orders) : 0,
  };
}

/** "2026-05" → the first instant after that IST month. */
function monthEnd(cohort: string): number {
  const [y, m] = cohort.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y, nextM = m === 12 ? 1 : m + 1;
  return Date.parse(`${nextY}-${String(nextM).padStart(2, "0")}-01T00:00:00+05:30`);
}

function shiftMonth(cohort: string, delta: number): string {
  const [y, m] = cohort.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/**
 * Monthly cohorts by first-order month (IST), the `months` ending with the
 * month of `to`. rN = share of the cohort whose second order came within N
 * days of their first; null until every member could have reached N days
 * (the cohort month's end + N days ≤ `to`'s day end).
 */
export function retentionCohorts(facts: CustomerFact[], to: string, months = 6): RetentionCohort[] {
  const last = to.slice(0, 7);
  const asOf = Date.parse(`${to}T00:00:00+05:30`) + 86_400_000;
  const out: RetentionCohort[] = [];
  for (let k = months - 1; k >= 0; k--) {
    const cohort = shiftMonth(last, -k);
    const members = facts.filter((f) => istDayKey(f.firstOrderAt).slice(0, 7) === cohort);
    const within = (days: number): number | null => {
      if (monthEnd(cohort) + days * 86_400_000 > asOf) return null;
      if (members.length === 0) return 0;
      const n = members.filter((f) => f.secondOrderAt !== null
        && Date.parse(f.secondOrderAt) - Date.parse(f.firstOrderAt) <= days * 86_400_000).length;
      return pct(n, members.length);
    };
    out.push({ cohort, customers: members.length, r30: within(30), r60: within(60), r90: within(90) });
  }
  return out;
}
