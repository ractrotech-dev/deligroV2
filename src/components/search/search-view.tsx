"use client";

import { useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import { Search, X, UtensilsCrossed, Store, TriangleAlert } from "lucide-react";
import type { Restaurant } from "@/types";
import {
  buildDishIndex,
  categoryBasis,
  groupByShop,
  searchDishes,
  FOOD_CATEGORIES,
  type DishSort,
  type RankContext,
  type SearchFilters,
} from "@/lib/search/dishes";
import { useLocation } from "@/stores/location-store";
import { PINNED_LOCATION } from "@/lib/location/pinned";
import { DishCard } from "@/components/search/dish-card";
import { RestaurantCard } from "@/components/shared/restaurant-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { formatINR } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type Tab = "dishes" | "shops";

/** Ceiling on the dish list. Long enough to scroll, short enough to render. */
const DISH_LIMIT = 60;

/** The cap behind the "Under ₹200" chip, in whole rupees. */
const BUDGET_PRICE = 200;

const SUGGESTIONS = ["Paneer", "Biryani", "Pizza", "Cold coffee", "Dosa"] as const;

const QUICK_FILTERS = [
  { id: "veg", label: "Pure Veg" },
  { id: "popular", label: "Bestsellers" },
  { id: "cheap", label: `Under ${formatINR(BUDGET_PRICE)}` },
  { id: "fast", label: "Under 25 min" },
  { id: "rating", label: "Rating 4.5+" },
  { id: "offers", label: "Offers" },
] as const;

const SORTS: { id: DishSort; label: string }[] = [
  { id: "relevance", label: "Best match" },
  { id: "price", label: "Price" },
  { id: "eta", label: "Fastest" },
  { id: "rating", label: "Top rated" },
];

/**
 * Food-first search.
 *
 * The question this screen answers is "who has X?", where X is a dish — so the
 * result is a dish, priced, with an Add on it, and the kitchen named underneath.
 * Restaurants are still here, one tab across, ranked by how well their menu
 * answers the same query rather than by their name alone.
 */
export function SearchView({
  initialCategory,
  initialQuery,
  restaurants,
  catalogFailed = false,
  rotationSeed,
}: {
  initialCategory?: string;
  /** Carried over from the home field, so "See all results" keeps the words. */
  initialQuery?: string;
  restaurants: Restaurant[];
  /** True when the catalog read failed — an empty `restaurants` is then meaningless, not a real zero-result answer. */
  catalogFailed?: boolean;
  /**
   * Today's date, from the server — see `lib/search/rotation.ts`. Passed in
   * rather than read from the clock here so the server and client renders can
   * never disagree about which day it is.
   */
  rotationSeed?: string;
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [tab, setTab] = useState<Tab>("dishes");
  const [sort, setSort] = useState<DishSort>("relevance");
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<string | null>(
    initialCategory ?? null
  );

  // Keeps the field responsive while the ranking catches up on a big catalog.
  const deferredQuery = useDeferredValue(query);

  const index = useMemo(() => buildDishIndex(restaurants), [restaurants]);

  const filters = useMemo<SearchFilters>(
    () => ({
      veg: chips.has("veg"),
      popular: chips.has("popular"),
      maxPrice: chips.has("cheap") ? BUDGET_PRICE : null,
      fast: chips.has("fast"),
      rating: chips.has("rating"),
      offers: chips.has("offers"),
      category,
    }),
    [chips, category]
  );

  // Ranking measures from wherever the customer is — the same origin the header
  // names and `ShopDistance` prints, so a row that reads "1.2 km" is a row that
  // was ranked as 1.2 km. Bemetara until they detect a fix or pick an address.
  const origin = useLocation((s) => s.coords) ?? PINNED_LOCATION.coords;
  const ctx = useMemo<RankContext>(
    () => ({ origin, rotationSeed }),
    [origin, rotationSeed]
  );

  const dishes = useMemo(
    () => searchDishes(index, deferredQuery, filters, sort, ctx),
    [index, deferredQuery, filters, sort, ctx]
  );

  const shops = useMemo(
    () => groupByShop(dishes, restaurants, deferredQuery, filters, sort),
    [dishes, restaurants, deferredQuery, filters, sort]
  );

  const toggleChip = (id: string) =>
    setChips((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clearAll = () => {
    setChips(new Set());
    setCategory(null);
    setQuery("");
  };

  const typed = deferredQuery.trim();
  const activeCount = chips.size + (category ? 1 : 0);
  const showSuggestions = !typed && !category && chips.size === 0;
  const shown = dishes.slice(0, DISH_LIMIT);

  const activeCategory = FOOD_CATEGORIES.find((c) => c.id === category) ?? null;
  // A chip nothing on any menu actually matches is being answered by the shops'
  // cuisine tags instead. Say so — otherwise "Rolls" quietly lists milkshakes.
  const byCuisineOnly = categoryBasis(index, category) === "cuisine";
  const partial = Boolean(typed) && Boolean(shown[0]?.partial);

  // When a category chip is what emptied the screen, the useful thing to say is
  // not "nothing matches" — it is "there are 10 of these, just not under Thali".
  // Only computed when the screen is already empty and a category is on, so the
  // common path does no extra work.
  const withoutCategory = useMemo(() => {
    if (dishes.length || !category || !typed) return 0;
    return searchDishes(index, deferredQuery, { ...filters, category: null }, sort, ctx)
      .length;
  }, [dishes.length, category, typed, index, deferredQuery, filters, sort, ctx]);

  return (
    <div>
      {/* z-30, matching the restaurant menu's sticky category strip: the dish
          photos below carry z-20 so their ADD pill can overhang the row, and
          sticky chrome has to out-rank them outright. z-20 here merely TIED
          with those photos, and a tie is settled by DOM order — which puts the
          scrolling list on top, so pills painted over the search field. */}
      <div className="glass sticky top-0 z-30 px-4 pb-3 pt-3">
        <div className="bolt-search">
          <Search className="size-5 shrink-0" />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for a dish, cuisine or restaurant"
            aria-label="Search for a dish, cuisine or restaurant"
          />
          {query ? (
            <button
              onClick={() => setQuery("")}
              aria-label="Clear"
              className="press grid size-6 shrink-0 place-items-center rounded-full bg-surface text-muted"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>

        <div className="mt-2.5 flex items-center gap-1 rounded-full bg-surface-2 p-0.5 text-[13px] font-bold">
          <TabBtn
            on={tab === "dishes"}
            onClick={() => setTab("dishes")}
            icon={<UtensilsCrossed className="size-4" />}
          >
            Dishes ({dishes.length})
          </TabBtn>
          <TabBtn
            on={tab === "shops"}
            onClick={() => setTab("shops")}
            icon={<Store className="size-4" />}
          >
            Restaurants ({shops.length})
          </TabBtn>
        </div>
      </div>

      <div className="px-4 pt-3">
        {catalogFailed ? (
          <div className="mb-3 flex items-start gap-2.5 rounded-2xl border border-deal/30 bg-deal-soft px-3 py-2.5 text-sm font-medium text-deal">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              We couldn&apos;t load the catalog just now. This is a problem on
              our side — try again in a moment.
            </span>
          </div>
        ) : null}

        <div className="no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1">
          {QUICK_FILTERS.map((f) => (
            <Chip key={f.id} on={chips.has(f.id)} onClick={() => toggleChip(f.id)}>
              {f.label}
            </Chip>
          ))}
        </div>

        <div className="no-scrollbar -mx-4 mt-2 flex items-center gap-2 overflow-x-auto px-4">
          {FOOD_CATEGORIES.map((c) => (
            <Chip
              key={c.id}
              on={category === c.id}
              onClick={() => setCategory(category === c.id ? null : c.id)}
            >
              {c.label}
            </Chip>
          ))}
        </div>

        {showSuggestions ? (
          <div className="mt-4">
            <p className="text-[13px] font-bold uppercase tracking-[0.06em] text-muted">
              Try searching
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {SUGGESTIONS.map((term) => (
                <button
                  key={term}
                  type="button"
                  onClick={() => setQuery(term)}
                  className="press rounded-full bg-surface-2 px-3.5 py-2 text-sm font-semibold text-ink"
                >
                  {term}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-medium text-muted">
            {tab === "dishes" ? (
              <>
                {dishes.length} {dishes.length === 1 ? "dish" : "dishes"}
                {dishes.length > DISH_LIMIT ? ` · top ${DISH_LIMIT}` : ""}
              </>
            ) : (
              <>
                {shops.length}{" "}
                {shops.length === 1 ? "restaurant" : "restaurants"}
              </>
            )}
            {activeCount ? ` · ${activeCount} filters` : ""}
          </p>
          <div className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto rounded-full bg-surface-2 p-0.5 text-xs font-bold">
            {SORTS.map((s) => (
              <SortBtn key={s.id} on={sort === s.id} onClick={() => setSort(s.id)}>
                {s.label}
              </SortBtn>
            ))}
          </div>
        </div>

        {!typed && tab === "dishes" && shown.length ? (
          <h2 className="mt-4 text-[17px] font-extrabold tracking-tight">
            {activeCategory ? activeCategory.label : "Popular dishes near you"}
          </h2>
        ) : null}

        {byCuisineOnly && activeCategory ? (
          <p className="mt-2 text-[13px] font-medium leading-snug text-muted">
            No dish near you is listed as {activeCategory.label.toLowerCase()}{" "}
            yet — showing what these kitchens do serve.
          </p>
        ) : null}

        {partial ? (
          <p className="mt-3 text-[13px] font-medium leading-snug text-muted">
            Nothing is called &ldquo;{typed}&rdquo; exactly. These are the
            closest dishes.
          </p>
        ) : null}

        {tab === "dishes" ? (
          shown.length ? (
            <div className="mt-1 divide-y divide-line">
              {shown.map((hit) => (
                <DishCard key={hit.key} hit={hit} />
              ))}
            </div>
          ) : (
            <NoResults
              query={typed}
              onClear={clearAll}
              kind="dish"
              categoryLabel={activeCategory?.label ?? null}
              elsewhere={withoutCategory}
              onDropCategory={() => setCategory(null)}
            />
          )
        ) : shops.length ? (
          <div className="mt-4 space-y-5">
            {shops.map((shop) => (
              <div key={shop.restaurant.slug}>
                <RestaurantCard restaurant={shop.restaurant} />
                {/* Why this shop is in the list: the dishes that matched. */}
                {typed && shop.dishes.length ? (
                  <Link
                    href={`/restaurant/${shop.restaurant.slug}`}
                    className="press mt-1.5 block truncate px-0.5 text-[12px] font-medium text-muted"
                  >
                    Serves{" "}
                    <span className="font-semibold text-ink">
                      {shop.dishes
                        .slice(0, 3)
                        .map((d) => d.item.name)
                        .join(", ")}
                    </span>
                    {shop.dishes.length > 3
                      ? ` +${shop.dishes.length - 3} more`
                      : ""}
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <NoResults query={typed} onClear={clearAll} kind="restaurant" />
        )}
      </div>
    </div>
  );
}

function NoResults({
  query,
  onClear,
  kind,
  categoryLabel = null,
  elsewhere = 0,
  onDropCategory,
}: {
  query: string;
  onClear: () => void;
  kind: "dish" | "restaurant";
  /** The category chip that is on, when one is. */
  categoryLabel?: string | null;
  /** How many dishes this same query finds with that chip off. */
  elsewhere?: number;
  onDropCategory?: () => void;
}) {
  // The category is the reason the screen is empty, and we know exactly how many
  // results dropping it would bring back. Saying "no Thali matches EGG BIRYANI,
  // but 10 other dishes do" answers the question the blank screen provokes;
  // "nothing matches" next to a list of chips leaves someone to guess which one
  // to poke. Worth the extra sentence for a first-time smartphone user.
  const blockedByCategory = Boolean(categoryLabel) && elsewhere > 0;

  if (blockedByCategory) {
    return (
      <EmptyState
        className="mt-6"
        icon={<Search className="size-7" />}
        title={`No ${categoryLabel} matches “${query}”`}
        description={`But ${elsewhere} other ${
          elsewhere === 1 ? "dish matches" : "dishes match"
        } — they're just not ${categoryLabel}.`}
        action={
          <Button onClick={onDropCategory}>
            Show all {elsewhere} {elsewhere === 1 ? "result" : "results"}
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      className="mt-6"
      icon={<Search className="size-7" />}
      title={query ? `Nothing called “${query}” yet` : "Nothing matches — yet"}
      description={
        kind === "dish"
          ? "No kitchen near you is cooking that right now. Try a shorter word, or clear a filter."
          : "No restaurant here fits these filters. Try a wider search or clear a filter."
      }
      action={
        <Button variant="outline" onClick={onClear}>
          Clear filters
        </Button>
      }
    />
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn("press bolt-chip", on && "bolt-chip-on")}
    >
      {children}
    </button>
  );
}

function TabBtn({
  on,
  onClick,
  icon,
  children,
}: {
  on: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "press flex flex-1 items-center justify-center gap-1.5 rounded-full py-2",
        on ? "bg-surface text-ink shadow-[var(--shadow-sm)]" : "text-muted"
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function SortBtn({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "press shrink-0 whitespace-nowrap rounded-full px-2.5 py-1.5",
        on ? "bg-surface text-ink shadow-[var(--shadow-sm)]" : "text-muted"
      )}
    >
      {children}
    </button>
  );
}
