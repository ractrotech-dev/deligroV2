"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, FileText, Loader2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldCls, labelCls } from "@/components/ui/field";
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

const LABEL: Record<string, string> = Object.fromEntries(
  DOC_TYPES.map((d) => [d.value, d.label])
);

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

export function DocumentsManager({
  restaurantId,
  documents,
}: Readonly<{
  restaurantId: string;
  documents: VendorDocument[];
}>) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<string>("fssai");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("docType", docType);
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
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const remove = (doc: VendorDocument) => {
    if (!window.confirm(`Delete ${doc.fileName}?`)) return;
    start(async () => {
      const res = await deleteDocumentAction(restaurantId, doc.id);
      if (!res.ok && res.error) window.alert(res.error);
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <div className="card space-y-3 p-4">
        <p className={labelCls}>Upload document</p>
        <select
          className={fieldCls}
          value={docType}
          onChange={(e) => setDocType(e.target.value)}
        >
          {DOC_TYPES.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          onChange={onFile}
          className="hidden"
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Upload className="size-4" />
          )}
          {uploading ? "Uploading…" : "Choose file"}
        </Button>
        <p className="text-[11px] text-muted">
          JPG, PNG, WebP or PDF · up to 10 MB.
        </p>
        {error ? (
          <p className="rounded-[var(--c-r)] border border-deal/30 bg-deal/10 px-3 py-2 text-sm font-medium text-deal">
            {error}
          </p>
        ) : null}
      </div>

      {documents.length === 0 ? (
        <p className="rounded-[var(--c-r)] border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
          No documents uploaded yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {documents.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center gap-3 rounded-[var(--c-r)] border border-line bg-surface p-3"
            >
              <div className="grid size-10 shrink-0 place-items-center rounded-[var(--c-r)] bg-accent-soft text-accent">
                <FileText className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {LABEL[doc.docType] ?? doc.docType}
                </p>
                <p className="truncate text-[11px] text-muted">
                  {doc.fileName} · {dateFmt.format(new Date(doc.createdAt))}
                </p>
              </div>
              {doc.url ? (
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-muted hover:text-ink"
                  aria-label="Open document"
                >
                  <Download className="size-4" />
                </a>
              ) : null}
              {/* Silent: a notice per row would be absurd, and the one above
                  already says removing documents is console work. */}
              <button
                type="button"
                onClick={() => remove(doc)}
                disabled={pending}
                className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-muted hover:text-deal"
                aria-label="Delete document"
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
