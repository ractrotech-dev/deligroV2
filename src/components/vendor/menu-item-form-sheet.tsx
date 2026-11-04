"use client";

import { useRef, useState, useTransition } from "react";
import { ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalToShell } from "@/components/shared/portal-to-shell";
import {
  createMenuItemAction,
  updateMenuItemAction,
} from "@/app/vendor/actions";
import { createClient } from "@/lib/supabase/client";
import { FoodImagePicker } from "@/components/admin/food-image-picker";
import {
  searchVendorFoodImages,
  suggestVendorFoodImages,
  vendorFoodImageFromDrive,
} from "@/app/vendor/menu/actions";
import type { VendorMenuItem } from "@/lib/data-access/vendor-menu";
import { formatINR } from "@/lib/utils/format";

/**
 * The vendor-gated door onto the shared photo library. Same picker the admin
 * console uses; a different pair of Server Actions behind it, because a vendor
 * is not an admin (see the picker's ImageLibrarySource).
 */
const LIBRARY = {
  suggest: suggestVendorFoodImages,
  search: searchVendorFoodImages,
  fromDrive: vendorFoodImageFromDrive,
};

const INPUT =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export type MenuFormValues = {
  name: string;
  description: string;
  price: string;
  category: string;
  veg: boolean;
  available: boolean;
  popular: boolean;
  bestseller: boolean;
  imageUrl: string;
  externalId: string;
};

type MenuRow = VendorMenuItem;

const EMPTY: MenuFormValues = {
  name: "",
  description: "",
  price: "",
  category: "",
  veg: true,
  available: true,
  popular: false,
  bestseller: false,
  imageUrl: "",
  externalId: "",
};

function toFormValues(item?: MenuRow): MenuFormValues {
  if (!item) return { ...EMPTY };
  return {
    name: item.name,
    description: item.description ?? "",
    price: String(item.price),
    category: item.category,
    veg: item.veg,
    available: !item.soldOut,
    popular: Boolean(item.popular),
    bestseller: Boolean(item.bestseller),
    imageUrl: item.image ?? "",
    externalId: item.externalId ?? "",
  };
}

function formatAddedOn(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return null;
  }
}

async function uploadMenuImage(
  restaurantId: string,
  file: File
): Promise<string> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error("Use JPEG, PNG, or WebP.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error("Image must be under 2 MB.");
  }

  const ext =
    file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const path = `${restaurantId}/${crypto.randomUUID()}.${ext}`;
  const supabase = createClient();
  const { error } = await supabase.storage
    .from("menu-images")
    .upload(path, file, { cacheControl: "3600", upsert: false });
  if (error) throw error;

  const { data } = supabase.storage.from("menu-images").getPublicUrl(path);
  return data.publicUrl;
}

