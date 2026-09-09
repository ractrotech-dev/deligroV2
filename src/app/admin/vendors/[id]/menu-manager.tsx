"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, fieldCls, labelCls } from "@/components/ui/field";
import {
  FoodImagePicker,
  type PickedImage,
} from "@/components/admin/food-image-picker";
import { DISH_CATEGORIES } from "@/lib/menu-categories";
import type { AdminMenuItem, MenuItemInput } from "@/lib/data-access/admin-menu";
import { ExcelImport } from "./excel-import";
import {
  searchFoodImagesAction,
  suggestFoodImagesAction,
} from "@/app/admin/food-images/actions";
import {
  createMenuItemAction,
  updateMenuItemAction,
  deleteMenuItemAction,
  setMenuAvailabilityAction,
  setMenuItemImageAction,
} from "./manage-actions";

/** The admin-gated door onto the shared photo library. */
const LIBRARY = {
  suggest: suggestFoodImagesAction,
  search: searchFoodImagesAction,
};

interface FormState {
  name: string;
  category: string;
  price: string;
  discountPrice: string;
  veg: boolean;
  available: boolean;
  description: string;
  /**
   * The item's existing picture, carried through the form untouched.
   *
   * It has to be here because the update writes every column: sending a fixed
   * `imageUrl: null` — which this form used to do — cleared the photo of any
   * item whose price or description was edited. That was quiet before, when
   * few items had photos; with pictures now attached automatically it would
   * blank them on the first edit.
   */
  imageUrl: string | null;
}

const EMPTY: FormState = {
  name: "",
  category: "",
  price: "",
  discountPrice: "",
  veg: true,
  available: true,
  description: "",
  imageUrl: null,
};

function toInput(f: FormState): MenuItemInput {
  return {
    name: f.name.trim(),
    category: f.category || null,
    description: f.description.trim() || null,
    price: Number(f.price) || 0,
    discountPrice: f.discountPrice.trim() ? Number(f.discountPrice) : null,
    veg: f.veg,
    available: f.available,
    imageUrl: f.imageUrl,
  };
}

