"use client";

import { useRef, useState, useTransition } from "react";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BulkOutcome } from "@/lib/bulk/outcome";

type RunResult = BulkOutcome | { error: string };

const BAD_NEWS: Record<string, string> = {
  file_too_large: "That file is larger than 2 MB.",
  feature_off: "Menu import is switched off for this shop.",
  permission_denied: "You can't do this.",
  not_found: "That shop wasn't found.",
  bad_request: "That file couldn't be read. Use the template.",
  server_error: "Something went wrong. Try again.",
};

/** The plain sentence for an error code the API answers with. */
export function sheetErrorText(code: string): string {
  return BAD_NEWS[code] ?? "Something went wrong. Try again.";
}

const ACTION_LABEL = { create: "New", update: "Change", unchanged: "Same", error: "Problem" } as const;
const ACTION_TONE = {
  create: "text-green",
  update: "text-ink",
  unchanged: "text-muted",
  error: "text-red-500",
} as const;

/**
 * Upload a menu / stock sheet, see exactly what it would do, then apply it.
 * The same screen serves the admin console and the vendor site; each passes how
 * to talk to its own server (`run`) and where the sheets download from.
 */
export function SheetImport({
  run,
  menuUrl,
  templateUrl,
  onApplied,
  hint,
}: Readonly<{
  /** Sends the file to the server in `preview` or `apply` mode. */
  run: (file: File, mode: "preview" | "apply") => Promise<RunResult>;
  /** Download of the shop's current sheet, by format. */
  menuUrl: (format: "xlsx" | "csv") => string;
  /** Download of an empty template, by format. */
  templateUrl: (format: "xlsx" | "csv") => string;
  onApplied?: () => void;
  hint?: string;
}>) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const doneCount = outcome ? outcome.counts.create + outcome.counts.update : 0;
  const applied = outcome?.mode === "apply" ? outcome : null;

  function choose(picked: File) {
    setFile(picked);
    setOutcome(null);
    setError(null);
    start(async () => {
      const res = await run(picked, "preview");
      if ("error" in res) setError(sheetErrorText(res.error));
      else setOutcome(res);
    });
  }

  function apply() {
    if (!file) return;
    start(async () => {
      const res = await run(file, "apply");
      if ("error" in res) {
        setError(sheetErrorText(res.error));
        return;
      }
      setOutcome(res);
      onApplied?.();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        {hint ??
          "Download your menu as a sheet, change prices, stock or availability, add new rows, and upload it back. Columns you leave out are not touched, and an empty cell leaves the dish as it is."}
      </p>

      <div className="flex flex-wrap gap-2">
        <a className="press inline-flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs font-semibold" href={menuUrl("xlsx")}>
          <Download className="size-4" /> Current menu (Excel)
        </a>
        <a className="press inline-flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs font-semibold" href={menuUrl("csv")}>
          <Download className="size-4" /> CSV
        </a>
        <a className="press inline-flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs font-semibold" href={templateUrl("xlsx")}>
          <FileSpreadsheet className="size-4" /> Blank template
        </a>
        <Button type="button" size="sm" onClick={() => fileRef.current?.click()} disabled={pending}>
          <Upload className="size-4" /> Choose a file
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) choose(picked);
            e.target.value = "";
          }}
        />
      </div>

      {file ? (
        <p className="inline-flex items-center gap-2 text-xs text-muted">
          <FileSpreadsheet className="size-3.5" /> {file.name}
          {pending && !outcome ? " · reading…" : ""}
        </p>
      ) : null}

      {error ? <p className="text-sm text-red-500">{error}</p> : null}

      {outcome ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="font-semibold text-green">{outcome.counts.create} new</span>
            <span className="font-semibold text-ink">{outcome.counts.update} to change</span>
            <span className="text-muted">{outcome.counts.unchanged} same</span>
            <span className={outcome.counts.error > 0 ? "font-semibold text-red-500" : "text-muted"}>
              {outcome.counts.error} with problems
            </span>
          </div>

          {applied?.applied ? (
            <p className="text-sm font-semibold text-green">
              Done: {applied.applied.created} added, {applied.applied.updated} changed
              {applied.applied.failed > 0 ? `, ${applied.applied.failed} not saved` : ""}.
            </p>
          ) : null}
          {applied?.applied && applied.applied.errors.length > 0 ? (
            <ul className="space-y-0.5 text-xs text-red-500">
              {applied.applied.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}

          {outcome.ignoredColumns.length > 0 ? (
            <p className="text-xs text-muted">Not used here: {outcome.ignoredColumns.join(", ")}.</p>
          ) : null}
          {outcome.unknownColumns.length > 0 ? (
            <p className="text-xs text-muted">Ignored columns: {outcome.unknownColumns.join(", ")}.</p>
          ) : null}
          {outcome.issues.length > 0 ? (
            <ul className="max-h-28 space-y-1 overflow-y-auto rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-500">
              {outcome.issues.slice(0, 20).map((i, n) => (
                <li key={`${i.line}-${n}`}>
                  {i.line > 0 ? `Row ${i.line}: ` : ""}
                  {i.message}
                </li>
              ))}
            </ul>
          ) : null}

          {outcome.items.length > 0 ? (
            <div className="max-h-72 overflow-auto rounded-xl border border-line">
              <ul className="divide-y divide-line">
                {outcome.items
                  .filter((i) => i.action !== "unchanged")
                  .map((i) => (
                    <li key={i.line} className="flex items-start gap-3 px-3 py-2 text-xs">
                      <span className={`w-14 shrink-0 font-semibold ${ACTION_TONE[i.action]}`}>{ACTION_LABEL[i.action]}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold text-ink">
                          {i.name} <span className="font-normal text-muted">· row {i.line}</span>
                        </p>
                        <p className="text-muted">{i.message ?? i.changes.join(" · ")}</p>
                      </div>
                    </li>
                  ))}
              </ul>
              {outcome.moreItems > 0 ? <p className="border-t border-line px-3 py-2 text-[11px] text-muted">+{outcome.moreItems} more rows</p> : null}
            </div>
          ) : null}

          {outcome.mode === "preview" ? (
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={apply} disabled={pending || doneCount === 0}>
                {pending ? "Saving…" : doneCount === 0 ? "Nothing to apply" : `Apply ${doneCount} change${doneCount === 1 ? "" : "s"}`}
              </Button>
              {outcome.counts.error > 0 && doneCount > 0 ? <span className="text-xs text-muted">Rows with problems are skipped.</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
