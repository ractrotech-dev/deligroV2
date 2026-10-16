import Link from "next/link";
import { LayoutGrid } from "lucide-react";
import { STORE_CATEGORIES, categoryLabel } from "@/lib/taxonomy";
import { getLang } from "@/lib/i18n/server";
import { translator } from "@/lib/i18n/lang";
import { cn } from "@/lib/utils/cn";

/**
 * Storefront types on the Stores tab. Selection lives in the URL (`?category=`)
 * so the filtered list is server-rendered and shareable; tapping the active tile
 * clears it, which is why its href drops the param.
 *
 * `categories` is passed in rather than read from the module constant, because
 * which ones are on offer is an admin setting (see `lib/store-categories.ts`)
 * and this component is rendered from a server page that already knows. It
 * defaults to the full list so demo/mock callers are unaffected.
 */
export async function StoreCategoryStrip({
  active,
  categories = STORE_CATEGORIES,
  counts,
}: {
  active?: string;
  categories?: typeof STORE_CATEGORIES;
  /**
   * Shops behind each category id, and whether the tile leads somewhere even
   * with none (Groceries and Pick & Drop open their own screens rather than a
   * filtered list). Absent means "don't reason about it" — every tile then
   * renders as live, which is the old behaviour.
   */
  counts?: Map<string, { shops: number; hasOwnScreen: boolean }>;
}) {
  const lang = await getLang();
  const t = translator(lang);
  return (
    /*
     * `py-1 -my-1` is not spacing, it is the fix for a clipped ring.
     *
     * `overflow-x: auto` makes the box clip on BOTH axes — there is no way to
     * scroll one and let the other spill — so the active tile's `ring-2`, which
     * a ring draws outside the element, was being sliced off along the top and
     * bottom edges of this container. The padding gives the ring somewhere to
     * land and the negative margin gives the space back to the layout, so
     * nothing below moves.
     */
    <div className="no-scrollbar -my-1 flex gap-2 overflow-x-auto px-4 py-1">
      <Tile
        href="/stores"
        active={!active}
        label={t("All stores", "सभी दुकानें")}
        icon={
          <LayoutGrid
            className={cn("size-7", !active ? "text-accent-ink" : "text-ink")}
          />
        }
      />
      {categories.map((c) => {
        const isActive = c.id === active;
        const meta = counts?.get(c.id);
        // Nothing behind it and no screen of its own: still shown, because an
        // admin switched it on deliberately, but not dressed up as somewhere
        // worth tapping. See the page for why these also sort last.
        const empty = Boolean(meta?.shops === 0 && !meta.hasOwnScreen);
        return (
          <Tile
            key={c.id}
            href={isActive ? "/stores" : `/stores?category=${c.id}`}
            active={isActive}
            label={categoryLabel(lang, c)}
            empty={empty}
            icon={
              /* A representative photo per storefront type, same source and
                 size as the Home cuisine strip (images.unsplash.com, the host
                 the CSP allows). Decorative: the label under the tile names
                 it, so alt is empty. Emoji stays as the fallback for a
                 category with no `image`. */
              c.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={c.image}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="size-full object-cover"
                />
              ) : (
                <span
                  className="text-4xl"
                  role="img"
                  aria-label={categoryLabel(lang, c)}
                >
                  {c.emoji}
                </span>
              )
            }
          />
        );
      })}
    </div>
  );
}

function Tile({
  href,
  active,
  label,
  icon,
  empty = false,
}: {
  href: string;
  active: boolean;
  label: string;
  icon: React.ReactNode;
  empty?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className="press flex w-[72px] shrink-0 flex-col items-center gap-1.5"
    >
      <span
        className={cn(
          "grid size-16 place-items-center overflow-hidden rounded-xl transition-colors",
          active ? "bg-accent-soft ring-2 ring-accent" : "bg-surface-2",
          empty && !active && "opacity-45",
        )}
      >
        {icon}
      </span>
      {/*
        Two lines, not an ellipsis.

        These were `truncate` inside 68px, which at 11px semibold cuts the
        longest labels the taxonomy actually has: "Pick & Drop" and "All
        stores" both lost their last word to a "…". A category tile whose whole
        job is to name a category should not be the thing that runs out of
        room — so it wraps, and the box reserves both lines whether or not the
        second one is used, to keep every tile's label on the same baseline.
      */}
      <span
        className={cn(
          "line-clamp-2 min-h-[2.1em] w-full text-center text-[11px] font-semibold leading-tight",
          active ? "text-accent-ink" : empty ? "text-muted" : "text-ink",
        )}
      >
        {label}
      </span>
    </Link>
  );
}
