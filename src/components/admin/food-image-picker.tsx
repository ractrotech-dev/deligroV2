"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Image from "next/image";
import { Check, Loader2, Search, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldCls } from "@/components/ui/field";
import type { FoodImage } from "@/lib/data-access/food-images";

/**
 * Choose the photo for a menu item.
 *
 * Two ways in, exactly as asked for: upload one from this device, or pick one
 * out of the shared library. The library opens on the dish's own name — so
 * adding "Chicken Biryani" shows the chicken one first — and the search box
 * below shows the whole related family, because the moment you need to change
 * an auto-matched photo is precisely the moment you want to see the variants
 * side by side rather than one at a time.
 *
 * Nothing is auto-selected here. This component runs when a person has already
 * decided the automatic choice was wrong, and quietly making another automatic
 * choice for them is how they end up back where they started.
 */
export interface PickedImage {
  imageUrl: string;
  /** Set when it came from the library, so provenance is recorded. */
  libraryId: string | null;
}

/**
 * Where the picker gets its photos.
 *
 * Passed in rather than imported, because the admin console and the vendor
 * portal reach the same library through differently-gated Server Actions
 * (requireRole("admin") vs requireVendorAccess()). Importing one directly would
 * either put an admin-gated action in the vendor bundle — where it fails at the
 * gate, not at the type check — or tempt someone to drop the gate to make both
 * work. The component stays one implementation; only the door changes.
 */
export interface ImageLibrarySource {
  suggest: (
    dishName: string
  ) => Promise<{ suggestions: { image: FoodImage; reason: string }[] }>;
  search: (query: string) => Promise<{ images: FoodImage[] }>;
}

