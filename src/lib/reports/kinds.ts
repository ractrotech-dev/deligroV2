/**
 * What the admin Reports page needs to know about report kinds — client-safe.
 *
 * The kinds themselves are the report registry's (`definitions.ts`): one list
 * for the manager API and the admin console, so the two can never offer
 * different reports or compute them differently. The admin page keeps its own
 * result shape (`ReportResult`), produced from the registry's payload by
 * `data-access/admin-reports.ts`.
 *
 * Pure data and types. No queries, no secrets.
 */
import { REPORTS, type ReportKindId } from "@/lib/reports/definitions";

/** A registry kind, or one of the admin's old ids (aliases resolved by the registry). */
export type ReportKind = ReportKindId | "earnings" | "settlement";

export const REPORT_KINDS: { value: ReportKindId; label: string; blurb: string }[] = REPORTS.map((r) => ({
  value: r.kind,
  label: r.label,
  blurb: r.blurb,
}));

export type PaymentFilter = "all" | "cod" | "online";

export interface ReportFilters {
  kind: ReportKind;
  /** Inclusive IST calendar days, "YYYY-MM-DD". */
  from: string;
  to: string;
  /** Restaurant id, or omitted for every shop. */
  vendorId?: string;
  riderId?: string;
  status?: string;
  payment?: PaymentFilter;
}

/** A report is a title, some headline figures, and a table anyone can export. */
interface ReportTable {
  columns: { key: string; label: string; align?: "right"; money?: boolean }[];
  rows: Record<string, string | number>[];
  /** Optional totals row, rendered bold and exported as the last line. */
  totals?: Record<string, string | number>;
}

/**
 * One IST calendar day of the window the report covers — drawn from the
 * report's own rows (never fetched separately: a chart that disagrees with the
 * table beneath it is worse than no chart). Zero-filled across the range.
 */
export interface ReportDay {
  /** "YYYY-MM-DD", IST. */
  date: string;
  /** Short axis label, e.g. "8 Aug". */
  label: string;
  orders: number;
  /** What customers paid, whole rupees. */
  sales: number;
}

export interface ReportResult {
  kind: ReportKindId;
  title: string;
  subtitle: string;
  /** Big numbers above the table. */
  highlights: { label: string; value: string; note?: string }[];
  /** Empty for a report whose subject is not time. */
  series: ReportDay[];
  table: ReportTable;
  /** Empty when the range has no data — the UI says so rather than showing 0s. */
  empty: boolean;
  notes: string[];
  generatedAt: string;
}
