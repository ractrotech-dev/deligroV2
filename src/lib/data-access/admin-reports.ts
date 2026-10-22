import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { istDay } from "@/lib/settlements/cycle";
import { resolveKind, reportMeta } from "@/lib/reports/definitions";
import { runReport } from "@/lib/reports/registry";
import type { ReportCell, ReportPayload, ReportRow } from "@/lib/reports/payload";
import type { ReportDay, ReportFilters, ReportResult } from "@/lib/reports/kinds";

// Re-exported so server callers can keep importing everything from one place.
export {
  REPORT_KINDS,
  type PaymentFilter,
  type ReportFilters,
  type ReportKind,
  type ReportResult,
} from "@/lib/reports/kinds";

/**
 * Admin → Reports, on the report registry (`lib/reports/registry.ts`). There
 * is no report arithmetic here any more: every figure comes from the same
 * scoped SQL rollups the manager app and the dashboard read (0157, 0158), so
 * an admin report and a manager report of the same orders agree to the rupee
 * (§13 "consistent calculations", §18.4). This module only turns the
 * registry's payload into the admin page's table shape.
 *
 * Callers require the admin role first; the registry runs with every zone.
 */

const nf = new Intl.NumberFormat("en-IN");
const money = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const money2 = (n: number) => "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dayLabel = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });

export function defaultRange(): { from: string; to: string } {
  const to = istDay();
  const d = new Date(`${to}T00:00:00Z`);
  const from = new Date(d.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

function format(type: string, v: ReportCell): string | number {
  if (v === null || v === undefined || v === "") return "—";
  switch (type) {
    case "money": return typeof v === "number" ? v : Number(v) || 0;
    case "money2": return money2(Number(v) || 0);
    case "int": return typeof v === "number" ? v : Number(v) || 0;
    case "percent": return `${(Number(v) * 100).toFixed(1)}%`;
    case "minutes": return `${Number(v).toFixed(1)} min`;
    case "date": return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? dateFmt.format(new Date(`${v}T00:00:00+05:30`)) : String(v);
    case "datetime": return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? timeFmt.format(new Date(v)) : String(v);
    default: return String(v);
  }
}

function highlightText(type: string, v: ReportCell): string {
  if (v === null || v === undefined) return "—";
  if (type === "money") return money(Number(v));
  if (type === "int") return nf.format(Number(v));
  return String(format(type, v));
}

/** The registry payload → the admin page's table. */
export function toAdminResult(p: ReportPayload): ReportResult {
  const def = reportMeta(p.kind);
  const numeric = new Set(["money", "money2", "int", "percent", "minutes"]);
  const fmtRow = (r: ReportRow): Record<string, string | number> =>
    Object.fromEntries(p.columns.map((c) => [c.key, format(c.type, r[c.key] ?? null)]));
  const series: ReportDay[] = def.dayBased
    ? p.rows.map((r) => ({
        date: String(r.date),
        label: dayLabel.format(new Date(`${String(r.date)}T00:00:00Z`)),
        orders: Number(r.orders ?? 0) || 0,
        sales: Number(r.customerPaid ?? 0) || 0,
      }))
    : [];
  return {
    kind: p.kind,
    title: p.title,
    subtitle: p.subtitle,
    highlights: p.highlights.map((h) => ({ label: h.label, value: highlightText(h.type, h.value) })),
    series,
    table: {
      columns: p.columns.map((c) => ({ key: c.key, label: c.label, ...(numeric.has(c.type) ? { align: "right" as const } : {}), ...(c.type === "money" ? { money: true } : {}) })),
      rows: p.rows.map(fmtRow),
      ...(p.totals ? { totals: fmtRow(p.totals) } : {}),
    },
    empty: p.totalRows === 0,
    notes: p.notes,
    generatedAt: p.generatedAt,
  };
}

/**
 * Build one report for the admin console: every zone (or the one picked), finance columns shown,
 * the whole table (capped at 10 000 rows like every export).
 */
export async function buildReport(
  f: ReportFilters,
  admin: { id: string; name: string }
): Promise<ReportResult | { error: string }> {
  const kind = resolveKind(f.kind);
  if (!kind) return { error: "Unknown report." };
  const result = await runReport({
    kind,
    scope: { all: true },
    range: { from: f.from, to: f.to },
    zoneId: f.zoneId || null,
    vendorId: f.vendorId || null,
    riderId: f.riderId || null,
    status: f.status || null,
    payment: f.payment ?? "all",
    canSeeFinance: true,
    page: 1,
    pageSize: 200,
    all: true,
    generatedBy: admin,
  });
  if ("error" in result) {
    return { error: `This report has ${nf.format(result.rows)} rows — more than 10,000. Narrow the dates or pick a shop.` };
  }
  return toAdminResult(result);
}

/** Shops for the report filter. Name order, every status. */
export async function listReportVendors(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await createAdminClient().from("restaurants").select("id, name").order("name", { ascending: true }).limit(500);
  if (error) return [];
  return (data ?? []).map((r) => ({ id: r.id as string, name: ((r.name as string) ?? "").trim() || "Shop" }));
}

/** Riders for the report filter. Name order. */
export async function listReportRiders(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await createAdminClient().from("profiles").select("id, full_name").eq("role", "driver").order("full_name", { ascending: true }).limit(500);
  if (error) return [];
  return (data ?? []).map((r) => ({ id: r.id as string, name: ((r.full_name as string | null) ?? "").trim() || "Rider" }));
}
