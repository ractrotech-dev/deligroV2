"use client";

import { useState } from "react";
import Image from "next/image";
import { ImageIcon, Loader2, Upload } from "lucide-react";
import { labelCls } from "@/components/ui/field";

function uploadError(code: unknown): string {
  if (code === "too_large") return "Image is too large (max 5 MB).";
  if (code === "invalid_type") return "Use a JPG, PNG or WebP image.";
  return "Upload failed. Try again.";
}

/**
 * Pick a shop's photo: uploads to the public shop bucket (POST
 * /api/admin/vendors/logo, admin only) and hands the URL back. The add-shop wizard
 * and the shop edit page both use this one.
 */
export function ShopPhotoUpload({
  value,
  onChange,
  label = "Shop photo",
  tile = false,
}: Readonly<{
  value: string | null;
  onChange: (url: string | null) => void;
  label?: string;
  /** The photo itself is the upload button, for a tight desktop form. */
  tile?: boolean;
}>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/admin/vendors/logo", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok || !json.url) {
        setError(uploadError(json.error));
        return;
      }
      onChange(json.url);
    } catch {
      setError("Upload failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (tile) {
    return (
      <div className="w-[116px] space-y-1.5">
        <label
          title={value ? "Replace photo" : "Upload photo"}
          className="group relative grid size-[116px] cursor-pointer place-items-center overflow-hidden rounded-[var(--c-r)] border border-dashed border-line bg-surface-2 text-muted transition-colors hover:border-accent hover:text-ink"
        >
          {value ? (
            <Image src={value} alt="Shop photo" width={116} height={116} className="size-full object-cover" unoptimized />
          ) : (
            <span className="flex flex-col items-center gap-1 text-[11.5px] font-semibold">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              Add photo
            </span>
          )}
          {value ? (
            <span className="absolute inset-x-0 bottom-0 bg-black/60 py-1 text-center text-[11px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
              {busy ? "Uploading…" : "Replace"}
            </span>
          ) : null}
          <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={onFile} disabled={busy} />
        </label>
        {error ? (
          <p className="text-[11px] font-medium text-deal">{error}</p>
        ) : value ? (
          <button type="button" onClick={() => onChange(null)} className="text-[11.5px] font-semibold text-muted hover:text-deal">
            Remove
          </button>
        ) : (
          <p className="text-[11px] leading-snug text-muted">JPG, PNG or WebP, up to 5 MB</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <span className={labelCls}>{label}</span>
      <div className="flex items-center gap-3">
        <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-[var(--c-r)] bg-surface-2 text-muted">
          {value ? (
            <Image src={value} alt="Photo preview" width={64} height={64} className="size-16 object-cover" unoptimized />
          ) : (
            <ImageIcon className="size-6" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <label className="c-btn c-btn-outline cursor-pointer">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            {value ? "Replace" : "Upload"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={onFile}
              disabled={busy}
            />
          </label>
          {value ? (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="ml-2 text-xs font-semibold text-muted hover:text-deal"
            >
              Remove
            </button>
          ) : null}
          <p className="mt-1 text-[11px] text-muted">JPG, PNG or WebP · up to 5 MB.</p>
        </div>
      </div>
      {error ? <p className="text-xs font-medium text-deal">{error}</p> : null}
    </div>
  );
}