export function MenuManager({
  restaurantId,
  items,
  categories,
}: {
  restaurantId: string;
  items: AdminMenuItem[];
  categories: string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  /** Which row has its photo picker open. One at a time. */
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const pickImage = (item: AdminMenuItem, picked: PickedImage | null) =>
    start(async () => {
      const res = await setMenuItemImageAction(
        restaurantId,
        item.id,
        picked?.imageUrl ?? null,
        picked?.libraryId ?? null
      );
      if (!res.ok && res.error) {
        setError(res.error);
        return;
      }
      setPickerFor(null);
      router.refresh();
    });

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const openAdd = () => {
    setEditingId(null);
    setForm(EMPTY);
    setError(null);
    setShowAdd(true);
  };

  const openEdit = (item: AdminMenuItem) => {
    setEditingId(item.id);
    setShowAdd(false);
    setError(null);
    setForm({
      name: item.name,
      category: item.category ?? "",
      price: String(item.price),
      discountPrice: item.discountPrice == null ? "" : String(item.discountPrice),
      veg: item.veg,
      available: item.available,
      description: item.description ?? "",
      imageUrl: item.imageUrl,
    });
  };

  const closeForm = () => {
    setShowAdd(false);
    setEditingId(null);
    setError(null);
  };

  const save = () => {
    if (!form.name.trim()) {
      setError("Item name is required.");
      return;
    }
    const price = Number(form.price);
    if (!Number.isFinite(price) || price < 0) {
      setError("Enter a valid price in rupees.");
      return;
    }
    if (form.discountPrice.trim()) {
      const discountPrice = Number(form.discountPrice);
      if (!Number.isFinite(discountPrice) || discountPrice < 0) {
        setError("Enter a valid discount price in rupees.");
        return;
      }
      if (discountPrice >= price) {
        setError("Discount price must be lower than the price.");
        return;
      }
    }
    start(async () => {
      const input = toInput(form);
      const res = editingId
        ? await updateMenuItemAction(restaurantId, editingId, input)
        : await createMenuItemAction(restaurantId, input);
      if (!res.ok) {
        setError(res.error ?? "Couldn't save.");
        return;
      }
      closeForm();
      router.refresh();
    });
  };

  const toggle = (item: AdminMenuItem) =>
    start(async () => {
      const res = await setMenuAvailabilityAction(
        restaurantId,
        item.id,
        !item.available
      );
      if (!res.ok && res.error) window.alert(res.error);
      router.refresh();
    });

  const remove = (item: AdminMenuItem) => {
    if (!window.confirm(`Delete "${item.name}"?`)) return;
    start(async () => {
      const res = await deleteMenuItemAction(restaurantId, item.id);
      if (!res.ok && res.error) window.alert(res.error);
      router.refresh();
    });
  };

  const editing = showAdd || editingId !== null;

  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? items.filter(
        (it) =>
          it.name.toLowerCase().includes(needle) ||
          (it.category ?? "").toLowerCase().includes(needle)
      )
    : items;

  // Grouped in the order each category first appears, not alphabetised — that
  // mirrors how a vendor built their menu rather than imposing a new order.
  const groups: { name: string; items: AdminMenuItem[] }[] = [];
  for (const it of filtered) {
    const name = it.category?.trim() || "Uncategorised";
    const group = groups.find((g) => g.name === name);
    if (group) group.items.push(it);
    else groups.push({ name, items: [it] });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-label">
          {items.length} items
          {needle ? (
            <span className="font-normal text-muted">
              {" "}
              · {filtered.length} shown
            </span>
          ) : null}
        </p>
        <div className="flex-1" />
        {!editing ? (
          <>
            <div className="relative w-full @sm:w-[210px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter menu…"
                aria-label="Filter menu items"
                className={`${fieldCls} py-1.5 pl-8 text-[13px]`}
              />
            </div>
            <Button size="sm" variant="secondary" onClick={openAdd}>
              <Plus className="size-4" /> Add item
            </Button>
          </>
        ) : null}
      </div>

      {editing ? (
        <div className="card space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-heading text-[15px]">
              {editingId ? "Edit item" : "New item"}
            </h3>
            <button
              type="button"
              onClick={closeForm}
              className="press grid size-8 place-items-center rounded-full text-muted hover:text-ink"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </div>
          {error ? (
            <p className="rounded-xl border border-deal/30 bg-deal/10 px-3 py-2 text-sm font-medium text-deal">
              {error}
            </p>
          ) : null}
          <Field label="Name" required>
            <input
              className={fieldCls}
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Price (₹)" required>
              <input
                className={fieldCls}
                type="number"
                min={0}
                value={form.price}
                onChange={(e) => set({ price: e.target.value })}
              />
            </Field>
            <Field label="Discount price (₹)">
              <input
                className={fieldCls}
                type="number"
                min={0}
                value={form.discountPrice}
                onChange={(e) => set({ discountPrice: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Category" hint="Dish section, e.g. Starters — not the shop type.">
            <input
              className={fieldCls}
              list="dish-categories-manager"
              placeholder="Dish category"
              value={form.category}
              onChange={(e) => set({ category: e.target.value })}
            />
            <datalist id="dish-categories-manager">
              {DISH_CATEGORIES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="Description">
            <textarea
              className={fieldCls}
              rows={2}
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => set({ veg: !form.veg })}
              className={
                "press flex-1 rounded-xl px-3 py-2 text-sm font-semibold " +
                (form.veg ? "bg-green-soft text-green" : "bg-surface-2 text-muted")
              }
            >
              {form.veg ? "Veg" : "Non-veg"}
            </button>
            <button
              type="button"
              onClick={() => set({ available: !form.available })}
              className={
                "press flex-1 rounded-xl px-3 py-2 text-sm font-semibold " +
                (form.available ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted")
              }
            >
              {form.available ? "Available" : "Sold out"}
            </button>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={pending}>
              {pending ? "Saving…" : editingId ? "Save item" : "Add item"}
            </Button>
            <Button size="sm" variant="secondary" onClick={closeForm} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {items.length === 0 && !editing ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
          No menu items yet. Add them manually or import from Excel below.
        </p>
      ) : items.length > 0 && filtered.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
          No items match &quot;{query.trim()}&quot;.
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div
              key={group.name}
              className="overflow-hidden rounded-xl border border-line bg-surface"
            >
              <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3.5 py-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
                  {group.name}
                </span>
                <span className="text-[11px] font-semibold text-[color:var(--c-faint)]">
                  {group.items.length}
                </span>
              </div>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id} className="space-y-2 border-b border-line p-3 last:border-b-0">
                    <div className="flex items-center gap-3">
                      {/* The picture, and the way to change it. Tapping it opens
                          the two options — upload from this device, or choose
                          from shared storage — which is the only thing to do
                          when an automatic match got it wrong. */}
                      <button
                        type="button"
                        onClick={() => setPickerFor(pickerFor === item.id ? null : item.id)}
                        aria-label={`Change the picture for ${item.name}`}
                        className="press relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-surface-2"
                      >
                        {item.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.imageUrl}
                            alt=""
                            className="size-full object-cover"
                          />
                        ) : (
                          <ImagePlus className="size-4 text-muted" />
                        )}
                      </button>
                      <span
                        className={
                          "size-2.5 shrink-0 rounded-full " +
                          (item.veg ? "bg-green" : "bg-deal")
                        }
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{item.name}</p>
                        <p className="truncate text-[11px] text-muted">
                          ₹{item.price}
                          {item.discountPrice != null ? ` · ₹${item.discountPrice} off-price` : ""}
                          {item.imageLibraryId ? " · photo from storage" : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggle(item)}
                        disabled={pending}
                        className={
                          // A button, so it keeps a pressable capsule — but not
                          // the `pill` status vocabulary, which is for stating
                          // a fact rather than for offering to change one.
                          "press shrink-0 rounded-[var(--c-r-sm)] border px-2.5 py-1 text-[11px] font-semibold transition-colors " +
                          (item.available
                            ? "border-green/40 bg-green-soft text-green hover:border-green"
                            : "border-line bg-surface text-muted hover:border-[var(--c-border-hover)] hover:text-ink")
                        }
                      >
                        {item.available ? "On" : "Off"}
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(item)}
                        className="press grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-muted hover:text-ink"
                        aria-label="Edit item"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(item)}
                        disabled={pending}
                        className="press grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-muted hover:text-deal"
                        aria-label="Delete item"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>

                    {pickerFor === item.id ? (
                      <FoodImagePicker
                        dishName={item.name}
                        current={
                          item.imageUrl
                            ? { imageUrl: item.imageUrl, libraryId: item.imageLibraryId }
                            : null
                        }
                        source={LIBRARY}
                        onPick={(picked) => pickImage(item, picked)}
                        onClose={() => setPickerFor(null)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-line pt-3">
        <p className={labelCls}>Bulk upload</p>
        <div className="mt-2">
          <ExcelImport restaurantId={restaurantId} categories={categories} />
        </div>
      </div>
    </div>
  );
}