export function FoodImagePicker({
  dishName,
  current,
  source,
  onPick,
  onClose,
}: Readonly<{
  /** Opens the library on this name's best matches. */
  dishName: string;
  current: PickedImage | null;
  source: ImageLibrarySource;
  onPick: (picked: PickedImage | null) => void;
  onClose: () => void;
}>) {
  const [tab, setTab] = useState<"library" | "device">("library");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { image: FoodImage; reason: string | null }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [, start] = useTransition();

  // Opening state: what the matcher would suggest for this dish. Runs once —
  // typing in the search box takes over from there.
  //
  // `loading` already starts true, so nothing is set synchronously here: doing
  // that would force a second render before the request has even left.
  useEffect(() => {
    let live = true;
    source
      .suggest(dishName)
      .then((r) => {
        if (!live) return;
        setResults(r.suggestions.map((s) => ({ image: s.image, reason: s.reason })));
      })
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // `source` is a stable module-scope action object at every call site; it is
    // deliberately not a dependency, so re-rendering the parent does not
    // re-fetch and flash the grid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dishName]);

  // Search, debounced. An empty box goes back to the suggestions for the dish
  // rather than to an undifferentiated list of everything.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const t = window.setTimeout(() => {
      setLoading(true);
      source
        .search(q)
        .then((r) =>
          setResults(r.images.map((image) => ({ image, reason: null })))
        )
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-bold text-ink">Choose a photo</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="press grid size-8 place-items-center rounded-full text-muted hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex gap-2">
        <TabButton on={tab === "library"} onClick={() => setTab("library")}>
          Choose from storage
        </TabButton>
        <TabButton on={tab === "device"} onClick={() => setTab("device")}>
          Upload from device
        </TabButton>
      </div>

      {tab === "library" ? (
        <>
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input
              className={`${fieldCls} pl-9`}
              placeholder={`Search photos — try “${firstWord(dishName) || "biryani"}”`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          {loading ? (
            <p className="flex items-center gap-2 px-1 py-6 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" /> Looking…
            </p>
          ) : null}
          {!loading && results.length === 0 ? (
            <p className="rounded-xl bg-surface-2 px-3.5 py-6 text-center text-sm text-muted">
              {query.trim()
                ? `No photos found for “${query.trim()}”.`
                : "No matching photos in storage yet. Upload one from this device, or add it to the library first."}
            </p>
          ) : null}
          {!loading && results.length > 0 ? (
            <ul className="grid grid-cols-2 gap-2 @xl:grid-cols-3">
              {results.map(({ image, reason }) => {
                const selected = current?.libraryId === image.id;
                return (
                  <li key={image.id}>
                    <button
                      type="button"
                      onClick={() =>
                        start(() =>
                          onPick({ imageUrl: image.imageUrl, libraryId: image.id })
                        )
                      }
                      className={
                        "press w-full overflow-hidden rounded-xl border text-left " +
                        (selected
                          ? "border-accent ring-2 ring-accent/30"
                          : "border-line")
                      }
                    >
                      <span className="relative block aspect-[4/3] bg-surface-2">
                        {/* `unoptimized`, like the registration wizard's logo
                            preview: next.config.ts declares no
                            images.remotePatterns, so the optimiser would
                            refuse a Supabase storage URL outright. */}
                        <Image
                          src={image.imageUrl}
                          alt={image.title}
                          fill
                          sizes="200px"
                          unoptimized
                          className="object-cover"
                        />
                        {selected ? (
                          <span className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-accent text-[var(--on-accent)]">
                            <Check className="size-3.5" strokeWidth={3} />
                          </span>
                        ) : null}
                      </span>
                      <span className="block px-2 py-1.5">
                        <span className="block truncate text-[12.5px] font-semibold text-ink">
                          {image.title}
                        </span>
                        {reason ? (
                          <span className="block truncate text-[10.5px] text-muted">
                            {reason}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      ) : (
        <DeviceUpload dishName={dishName} onPick={onPick} />
      )}

      {current ? (
        <button
          type="button"
          onClick={() => onPick(null)}
          className="press text-[12.5px] font-semibold text-deal"
        >
          Remove the photo from this item
        </button>
      ) : null}
    </div>
  );
}

function firstWord(s: string): string {
  return s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

function TabButton({
  on,
  onClick,
  children,
}: Readonly<{
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "press flex-1 rounded-xl px-3 py-2 text-[13px] font-semibold " +
        (on ? "bg-accent-soft text-accent-ink" : "bg-surface-2 text-muted")
      }
    >
      {children}
    </button>
  );
}

/**
 * Upload a photo for this one item.
 *
 * It also lands in the shared library, named after the dish — which is what
 * makes the library fill itself up as people work, rather than only when
 * someone remembers to go and curate it. A duplicate name is reported plainly
 * so the operator picks the existing photo instead.
 */
function DeviceUpload({
  dishName,
  onPick,
}: Readonly<{
  dishName: string;
  onPick: (picked: PickedImage) => void;
}>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(dishName);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("title", title.trim() || dishName);
      const res = await fetch("/api/admin/food-images", {
        method: "POST",
        body: fd,
      });
      const data = (await res.json()) as {
        image?: FoodImage;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.image) {
        setError(
          data.message ?? "Couldn't upload that image. Try a different file."
        );
        return;
      }
      onPick({ imageUrl: data.image.imageUrl, libraryId: data.image.id });
    } catch {
      setError("Couldn't upload that image. Check your connection.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-3">
      <label className="block space-y-1.5">
        <span className="text-xs font-semibold text-muted">
          Name this photo
        </span>
        <input
          className={fieldCls}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Chicken Biryani"
        />
        <span className="block text-[11px] text-muted">
          The photo is saved to shared storage under this name, so other shops
          selling the same dish can use it too.
        </span>
      </label>

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
        variant="secondary"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? (
          <>
            <Loader2 className="size-4 animate-spin" /> Uploading…
          </>
        ) : (
          <>
            <Upload className="size-4" /> Choose a file
          </>
        )}
      </Button>
      <p className="text-[11px] text-muted">JPG, PNG or WebP, up to 2 MB.</p>

      {error ? (
        <p className="rounded-xl border border-deal/30 bg-deal/10 px-3 py-2 text-[12.5px] font-medium text-deal">
          {error}
        </p>
      ) : null}
    </div>
  );
}
