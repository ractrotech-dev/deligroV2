"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalToShell } from "@/components/shared/portal-to-shell";
import { SheetImport } from "@/components/bulk/sheet-import";
import type { BulkOutcome } from "@/lib/bulk/outcome";

const ENDPOINT = "/api/vendor/menu/bulk";

async function run(file: File, mode: "preview" | "apply"): Promise<BulkOutcome | { error: string }> {
  const form = new FormData();
  form.set("file", file);
  form.set("mode", mode);
  try {
    const res = await fetch(ENDPOINT, { method: "POST", body: form });
    const json = (await res.json().catch(() => null)) as (BulkOutcome & { error?: string }) | null;
    if (!res.ok || !json) return { error: json?.error ?? "server_error" };
    return json;
  } catch {
    return { error: "server_error" };
  }
}

/** Bulk menu and stock upload for the shop's owner: Excel or CSV, previewed before it is saved. */
export function MenuImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  if (!open) return null;

  return (
    <PortalToShell>
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
        <div
          className="card flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl sm:max-h-[90vh] sm:rounded-2xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="menu-import-title"
        >
          <div className="flex items-center justify-between gap-3 border-b border-line p-4">
            <div>
              <h2 id="menu-import-title" className="text-lg font-bold">
                Bulk upload menu and stock
              </h2>
              <p className="mt-0.5 text-xs text-muted">Excel or CSV. You see every change before it is saved.</p>
            </div>
            <button type="button" onClick={onClose} className="press rounded-full p-2 text-muted" aria-label="Close">
              <X className="size-5" />
            </button>
          </div>

          <div className="overflow-y-auto p-4">
            <SheetImport
              run={run}
              menuUrl={(format) => `${ENDPOINT}?format=${format}`}
              templateUrl={(format) => `${ENDPOINT}?format=${format}&template=1`}
              onApplied={onImported}
            />
          </div>

          <div className="flex gap-2 border-t border-line p-4">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </PortalToShell>
  );
}
