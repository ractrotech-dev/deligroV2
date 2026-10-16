"use client";

/**
 * One branded workbook builder for every table the console exports.
 *
 * Written once rather than per screen because an exported sheet leaves the
 * building: it goes to an accountant, a vendor, or into somebody's records, and
 * three screens each rolling their own header is how you end up with three
 * different-looking documents all claiming to be from the same company.
 *
 * **What "branded" can and cannot mean here.** SheetJS's community build — the
 * one this project carries, pinned to the CDN tarball because the npm channel
 * is abandoned (see docs/SECURITY_AUDIT.md, H-3) — writes values, column widths
 * and merges, but it silently drops cell styles: no bold, no fills, no logo.
 * So the badging is the masthead block, the document title, the period it
 * covers and the generated-at stamp, laid out in merged cells at the top of
 * every sheet. That is real, checkable provenance on the page. Anything
 * promising colour would need SheetJS Pro or a different writer, and quietly
 * shipping an unstyled sheet that the code claims is styled is worse than
 * saying so here.
 *
 * Numbers are written as numbers, never as pre-formatted "₹1,234" strings —
 * a currency string in a spreadsheet is a value nobody can sum, which defeats
 * the reason the export exists.
 */

const BRAND = {
  name: "DELIGRO",
  tagline: "Food delivery · Ops console",
} as const;

export interface SheetColumn {
  key: string;
  label: string;
}

export type CellValue = string | number | null | undefined;

const stamp = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

/**
 * Build and download a branded .xlsx.
 *
 * `meta` is the provenance block — vendor, period, filters. Pass whatever
 * identifies this particular run; an export whose own header does not say what
 * it covers is one nobody can file.
 */
export async function downloadBrandedWorkbook(opts: {
  /** Without the extension; the date is appended. */
  filename: string;
  sheetName?: string;
  title: string;
  subtitle?: string;
  meta?: [string, CellValue][];
  columns: SheetColumn[];
  rows: Record<string, CellValue>[];
  /** A totals line, keyed by column, written under the body. */
  totals?: Record<string, CellValue>;
}): Promise<void> {
  // On demand: SheetJS is large and most reports are read on screen and never
  // exported.
  const XLSX = await import("xlsx");

  const width = Math.max(opts.columns.length, 2);
  const header = opts.columns.map((c) => c.label);
  const body = opts.rows.map((row) => opts.columns.map((c) => row[c.key] ?? ""));

  const masthead: CellValue[][] = [
    [BRAND.name],
    [BRAND.tagline],
    [],
    [opts.title],
  ];
  if (opts.subtitle) masthead.push([opts.subtitle]);
  for (const [label, value] of opts.meta ?? []) {
    masthead.push([`${label}:`, value ?? "—"]);
  }
  masthead.push([`Generated:`, stamp.format(new Date())]);
  masthead.push([]);

  const aoa: CellValue[][] = [...masthead, header, ...body];
  if (opts.totals) {
    aoa.push(opts.columns.map((c) => opts.totals![c.key] ?? ""));
  }

  const sheet = XLSX.utils.aoa_to_sheet(aoa);

  // Merge the masthead lines across the table so they read as a header block
  // rather than as stray values in column A.
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] =
    [];
  const titleRows = opts.subtitle ? [0, 1, 3, 4] : [0, 1, 3];
  for (const r of titleRows) {
    merges.push({ s: { r, c: 0 }, e: { r, c: width - 1 } });
  }
  sheet["!merges"] = merges;

  // Widths from the longest cell in each column, so nothing opens as "#####".
  sheet["!cols"] = opts.columns.map((c, i) => ({
    wch: Math.min(
      44,
      Math.max(
        c.label.length + 2,
        ...body.map((r) => String(r[i] ?? "").length + 2),
        12
      )
    ),
  }));

  // A filter on the header row, so a two-hundred-order statement can be cut by
  // vendor or payment method in the reader's own spreadsheet. Frozen panes are
  // deliberately not attempted: the community build has no worksheet-view
  // support, and setting `!freeze` would be a line of code that looks like it
  // works and does nothing.
  if (body.length > 0) {
    const headerRow = masthead.length;
    sheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: headerRow, c: 0 },
        e: { r: headerRow + body.length, c: width - 1 },
      }),
    };
  }

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, opts.sheetName ?? "Report");
  XLSX.writeFile(
    book,
    `${opts.filename}-${new Date().toISOString().slice(0, 10)}.xlsx`
  );
}
