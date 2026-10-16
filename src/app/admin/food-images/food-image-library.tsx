"use client";

import { useRef, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Search, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldCls, labelCls } from "@/components/ui/field";
import {
  deleteFoodImageAction,
  updateFoodImageAction,
} from "./actions";
import { BulkUploadCard } from "./bulk-upload-card";
import type { FoodImage } from "@/lib/data-access/food-images";

/**
 * The library grid: upload, search, rename, delete.
 *
 * Search is a form GET rather than a live fetch — this page is server-rendered
 * and the URL is worth keeping shareable, and the ranking that decides the
 * order runs on the server anyway. The picker inside the menu editor is the
 * one that searches as you type, because that is a modal you are standing in.
 */
export function FoodImageLibrary({
  images,
  query,
  disabled,
}: Readonly<{
  images: FoodImage[];
  query: string;
  /** Migration 0035 not applied — show the grid but refuse writes. */
  disabled: boolean;
}>) {
  const router = useRouter();
  const [editing, setEditing] = useState<FoodImage | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const remove = (image: FoodImage) => {
    if (
      !window.confirm(
        `Delete the photo “${image.title}”?\n\nShops already using it keep the picture they have.`
      )
    ) {
      return;
    }
    start(async () => {
      const res = await deleteFoodImageAction(image.id);
      setError(res.ok ? null : (res.error ?? "Couldn't delete that photo."));
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <BulkUploadCard disabled={disabled} />
      <UploadCard disabled={disabled} />

      {error ? (
        <p className="rounded-xl border border-deal/30 bg-deal/10 px-3.5 py-3 text-sm font-medium text-deal">
          {error}
        </p>
      ) : null}

      <form action="/admin/storage" className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input
          name="q"
          defaultValue={query}
          placeholder="Search photos — “biryani” shows every kind"
          className={`${fieldCls} pl-9`}
        />
      </form>

      {editing ? (
        <EditCard
          image={editing}
          onDone={() => {
            setEditing(null);
            router.refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {images.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface-2 px-3.5 py-8 text-center text-sm text-muted">
          {query
            ? `No photos found for “${query}”.`
            : "No food photos yet. Upload one above — name it the way it appears on a menu."}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 @xl:grid-cols-3 @4xl:grid-cols-4">
          {images.map((image) => (
            <li
              key={image.id}
              className="overflow-hidden rounded-xl border border-line bg-surface"
            >
              <div className="relative aspect-[4/3] bg-surface-2">
                <Image
                  src={image.imageUrl}
                  alt={image.title}
                  fill
                  sizes="240px"
                  unoptimized
                  className="object-cover"
                />
                {image.veg !== null ? (
                  <span
                    className={
                      "absolute left-1.5 top-1.5 size-3 rounded-full ring-2 ring-white " +
                      (image.veg ? "bg-green" : "bg-deal")
                    }
                    aria-label={image.veg ? "Vegetarian" : "Non-vegetarian"}
                  />
                ) : null}
              </div>
              <div className="space-y-1 p-2.5">
                <p className="truncate text-[13px] font-semibold text-ink">
                  {image.title}
                </p>
                <p className="truncate text-[10.5px] text-muted">
                  {image.keywords.join(" · ")}
                </p>
                <div className="flex gap-1 pt-1">
                  <button
                    type="button"
                    disabled={disabled || pending}
                    onClick={() => setEditing(image)}
                    className="press grid size-8 place-items-center rounded-full bg-surface-2 text-muted hover:text-ink disabled:opacity-40"
                    aria-label={`Rename ${image.title}`}
                  >
                    <Pencil className="size-4" />
                  </button>
                  <button
                    type="button"
                    disabled={disabled || pending}
                    onClick={() => remove(image)}
                    className="press grid size-8 place-items-center rounded-full bg-surface-2 text-muted hover:text-deal disabled:opacity-40"
                    aria-label={`Delete ${image.title}`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Add one photo to the library, named as a menu would write it.
 *
 * Kept alongside the folder upload rather than folded into it: this is the path
 * where the operator states the name, the alternate spellings and the diet flag
 * deliberately, and a batch review row is the wrong place to ask for all three.
 */
function UploadCard({ disabled }: Readonly<{ disabled: boolean }>) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [veg, setVeg] = useState<"auto" | "veg" | "nonveg">("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("title", title.trim());
      fd.set("tags", tags);
      fd.set("veg", veg === "auto" ? "" : veg);
      const res = await fetch("/api/admin/food-images", {
        method: "POST",
        body: fd,
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) {
        setError(data.message ?? "Couldn't upload that photo. Try again.");
        return;
      }
      setDone(`“${title.trim()}” added to the library.`);
      setTitle("");
      setTags("");
      setVeg("auto");
      router.refresh();
    } catch {
      setError("Couldn't upload that photo. Check your connection.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="card space-y-3 p-4">
      <h2 className="text-heading text-[15px]">Add a single photo</h2>

      <label className="block space-y-1.5">
        <span className={labelCls}>
          Dish name <span className="text-deal">*</span>
        </span>
        <input
          className={fieldCls}
          value={title}
          disabled={disabled}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Chicken Biryani"
        />
        <span className="block text-[11px] leading-snug text-muted">
          Write it the way a menu would. “Chicken Biryani” and “Veg Biryani” are
          two different photos, and naming them properly is what keeps them
          apart.
        </span>
      </label>

      <div className="grid gap-3 @xl:grid-cols-2">
        <label className="block space-y-1.5">
          <span className={labelCls}>Other names (optional)</span>
          <input
            className={fieldCls}
            value={tags}
            disabled={disabled}
            onChange={(e) => setTags(e.target.value)}
            placeholder="murgh biryani, hyderabadi biryani"
          />
          <span className="block text-[11px] text-muted">
            Separate with commas. Helps shops that spell it differently.
          </span>
        </label>
        <label className="block space-y-1.5">
          <span className={labelCls}>Veg or non-veg</span>
          <select
            className={fieldCls}
            value={veg}
            disabled={disabled}
            onChange={(e) => setVeg(e.target.value as typeof veg)}
          >
            <option value="auto">Work it out from the name</option>
            <option value="veg">Vegetarian</option>
            <option value="nonveg">Non-vegetarian</option>
          </select>
        </label>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <Button
        type="button"
        size="sm"
        disabled={disabled || busy || !title.trim()}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? (
          <>
            <Loader2 className="size-4 animate-spin" /> Uploading…
          </>
        ) : (
          <>
            <Upload className="size-4" /> Choose a picture
          </>
        )}
      </Button>
      <p className="text-[11px] text-muted">JPG, PNG or WebP, up to 2 MB.</p>

      {error ? (
        <p className="rounded-xl border border-deal/30 bg-deal/10 px-3 py-2 text-[12.5px] font-medium text-deal">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="rounded-xl border border-green/30 bg-green/10 px-3 py-2 text-[12.5px] font-medium text-green">
          {done}
        </p>
      ) : null}
    </div>
  );
}

function EditCard({
  image,
  onDone,
  onCancel,
}: Readonly<{
  image: FoodImage;
  onDone: () => void;
  onCancel: () => void;
}>) {
  const [title, setTitle] = useState(image.title);
  const [tags, setTags] = useState(image.tags.join(", "));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const save = () =>
    start(async () => {
      const res = await updateFoodImageAction(image.id, {
        title,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      if (!res.ok) {
        setError(res.error ?? "Couldn't save.");
        return;
      }
      onDone();
    });

  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-heading text-[15px]">Rename photo</h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          className="press grid size-8 place-items-center rounded-full text-muted hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </div>
      <label className="block space-y-1.5">
        <span className={labelCls}>Dish name</span>
        <input
          className={fieldCls}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="block space-y-1.5">
        <span className={labelCls}>Other names</span>
        <input
          className={fieldCls}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </label>
      {error ? <p className="text-sm text-deal">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