export function MenuItemFormSheet({
  open,
  mode,
  item,
  categories,
  restaurantId,
  onClose,
}: {
  open: boolean;
  mode: "create" | "edit";
  item?: MenuRow;
  categories: string[];
  restaurantId: string;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<MenuFormValues>(() => toFormValues(item));
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!open) return null;

  function set<K extends keyof MenuFormValues>(key: K, value: MenuFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function handlePickImage(file: File | undefined) {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const url = await uploadMenuImage(restaurantId, file);
      set("imageUrl", url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const price = Number(values.price);
    if (!values.name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setError("Enter a valid price in rupees.");
      return;
    }

    const payload = {
      name: values.name,
      description: values.description,
      price,
      category: values.category || "Popular",
      veg: values.veg,
      available: values.available,
      popular: values.popular,
      bestseller: values.bestseller,
      imageUrl: values.imageUrl,
      externalId: values.externalId.trim() || null,
    };

    startTransition(async () => {
      try {
        if (mode === "create") {
          await createMenuItemAction(payload);
        } else if (item) {
          await updateMenuItemAction(item.dbId, payload);
        }
        onClose();
      } catch {
        setError("Could not save item. Try again.");
      }
    });
  }

  return (
    <PortalToShell>
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
      <div
        className="card w-full max-w-lg max-h-[92dvh] overflow-y-auto rounded-t-2xl p-4 sm:rounded-2xl sm:max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="menu-form-title"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="menu-form-title" className="text-lg font-bold">
            {mode === "create" ? "Add menu item" : "Edit menu item"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="press rounded-full p-2 text-muted"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <section className="space-y-3">
            <p className="text-xs font-bold uppercase tracking-wider text-muted">
              Basics
            </p>
            <Field label="Name" required>
              <input
                value={values.name}
                onChange={(e) => set("name", e.target.value)}
                className={INPUT}
                placeholder="Paneer Butter Masala"
                required
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Category" required>
                <input
                  value={values.category}
                  onChange={(e) => set("category", e.target.value)}
                  className={INPUT}
                  list="menu-categories"
                  placeholder="Burgers"
                  required
                />
                <datalist id="menu-categories">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </Field>
              <Field label="Price (₹)" required>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={values.price}
                  onChange={(e) => set("price", e.target.value)}
                  className={INPUT}
                  placeholder="199"
                  required
                />
              </Field>
            </div>

            <Field label="Description">
              <textarea
                value={values.description}
                onChange={(e) => set("description", e.target.value)}
                className={`${INPUT} min-h-20 resize-y`}
                placeholder="Short description for customers"
              />
            </Field>

            <Field label="External ID (for CSV re-import)">
              <input
                value={values.externalId}
                onChange={(e) => set("externalId", e.target.value)}
                className={INPUT}
                placeholder="item-001"
              />
              <p className="mt-1 text-[11px] text-muted">
                Optional stable key — keep the same when re-importing a sheet.
              </p>
            </Field>

            {mode === "edit" && item ? (
              <div className="rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-xs text-muted">
                {formatAddedOn(item.createdAt) ? (
                  <p>
                    Added on{" "}
                    <span className="font-semibold text-ink">
                      {formatAddedOn(item.createdAt)}
                    </span>
                  </p>
                ) : null}
                <p className="mt-0.5">
                  Sold{" "}
                  <span className="text-data font-semibold text-ink">
                    {item.soldCount}
                  </span>{" "}
                  · revenue{" "}
                  <span className="text-data font-semibold text-ink">
                    {formatINR(item.soldRevenue)}
                  </span>
                </p>
              </div>
            ) : null}
          </section>

          <section className="space-y-3">
            <p className="text-xs font-bold uppercase tracking-wider text-muted">
              Photo
            </p>
            <div className="flex items-start gap-3">
              {values.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- vendor-supplied image URL, matches the app's <img> usage
                <img
                  src={values.imageUrl}
                  alt=""
                  className="size-20 rounded-xl object-cover"
                />
              ) : (
                <span className="grid size-20 place-items-center rounded-xl bg-surface-2 text-muted">
                  <ImagePlus className="size-6" />
                </span>
              )}
              <div className="min-w-0 flex-1 space-y-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    void handlePickImage(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? "Uploading…" : "Upload photo"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowLibrary((v) => !v)}
                >
                  Choose from storage
                </Button>
                {values.imageUrl ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => set("imageUrl", "")}
                  >
                    Remove
                  </Button>
                ) : null}
                <p className="text-[11px] text-muted">JPEG/PNG/WebP · max 2 MB</p>
              </div>
            </div>

            {/* The shared library. Opens on this dish's own name, so a wrongly
                matched photo is one tap from the right one — and searching
                "biryani" shows every kind so the correct variant can be picked
                rather than guessed at. */}
            {showLibrary ? (
              <FoodImagePicker
                dishName={values.name}
                current={
                  values.imageUrl
                    ? { imageUrl: values.imageUrl, libraryId: null }
                    : null
                }
                source={LIBRARY}
                onPick={(picked) => {
                  set("imageUrl", picked?.imageUrl ?? "");
                  setShowLibrary(false);
                }}
                onClose={() => setShowLibrary(false)}
              />
            ) : null}

            <Field label="Or paste image URL">
              <input
                value={values.imageUrl}
                onChange={(e) => set("imageUrl", e.target.value)}
                className={INPUT}
                placeholder="https://…"
              />
            </Field>
          </section>

          <section className="space-y-3">
            <p className="text-xs font-bold uppercase tracking-wider text-muted">
              Flags
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ToggleRow
                label="Vegetarian"
                checked={values.veg}
                onChange={(v) => set("veg", v)}
              />
              <ToggleRow
                label="In stock"
                checked={values.available}
                onChange={(v) => set("available", v)}
              />
              <ToggleRow
                label="Popular"
                checked={values.popular}
                onChange={(v) => set("popular", v)}
              />
              <ToggleRow
                label="Bestseller"
                checked={values.bestseller}
                onChange={(v) => set("bestseller", v)}
              />
            </div>
          </section>

          {error ? <p className="text-sm text-red-500">{error}</p> : null}

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={pending || uploading}
            >
              {pending
                ? "Saving…"
                : mode === "create"
                  ? "Add item"
                  : "Save changes"}
            </Button>
          </div>
        </form>
      </div>
    </div>
    </PortalToShell>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-label">
        {label}
        {required ? " *" : ""}
      </span>
      {children}
    </label>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[var(--accent)]"
      />
    </label>
  );
}
