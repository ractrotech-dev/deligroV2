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
}: Readonly<{
  value: string | null;
  onChange: (url: string | null) => void;
  label?: string;
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
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-accent-soft px-3.5 py-2 text-xs font-bold text-accent">
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
