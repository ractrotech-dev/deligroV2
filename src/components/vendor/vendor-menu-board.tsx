"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CheckSquare,
  Download,
  FileUp,
  ImageOff,
  Layers,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MenuCategoryManager } from "@/components/vendor/menu-category-manager";
import { MenuCustomerPreview } from "@/components/vendor/menu-customer-preview";
import { MenuImportDialog } from "@/components/vendor/menu-import-dialog";
import { MenuItemFormSheet } from "@/components/vendor/menu-item-form-sheet";
import { VendorMenuItemCard } from "@/components/vendor/menu-item-card";
import {
  VendorChip,
  VendorEmptyState,
  VendorHero,
  VendorMetricCard,
  VendorPanel,
} from "@/components/vendor/vendor-ui";
import {
  bulkSetAvailableAction,
  bulkSetFlagsAction,
  deleteMenuItemAction,
  deleteMenuItemsAction,
  duplicateMenuItemAction,
  reorderMenuItemsAction,
} from "@/app/vendor/actions";
import { PortalToShell } from "@/components/shared/portal-to-shell";
import { useVendorShellMode } from "@/hooks/use-vendor-shell-mode";
import type { VendorMenuItem } from "@/lib/data-access/vendor-menu";
import {
  downloadTextFile,
  serializeMenuCsv,
} from "@/lib/vendor/menu-csv";
import { cn } from "@/lib/utils/cn";

type MenuRow = VendorMenuItem;
type StatusFilter = "all" | "in_stock" | "sold_out" | "veg" | "no_photo";

