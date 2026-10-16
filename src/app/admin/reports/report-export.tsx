"use client";

import { useState } from "react";
import { Download, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadBrandedWorkbook } from "@/lib/reports/xlsx";
import type { ReportResult } from "@/lib/reports/kinds";

/**
 * Getting a report out of the browser.
 *
 * Excel goes through the shared branded workbook builder (`@/lib/reports/xlsx`)
 * so this sheet and a settlement statement leave the building looking like the
 * same company sent them — masthead, title, period, generated-at.
 *
 * PDF goes through the browser's own print dialogue ("Save as PDF"), not a
 * bundled PDF library. That is a deliberate trade: a PDF renderer is ~300 KB of
 * JavaScript shipped to every admin, it would need its own table layout code,
 * and its output would drift from what this page shows. Print CSS renders the
 * page the reader is already looking at, paginates properly, and costs nothing.
 * The button says "Save as PDF" because that is the option the dialogue offers.
 */
export function ReportExport({ report }: Readonly<{ report: ReportResult }>) {
  const [busy, setBusy] = useState(false);

  const toExcel = async () => {
    setBusy(true);
    try {
      await downloadBrandedWorkbook({
        filename: `${report.kind}-report`,
        sheetName: "Report",
        title: report.title,
        subtitle: report.subtitle,
        // The figures the page leads with, restated in the file so a reader who
        // only ever sees the sheet gets the same headline as the screen.
        meta: report.highlights.map(
          (h) => [h.label, h.note ? `${h.value} (${h.note})` : h.value] as [
            string,
            string,
          ]
        ),
        columns: report.table.columns.map((c) => ({
          key: c.key,
          label: c.label,
        })),
        rows: report.table.rows,
        totals: report.table.totals ?? undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap gap-2 print:hidden">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={toExcel}
        disabled={busy}
      >
        <Download className="size-4" />
        {busy ? "Preparing…" : "Download Excel"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => window.print()}
      >
        <Printer className="size-4" /> Save as PDF
      </Button>
    </div>
  );
}
