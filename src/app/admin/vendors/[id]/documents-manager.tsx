"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { StatusText } from "@/components/admin/console";
import { DataTable, type Column } from "@/components/admin/data-table";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { VendorDocument } from "@/lib/data-access/vendor-documents";
import { deleteDocumentAction } from "./manage-actions";

const DOC_TYPES = [
  { value: "fssai", label: "FSSAI certificate" },
  { value: "gst", label: "GST certificate" },
  { value: "pan", label: "PAN card" },
  { value: "shop_license", label: "Shop licence" },
  { value: "bank_proof", label: "Bank proof" },
  { value: "other", label: "Other" },
] as const;

const ERR: Record<string, string> = {
  invalid_type: "Only JPG, PNG, WebP or PDF files are allowed.",
  too_large: "File is too large (max 10 MB).",
  backend_not_configured: "Connect Supabase to upload documents.",
};

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

/** One line of the checklist: a file, or a type with nothing uploaded yet. */
interface DocRow {
  key: string;
  type: string;
  label: string;
  /** Only the first line of a type names it, so several files read as one group. */
  first: boolean;
  doc: VendorDocument | null;
}

function checklist(documents: VendorDocument[]): DocRow[] {
  return DOC_TYPES.flatMap((t): DocRow[] => {
    const files = documents.filter((d) => d.docType === t.value);
    if (files.length === 0) return [{ key: t.value, type: t.value, label: t.label, first: true, doc: null }];
    return files.map((doc, i) => ({ key: doc.id, type: t.value, label: t.label, first: i === 0, doc }));
  });
}

/**
 * What this shop has on file and what is still missing, one row per kind of
 * document. Each row uploads its own kind, so the type can't be picked wrongly.
 */
export function DocumentsManager({
  restaurantId,
  documents,
}: Readonly<{
  restaurantId: string;
  documents: VendorDocument[];
}>) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const chosenType = useRef<string>("fssai");
  const [uploadingType, setUploadingType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<VendorDocument | null>(null);
  const [pending, start] = useTransition();

  const pick = (type: string) => {
    chosenType.current = type;
    fileRef.current?.click();
  };

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const type = chosenType.current;
    setError(null);
    setUploadingType(type);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("docType", type);
      const res = await fetch(`/api/admin/vendors/${restaurantId}/documents`, {
        method: "POST",
        body: fd,
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setError(ERR[json.error ?? ""] ?? "Upload failed. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Upload failed. Try again.");
    } finally {
      setUploadingType(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const remove = () =>
    start(async () => {
      if (!deleting) return;
      setError(null);
      const res = await deleteDocumentAction(restaurantId, deleting.id);
      setDeleting(null);
      if (!res.ok && res.error) setError(res.error);
      router.refresh();
    });

  const columns: Column<DocRow>[] = [
    {
      key: "document",
      header: "Document",
      width: "w-[220px]",
      cell: (r) => (r.first ? <span className="text-[13px] font-semibold text-ink">{r.label}</span> : null),
    },
    {
      key: "status",
      header: "Status",
      width: "w-[150px]",
      cell: (r) => (
        <StatusText tone={r.doc ? "green" : "neutral"}>{r.doc ? "Uploaded" : "Not uploaded"}</StatusText>
      ),
    },
    {
      key: "file",
      header: "File",
      cell: (r) =>
        r.doc ? (
          <span className="block max-w-[420px] truncate text-[12.5px] text-muted" title={r.doc.fileName}>
            {r.doc.fileName}
          </span>
        ) : (
          <span className="text-[12.5px] text-muted">—</span>
        ),
    },
    {
      key: "date",
      header: "Added",
      width: "w-[120px]",
      cell: (r) => (
        <span className="text-data text-[12.5px] text-muted">{r.doc ? dateFmt.format(new Date(r.doc.createdAt)) : "—"}</span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "w-[240px]",
      cell: (r) => (
        <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
          {r.doc?.url ? (
            <a href={r.doc.url} target="_blank" rel="noopener noreferrer" className="c-btn-quiet">
              Open
            </a>
          ) : null}
          {r.doc ? (
            <button
              type="button"
              onClick={() => setDeleting(r.doc)}
              disabled={pending}
              className="c-btn-quiet hover:text-deal disabled:opacity-50"
            >
              Delete
            </button>
          ) : null}
          {r.first ? (
            <button
              type="button"
              onClick={() => pick(r.type)}
              disabled={uploadingType !== null}
              aria-label={`Upload ${r.label}`}
              className="c-btn c-btn-outline disabled:opacity-50"
            >
              {uploadingType === r.type ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              {uploadingType === r.type ? "Uploading…" : r.doc ? "Add file" : "Upload"}
            </button>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13.5px] font-semibold text-ink">Documents</h2>
        <span className="text-[12px] text-muted">JPG, PNG, WebP or PDF, up to 10 MB</span>
      </div>
      {error ? (
        <p role="alert" className="text-[12.5px] font-medium text-deal">
          {error}
        </p>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        onChange={onFile}
        aria-label="Choose a document file"
        className="hidden"
      />
      <DataTable caption="Documents" columns={columns} rows={checklist(documents)} rowKey={(r) => r.key} />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this document?"
        message={deleting ? `${deleting.fileName} will be removed from this shop.` : null}
        confirmLabel="Delete"
        danger
        busy={pending}
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
