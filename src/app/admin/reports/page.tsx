import { requireRole } from "@/lib/auth";
import {
  Empty,
  Figure,
  FigureRow,
  PageHeader,
  Panel,
  Section,
  SectionCol,
  SectionRow,
} from "@/components/admin/console";
import { ConsoleOnly } from "@/components/admin/console-only";
import { TrendChart } from "@/components/admin/charts/lazy";
import { DataTable, type Column } from "@/components/admin/data-table";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  buildReport,
  defaultRange,
  listReportRiders,
  listReportVendors,
  REPORT_KINDS,
  type PaymentFilter,
} from "@/lib/data-access/admin-reports";
import { reportMeta, resolveKind, type ReportKindId } from "@/lib/reports/definitions";
import type { DailyPoint } from "@/lib/data-access/admin-series";
import { listCitiesWithZones } from "@/lib/data-access/zones";
import { ReportFilters } from "./report-filters";
import { ReportExport } from "./report-export";

/**
 * Admin → Reports. A report workspace: pick the report, pick the window, read
 * the shape, read the figures, read the rows, take the file away.
 *
 * The report registry's fourteen reports (the twelve of §13, the date-wise
 * finance report and the average order), one screen, one set of filters — the
 * same registry the Manager app runs, so an admin report and a manager report
 * of the same orders agree to the rupee. Every money figure comes from the
 * scoped SQL rollups (0157, 0158) that mirror `src/lib/metrics` and the
 * settlement arithmetic.
 *
 * ## The charts
 *
 * Two, and both plot the report's *own* rows: `buildReport` returns the daily
 * series alongside the table, built from the same set of orders after the same
 * vendor and payment filters. A chart fetched separately would answer a
 * slightly different question, and a chart that disagrees with the table under
 * it is worse than no chart at all — one of them is wrong and the reader has no
 * way to tell which.
 *
 * Revenue leads because every one of these reports is ultimately about money;
 * order volume rides beside it, because "was that a big day or a busy day" is
 * the first question anyone asks of a revenue line.
 *
 * The settlement report draws neither. It is grouped by payout rather than by
 * day, so a daily line beneath it would be a picture of something the table is
 * not about. A range too long to plot legibly likewise returns no series, and
 * the section says so rather than drawing six hundred points.
 *
 * ## What a phone gets
 *
 * The figures and the rows, not the charts and not the exports. Reading last
 * week's takings on the way to a shop is a real thing an operator does, so
 * nothing read-only is taken away; the table goes through `DataTable`, which
 * stacks into cards below the console breakpoint instead of scrolling a 640px
 * slab sideways in a 370px column.
 *
 * The Excel and Save-as-PDF buttons are console-only. An .xlsx that lands in a
 * phone's downloads folder is not a file anybody is going to do anything with,
 * and "Save as PDF" is a desktop print dialogue. That is a presentation
 * decision like every other `ConsoleOnly`: the report data is admin-gated
 * server-side and none of that changes.
 */
export const dynamic = "force-dynamic";

const money = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

/** A report's rows are shaped by its kind, so the columns are built per report. */
type ReportRow = Record<string, string | number>;

function cellValue(row: ReportRow, key: string, isMoney?: boolean) {
  return isMoney ? money(Number(row[key]) || 0) : (row[key] ?? "—");
}

type ReportSearchParams = {
  kind?: string;
  from?: string;
  to?: string;
  vendor?: string;
  rider?: string;
  zone?: string;
  status?: string;
  payment?: string;
};

/** The report the URL asks for, with the defaults filled in; filters the kind does not take are dropped. */
function reportQuery(sp: ReportSearchParams) {
  const kind: ReportKindId = resolveKind(sp.kind) ?? "sales";
  const def = reportMeta(kind);
  const fallback = defaultRange();
  const from = sp.from || fallback.from;
  const to = sp.to || fallback.to;
  const vendorId = def.filters.includes("vendor") ? (sp.vendor ?? "") : "";
  const riderId = def.filters.includes("rider") ? (sp.rider ?? "") : "";
  const zoneId = def.filters.includes("zone") && /^[0-9a-f-]{36}$/i.test(sp.zone ?? "") ? (sp.zone as string) : "";
  const status = def.statusOptions.some((s) => s.value === sp.status) ? (sp.status as string) : "";
  const payment: PaymentFilter =
    def.filters.includes("payment") && (sp.payment === "cod" || sp.payment === "online") ? sp.payment : "all";
  return { kind, from, to, vendorId, riderId, zoneId, status, payment };
}

