"use client";

import { useRef, useState, useTransition } from "react";
import { StatusText } from "@/components/admin/console";
import { useRouter } from "next/navigation";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BulkMenuItem } from "@/lib/data-access/admin-menu";
import { bulkInsertMenuItemsAction } from "./manage-actions";

/** Template column order. Also the keys we read back from an uploaded sheet. */
const COLUMNS = [
  "Name",
  "Category",
  "Description",
  "Price",
  "Discount Price",
  "Veg (Yes/No)",
  "Available (Yes/No)",
];

interface ParsedRow {
  n: number;
  data: BulkMenuItem;
  errors: string[];
}

function truthy(v: unknown, fallback = true): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return fallback;
  return /^(y|yes|true|1|veg|available|on)$/.test(s);
}

function toNumber(v: unknown): number | null {
  const s = String(v ?? "").replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function ExcelImport({
  restaurantId,
  categories,
}: {
  restaurantId: string;
  categories: string[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const validCount = rows?.filter((r) => r.errors.length === 0).length ?? 0;

  async function downloadTemplate() {
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.aoa_to_sheet([
      COLUMNS,
      ["Paneer Tikka", categories[0] ?? "Starters", "Char-grilled", 220, 199, "Yes", "Yes"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Menu");
    XLSX.writeFile(wb, "menu-template.xlsx");
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setNote(null);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      });

      const parsed: ParsedRow[] = raw.map((r, i) => {
        const name = String(r["Name"] ?? "").trim();
        const price = toNumber(r["Price"]);
        const discount = toNumber(r["Discount Price"]);
        const errors: string[] = [];
        if (!name) errors.push("Name is required");
        if (price == null || price < 0) errors.push("Price must be a number ≥ 0");
        if (discount != null && discount < 0) errors.push("Discount must be ≥ 0");
        const catRaw = String(r["Category"] ?? "").trim();
        return {
          n: i + 2, // +2: header row is row 1
          data: {
            name,
            category: catRaw || null,
            description: String(r["Description"] ?? "").trim() || null,
            price: price ?? 0,
            discountPrice: discount,
            veg: truthy(r["Veg (Yes/No)"], true),
            available: truthy(r["Available (Yes/No)"], true),
          },
          errors,
        };
      });

      setRows(parsed);
      if (parsed.length === 0) setNote("That sheet has no rows.");
    } catch {
      setNote("Couldn't read that file. Use the .xlsx template.");
      setRows(null);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function importValid() {
    if (!rows) return;
    const valid = rows.filter((r) => r.errors.length === 0).map((r) => r.data);
    if (valid.length === 0) {
      setNote("No valid rows to import.");
      return;
    }
    start(async () => {
      const res = await bulkInsertMenuItemsAction(restaurantId, valid);
      if (!res.ok) {
        setNote(res.error ?? "Import failed.");
        return;
      }
      setNote(`Imported ${res.inserted ?? valid.length} items.`);
      setRows(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={downloadTemplate}>
          <Download className="size-4" /> Template
        </Button>
        <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
          <Upload className="size-4" /> Upload .xlsx
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={onFile}
          className="hidden"
        />
      </div>

      {note ? <p className="text-xs font-medium text-muted">{note}</p> : null}

      {rows && rows.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted">
              <span className="font-semibold text-ink">{validCount}</span> valid ·{" "}
              {rows.length - validCount} with errors
            </p>
            <Button size="sm" onClick={importValid} disabled={pending || validCount === 0}>
              <FileSpreadsheet className="size-4" />
              {pending ? "Importing…" : `Import ${validCount}`}
            </Button>
          </div>
          <div className="max-h-64 overflow-auto rounded-xl border border-line">
            <ul className="divide-y divide-line">
              {rows.map((r) => {
                const bad = r.errors.length > 0;
                return (
                  <li
                    key={r.n}
                    className={
                      "flex items-center gap-2 px-3 py-2 text-xs " +
                      (bad ? "bg-deal/5" : "")
                    }
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-ink">
                        {r.data.name || <span className="text-muted">(no name)</span>}
                      </p>
                      <p className="truncate text-muted">
                        ₹{r.data.price}
                        {r.data.category ? ` · ${r.data.category}` : ""} ·{" "}
                        {r.data.veg ? "Veg" : "Non-veg"}
                      </p>
                    </div>
                    {bad ? (
                      <span className="shrink-0 text-right text-[10px] font-semibold text-deal">
                        {r.errors.join(", ")}
                      </span>
                    ) : (
                      <StatusText tone="green" className="shrink-0">OK</StatusText>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
