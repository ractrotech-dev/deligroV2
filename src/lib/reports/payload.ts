/**
 * What a report answers with (Phase 6 contract `ReportPayload`) and the small
 * pure helpers its builders share. English only.
 */
import type { ColumnType, ReportKindId } from "@/lib/reports/definitions";

export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell>;

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}

export interface ReportHighlight {
  key: string;
  label: string;
  value: ReportCell;
  type: ColumnType;
}

export interface ReportPayload {
  kind: ReportKindId;
  title: string;
  subtitle: string;
  generatedAt: string;
  generatedBy: { id: string; name: string };
  filters: {
    from: string;
    to: string;
    zone: { id: string; name: string } | null;
    vendor: { id: string; name: string } | null;
    rider: { id: string; name: string } | null;
    status: string | null;
    payment: "all" | "cod" | "online";
  };
  highlights: ReportHighlight[];
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: ReportRow | null;
  page: number;
  pageSize: number;
  totalRows: number;
  notes: string[];
}

/** What a builder hands back before paging and finance-column filtering. */
export interface Built {
  rows: ReportRow[];
  /** Rows the filter matches in all (equals rows.length unless the builder paged in SQL). */
  totalRows: number;
  totals: ReportRow | null;
  highlights: ReportHighlight[];
  notes: string[];
  /** True when `rows` is already the requested page (paged in SQL). */
  paged: boolean;
}

export const MAX_EXPORT_ROWS = 10_000;
export const MAX_PAGE_SIZE = 200;

/** Sum the given keys across rows (nulls count as 0). Money2 rounded to paise. */
export function sumKeys(rows: ReportRow[], keys: string[], money2: string[] = []): ReportRow {
  const out: ReportRow = {};
  for (const k of keys) {
    const s = rows.reduce((acc, r) => acc + (typeof r[k] === "number" ? (r[k] as number) : Number(r[k] ?? 0) || 0), 0);
    out[k] = money2.includes(k) ? Math.round(s * 100) / 100 : s;
  }
  return out;
}

/** A rate as a fraction rounded to 4 places; null (never NaN) without a denominator. */
export function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
}

/** A weighted mean of minutes (sum ÷ count), 1 decimal; null without a count. */
export function meanMinutes(sum: number, count: number): number | null {
  return count > 0 ? Math.round((sum / count) * 10) / 10 : null;
}

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v) || 0);