export function VendorMenuBoard({
  restaurantId,
  restaurantName,
  restaurantSlug,
  categories,
  items: initialItems,
  live = false,
}: {
  restaurantId: string;
  restaurantName: string;
  restaurantSlug?: string;
  categories: string[];
  items: MenuRow[];
  live?: boolean;
}) {
  const router = useRouter();
  const shellMode = useVendorShellMode();
  const [items, setItems] = useState(initialItems);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sheet, setSheet] = useState<{
    mode: "create" | "edit";
    item?: MenuRow;
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [previewItem, setPreviewItem] = useState<MenuRow | null>(null);
  const [bulkMode, setBulkMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  const [pending, startTransition] = useTransition();

  // Adopt fresh server rows during render (new/edited items from router.refresh)
  // rather than syncing them in an effect, which paints a stale frame and trips
  // the react-hooks lint rule.
  const [adoptedItems, setAdoptedItems] = useState(initialItems);
  if (adoptedItems !== initialItems) {
    setAdoptedItems(initialItems);
    setItems(initialItems);
  }

  const allCategories = useMemo(
    () =>
      [
        ...new Set([
          ...categories,
          ...items.map((i) => i.category).filter(Boolean),
        ]),
      ].sort((a, b) => a.localeCompare(b)),
    [categories, items]
  );

  const itemCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const item of items) {
      map[item.category] = (map[item.category] ?? 0) + 1;
    }
    return map;
  }, [items]);

  const missingPhotoCount = items.filter((i) => !i.image).length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesQuery =
        !q ||
        item.name.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q);
      const matchesCat = !activeCategory || item.category === activeCategory;
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "in_stock" && !item.soldOut) ||
        (statusFilter === "sold_out" && item.soldOut) ||
        (statusFilter === "veg" && item.veg) ||
        (statusFilter === "no_photo" && !item.image);
      return matchesQuery && matchesCat && matchesStatus;
    });
  }, [items, query, activeCategory, statusFilter]);

  const inStock = items.filter((i) => !i.soldOut).length;
  const soldOut = items.length - inStock;
  const categoryCount = new Set(items.map((i) => i.category)).size;

  const byCategory = allCategories
    .map((cat) => ({
      cat,
      items: filtered.filter((m) => m.category === cat),
    }))
    .filter((g) => g.items.length > 0);

  const reorderEnabled =
    live && !bulkMode && !query.trim() && statusFilter === "all";

  function persistOrder(nextItems: MenuRow[]) {
    const ids: string[] = [];
    for (const cat of allCategories) {
      const group = nextItems
        .filter((i) => i.category === cat)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      ids.push(...group.map((i) => i.dbId));
    }
    if (ids.length === 0) return;

    setItems((prev) =>
      prev.map((item) => {
        const index = ids.indexOf(item.dbId);
        return index >= 0 ? { ...item, sortOrder: index } : item;
      })
    );

    startTransition(async () => {
      try {
        await reorderMenuItemsAction(ids);
        router.refresh();
      } catch {
        setActionError("Couldn't save the new order. Reloading the menu.");
        router.refresh();
      }
    });
  }

  function applyCategoryOrder(category: string, orderedGroup: MenuRow[]) {
    setItems((prev) => {
      const others = prev.filter((i) => i.category !== category);
      const withOrder = orderedGroup.map((item, index) => ({
        ...item,
        sortOrder: index,
      }));
      const next = [...others, ...withOrder];
      // Defer persist so state updates first
      queueMicrotask(() => persistOrder(next));
      return next;
    });
  }

  function moveInCategory(
    item: MenuRow,
    dir: "up" | "down"
  ) {
    const group = items
      .filter((i) => i.category === item.category)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const idx = group.findIndex((i) => i.dbId === item.dbId);
    if (idx < 0) return;
    const swapWith = dir === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= group.length) return;
    const next = [...group];
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    applyCategoryOrder(item.category, next);
  }

  function dropInCategory(targetId: string, category: string) {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      return;
    }
    const group = items
      .filter((i) => i.category === category)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const fromIdx = group.findIndex((i) => i.dbId === dragId);
    const toIdx = group.findIndex((i) => i.dbId === targetId);
    if (fromIdx < 0 || toIdx < 0) {
      setDragId(null);
      return;
    }
    const next = [...group];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    setDragId(null);
    applyCategoryOrder(category, next);
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitBulk() {
    setBulkMode(false);
    setSelected(new Set());
  }

  function handleDelete(item: MenuRow) {
    if (!live || !confirm(`Delete “${item.name}”? This cannot be undone.`)) {
      return;
    }
    setDeletingId(item.dbId);
    setActionError(null);
    startTransition(async () => {
      try {
        await deleteMenuItemAction(item.dbId);
        setItems((prev) => prev.filter((i) => i.dbId !== item.dbId));
        router.refresh();
      } catch {
        setActionError(`Couldn't delete "${item.name}". Try again.`);
      } finally {
        setDeletingId(null);
      }
    });
  }

  function handleDuplicate(item: MenuRow) {
    setActionError(null);
    startTransition(async () => {
      try {
        await duplicateMenuItemAction(item.dbId);
        router.refresh();
      } catch {
        setActionError(`Couldn't duplicate "${item.name}". Try again.`);
      }
    });
  }

  function handleBulkAvailable(available: boolean) {
    const ids = [...selected];
    if (ids.length === 0) return;
    setActionError(null);
    startTransition(async () => {
      try {
        await bulkSetAvailableAction(ids, available);
        setItems((prev) =>
          prev.map((i) =>
            selected.has(i.dbId) ? { ...i, soldOut: !available } : i
          )
        );
        exitBulk();
        router.refresh();
      } catch {
        setActionError("Couldn't update those items. Try again.");
      }
    });
  }

  function handleBulkFlags(flags: { popular?: boolean; bestseller?: boolean }) {
    const ids = [...selected];
    if (ids.length === 0) return;
    setActionError(null);
    startTransition(async () => {
      try {
        await bulkSetFlagsAction(ids, flags);
        setItems((prev) =>
          prev.map((i) =>
            selected.has(i.dbId)
              ? {
                  ...i,
                  popular: flags.popular ?? i.popular,
                  bestseller: flags.bestseller ?? i.bestseller,
                }
              : i
          )
        );
        exitBulk();
        router.refresh();
      } catch {
        setActionError("Couldn't update those items. Try again.");
      }
    });
  }

  function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (
      !confirm(
        `Delete ${ids.length} item${ids.length === 1 ? "" : "s"}? This cannot be undone.`
      )
    ) {
      return;
    }
    setActionError(null);
    startTransition(async () => {
      try {
        await deleteMenuItemsAction(ids);
        setItems((prev) => prev.filter((i) => !selected.has(i.dbId)));
        exitBulk();
        router.refresh();
      } catch {
        setActionError("Couldn't delete those items. Try again.");
      }
    });
  }

  function handleExport() {
    const csv = serializeMenuCsv(items);
    const slug = (restaurantSlug || restaurantName)
      .toLowerCase()
      .replace(/\s+/g, "-")
      .slice(0, 40);
    downloadTextFile(`${slug || "menu"}-export.csv`, csv);
  }

  const statusChips: { id: StatusFilter; label: string; count: number }[] = [
    { id: "all", label: "All", count: items.length },
    { id: "in_stock", label: "In stock", count: inStock },
    { id: "sold_out", label: "Sold out", count: soldOut },
    {
      id: "veg",
      label: "Veg",
      count: items.filter((i) => i.veg).length,
    },
    { id: "no_photo", label: "No photo", count: missingPhotoCount },
  ];

  return (
    <>
      <VendorHero
        title="Menu"
        subtitle={`${restaurantName} — dishes, pricing, stock & sheet import.`}
        action={
          live ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {restaurantSlug ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="hidden @3xl:inline-flex"
                  onClick={() =>
                    window.open(
                      `/restaurant/${restaurantSlug}`,
                      "_blank",
                      "noopener"
                    )
                  }
                >
                  View storefront
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="hidden @3xl:inline-flex"
                onClick={() => setImportOpen(true)}
              >
                <FileUp className="size-4" /> Import sheet
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => setSheet({ mode: "create" })}
              >
                <Plus className="size-4" /> Add item
              </Button>
            </div>
          ) : null
        }
      />

      {actionError ? (
        <p className="rounded-xl border border-deal/30 bg-deal/10 px-3 py-2 text-sm font-medium text-deal">
          {actionError}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:gap-3 @3xl:grid-cols-4">
        <VendorMetricCard
          label="Total items"
          value={String(items.length)}
        />
        <VendorMetricCard
          label="In stock"
          value={String(inStock)}
          onClick={() => setStatusFilter("in_stock")}
        />
        <VendorMetricCard
          label="Sold out"
          value={String(soldOut)}
          onClick={() => setStatusFilter("sold_out")}
        />
        <VendorMetricCard
          label="Categories"
          value={String(categoryCount)}
          onClick={live ? () => setCategoryOpen(true) : undefined}
        />
      </div>

      {live && missingPhotoCount > 0 && !nudgeDismissed ? (
        <div className="flex items-start gap-3 rounded-2xl border border-accent/25 bg-accent/5 p-3 sm:items-center">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent">
            <ImageOff className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">
              {missingPhotoCount} item{missingPhotoCount === 1 ? "" : "s"} missing
              a photo
            </p>
            <p className="text-xs text-muted">
              Dishes with photos convert better on the storefront.
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setStatusFilter("no_photo")}
            >
              Review
            </Button>
            <button
              type="button"
              className="press rounded-full p-2 text-muted"
              onClick={() => setNudgeDismissed(true)}
              aria-label="Dismiss"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      ) : null}

      {live ? (
        <div className="flex flex-wrap gap-2 sm:hidden">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => setImportOpen(true)}
          >
            <FileUp className="size-4" /> Import
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={handleExport}
          >
            <Download className="size-4" /> Export
          </Button>
        </div>
      ) : null}

      <VendorPanel>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5">
            <Search className="size-4 shrink-0 text-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search dishes or categories…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
            />
          </label>
          {live ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCategoryOpen(true)}
              >
                <Layers className="size-4" /> Categories
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="hidden @3xl:inline-flex"
                onClick={handleExport}
              >
                <Download className="size-4" /> Export
              </Button>
              <Button
                type="button"
                variant={bulkMode ? "primary" : "outline"}
                size="sm"
                onClick={() => (bulkMode ? exitBulk() : setBulkMode(true))}
              >
                {bulkMode ? (
                  <>
                    <X className="size-4" /> Cancel
                  </>
                ) : (
                  <>
                    <CheckSquare className="size-4" /> Select
                  </>
                )}
              </Button>
            </div>
          ) : null}
        </div>

        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1">
          {statusChips.map((chip) => (
            <VendorChip
              key={chip.id}
              active={statusFilter === chip.id}
              onClick={() =>
                setStatusFilter((s) => (s === chip.id ? "all" : chip.id))
              }
              count={chip.count}
            >
              {chip.label}
            </VendorChip>
          ))}
        </div>

        {allCategories.length > 0 ? (
          <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto pb-1">
            <VendorChip
              active={activeCategory === null}
              onClick={() => setActiveCategory(null)}
              count={items.length}
            >
              All categories
            </VendorChip>
            {allCategories.map((cat) => (
              <VendorChip
                key={cat}
                active={activeCategory === cat}
                onClick={() =>
                  setActiveCategory((c) => (c === cat ? null : cat))
                }
                count={itemCounts[cat] ?? 0}
              >
                {cat}
              </VendorChip>
            ))}
          </div>
        ) : null}
      </VendorPanel>

      {bulkMode && live ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-accent/30 bg-accent/5 p-3">
          <span className="text-sm font-semibold">
            {selected.size} selected
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSelected(new Set(filtered.map((i) => i.dbId)))}
          >
            Select visible
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || selected.size === 0}
            onClick={() => handleBulkAvailable(true)}
          >
            Mark in stock
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || selected.size === 0}
            onClick={() => handleBulkAvailable(false)}
          >
            Mark sold out
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || selected.size === 0}
            onClick={() => handleBulkFlags({ popular: true })}
          >
            Mark popular
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || selected.size === 0}
            onClick={() => handleBulkFlags({ popular: false })}
          >
            Unmark popular
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || selected.size === 0}
            onClick={() => handleBulkFlags({ bestseller: true })}
          >
            Mark bestseller
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || selected.size === 0}
            onClick={() => handleBulkFlags({ bestseller: false })}
          >
            Unmark bestseller
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || selected.size === 0}
            onClick={handleBulkDelete}
          >
            Delete
          </Button>
        </div>
      ) : null}

      {items.length === 0 ? (
        <VendorEmptyState
          title="Menu is empty"
          description="Add dishes one by one, or import a filled CSV template."
          action={
            live ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={() => setSheet({ mode: "create" })}>
                  <Plus className="size-4" /> Add item
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setImportOpen(true)}
                >
                  <FileUp className="size-4" /> Import sheet
                </Button>
              </div>
            ) : null
          }
        />
      ) : byCategory.length === 0 ? (
        <VendorEmptyState
          title="No matches"
          description="Try a different search or filter."
        />
      ) : (
        byCategory.map((group) => {
          const sortedGroup = [...group.items].sort(
            (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
          );
          return (
            <VendorPanel
              key={group.cat}
              title={group.cat}
              subtitle={`${group.items.length} item${group.items.length === 1 ? "" : "s"}`}
            >
              <div className="space-y-2">
                {sortedGroup.map((item) => {
                  const fullGroup = items
                    .filter((i) => i.category === group.cat)
                    .sort(
                      (a, b) =>
                        a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
                    );
                  const fullIdx = fullGroup.findIndex((i) => i.dbId === item.dbId);
                  return (
                  <div
                    key={item.dbId}
                    className={cn(dragId === item.dbId && "opacity-60")}
                  >
                    <VendorMenuItemCard
                      item={item}
                      live={live}
                      bulkMode={bulkMode}
                      showReorder={reorderEnabled}
                      selected={selected.has(item.dbId)}
                      canMoveUp={reorderEnabled && fullIdx > 0}
                      canMoveDown={
                        reorderEnabled &&
                        fullIdx >= 0 &&
                        fullIdx < fullGroup.length - 1
                      }
                      deleting={pending && deletingId === item.dbId}
                      onToggleSelect={() => toggleSelect(item.dbId)}
                      onEdit={() => setSheet({ mode: "edit", item })}
                      onDelete={() => handleDelete(item)}
                      onDuplicate={() => handleDuplicate(item)}
                      onPreview={() => setPreviewItem(item)}
                      onMove={(dir) => moveInCategory(item, dir)}
                      onAvailability={(available) =>
                        setItems((prev) =>
                          prev.map((i) =>
                            i.dbId === item.dbId
                              ? { ...i, soldOut: !available }
                              : i
                          )
                        )
                      }
                      onPriceSaved={(price) =>
                        setItems((prev) =>
                          prev.map((i) =>
                            i.dbId === item.dbId ? { ...i, price } : i
                          )
                        )
                      }
                      onDragStart={() => {
                        if (reorderEnabled) setDragId(item.dbId);
                      }}
                      onDragOver={(e) => {
                        if (!reorderEnabled) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={() => {
                        if (reorderEnabled) dropInCategory(item.dbId, group.cat);
                      }}
                    />
                  </div>
                  );
                })}
              </div>
            </VendorPanel>
          );
        })
      )}

      {live && shellMode === "app" ? (
        <PortalToShell>
          <Button
            size="lg"
            className="vendor-fab fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] right-4 z-30 size-14 rounded-full p-0"
            onClick={() => setSheet({ mode: "create" })}
            aria-label="Add menu item"
          >
            <Plus className="size-6" />
          </Button>
        </PortalToShell>
      ) : null}

      {sheet ? (
        <MenuItemFormSheet
          key={sheet.mode === "edit" ? sheet.item?.dbId : "new"}
          open
          mode={sheet.mode}
          item={sheet.item}
          categories={allCategories}
          restaurantId={restaurantId}
          onClose={() => {
            setSheet(null);
            router.refresh();
          }}
        />
      ) : null}

      <MenuImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => router.refresh()}
      />

      <MenuCategoryManager
        open={categoryOpen}
        categories={allCategories}
        itemCounts={itemCounts}
        onClose={() => setCategoryOpen(false)}
        onChanged={() => router.refresh()}
      />

      <MenuCustomerPreview
        open={Boolean(previewItem)}
        item={previewItem}
        restaurantName={restaurantName}
        restaurantSlug={restaurantSlug}
        onClose={() => setPreviewItem(null)}
      />
    </>
  );
}