export default async function ReportsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<ReportSearchParams>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  const admin = await requireRole("admin");

  const { kind, from, to, vendorId, riderId, zoneId, status, payment } = reportQuery(await searchParams);

  if (!isSupabaseConfigured) {
    return (
      <PageHeader
        title="Reports"
        description="Connect Supabase to build reports."
      />
    );
  }

  const [vendors, riders, zones] = await Promise.all([
    listReportVendors().catch(() => []),
    listReportRiders().catch(() => []),
    listCitiesWithZones()
      .then((cs) => cs.flatMap((c) => c.zones.map((z) => ({ id: z.id, name: cs.length > 1 ? `${c.name} · ${z.name}` : z.name }))))
      .catch(() => [] as { id: string; name: string }[]),
  ]);
  const result = await buildReport(
    {
      kind,
      from,
      to,
      vendorId: vendorId || undefined,
      riderId: riderId || undefined,
      zoneId: zoneId || undefined,
      status: status || undefined,
      payment,
    },
    { id: admin.id, name: admin.full_name?.trim() || "Admin" }
  ).catch(() => ({
    error: "Could not build that report. Try a shorter date range.",
  }));

  const error = "error" in result ? result.error : null;
  const report = "error" in result ? null : result;
  const blurb = REPORT_KINDS.find((r) => r.value === kind)?.blurb ?? "";

  // `TrendChart` plots `DailyPoint`, whose money field is named for the
  // dashboard's vocabulary. Same number, different word.
  const series: DailyPoint[] =
    report?.series.map((d) => ({
      date: d.date,
      label: d.label,
      orders: d.orders,
      gmv: d.sales,
    })) ?? [];

  const plottable = series.length > 0 && !report?.empty;

  return (
    <>
      <PageHeader title="Reports" description={blurb} />

      <ReportFilters
        vendors={vendors}
        riders={riders}
        zones={zones}
        zoneId={zoneId}
        kind={kind}
        from={from}
        to={to}
        vendorId={vendorId}
        riderId={riderId}
        status={status}
        payment={payment}
      />

      {error ? (
        <p className="rounded-[var(--c-r)] border border-deal/30 bg-deal-soft px-3.5 py-2.5 text-[12.5px] text-deal">
          {error}
        </p>
      ) : null}

      {report ? (
        <>
          {/* The printed page needs its own heading: the console chrome is
              hidden by print CSS, so without this a saved PDF is a table with
              no idea what it is a table of. */}
          <Section
            flush
            title={report.title}
            meta={report.subtitle}
            actions={
              <ConsoleOnly tool="Exporting a report" notice={false}>
                <ReportExport report={report} />
              </ConsoleOnly>
            }
          >
            {report.notes.map((n) => (
              <p key={n} className="text-[12.5px] text-muted">{n}</p>
            ))}
            {report.empty ? (
              <Empty>
                Nothing to report for these dates. Try a wider range, or a
                different shop.
              </Empty>
            ) : (
              <FigureRow>
                {report.highlights.map((h) => (
                  <Figure
                    key={h.label}
                    label={h.label}
                    value={h.value}
                    note={h.note}
                  />
                ))}
              </FigureRow>
            )}
          </Section>

          {plottable ? (
            // Console-only, and lazily loaded with it: the figures above cover
            // the same window and are the part worth reading on a phone, and a
            // 90-day plot in a 370px column costs a charting library to draw
            // something illegible.
            <ConsoleOnly
              tool="The report charts"
              why="The figures above cover the same window, and the table below has every day in it."
            >
              <SectionRow>
                <SectionCol grow={1.7} basis={420}>
                  <Panel
                    title="Revenue over time"
                    meta="what customers paid, per day"
                  >
                    <div className="h-[210px]">
                      <TrendChart days={series} metric="revenue" />
                    </div>
                  </Panel>
                </SectionCol>
                <SectionCol basis={300}>
                  <Panel title="Orders over time" meta="per day">
                    <div className="h-[210px]">
                      {/* No volume backdrop: this chart *is* the volume, and
                          drawing it twice reads as two series. */}
                      <TrendChart
                        days={series}
                        metric="orders"
                        showVolume={false}
                      />
                    </div>
                  </Panel>
                </SectionCol>
              </SectionRow>
            </ConsoleOnly>
          ) : null}

          {report.empty ? null : (
            <Section title="Detail" meta={`${report.table.rows.length} rows`}>
              <DataTable<ReportRow>
                caption={report.title}
                columns={report.table.columns.map((c, i): Column<ReportRow> => ({
                  key: c.key,
                  header: c.label,
                  align: c.align,
                  // The first column names the row; in a card it is the
                  // headline, and every other column becomes a labelled line.
                  role: i === 0 ? "title" : undefined,
                  cell: (row) => cellValue(row, c.key, c.money),
                }))}
                // Keyed by position: a report's first column is a date, a shop
                // name or an order code depending on the kind, and only some of
                // those are unique.
                rows={report.table.rows.map((row, i) => ({ ...row, __row: i }))}
                rowKey={(row) => String(row.__row)}
                minWidth={640}
                dense
                totals={
                  report.table.totals
                    ? {
                        // Only columns the report actually totals. A cell left
                        // out lets DataTable put its "Total" label in the first
                        // column, where an em-dash would otherwise sit.
                        cells: Object.fromEntries(
                          report.table.columns
                            .filter(
                              (c) => report.table.totals?.[c.key] !== undefined
                            )
                            .map((c) => [
                              c.key,
                              cellValue(report.table.totals!, c.key, c.money),
                            ])
                        ),
                      }
                    : undefined
                }
              />
            </Section>
          )}
        </>
      ) : null}
    </>
  );
}
