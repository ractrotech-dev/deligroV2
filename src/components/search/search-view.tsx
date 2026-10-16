"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Search,
  X,
  UtensilsCrossed,
  Store,
  TriangleAlert,
  SlidersHorizontal,
  ArrowUpDown,
  ChevronDown,
  Clock,
} from "lucide-react";
import type { Restaurant } from "@/types";
import {
  buildDishIndex,
  categoryBasis,
  groupByShop,
  searchCorrection,
  searchDishes,
  FOOD_CATEGORIES,
  type DishSort,
  type RankContext,
  type SearchFilters,
} from "@/lib/search/dishes";
import {
  SearchFilterSheet,
  SearchSortSheet,
  BUDGET_PRICE,
  filterLabel,
  sortLabel,
} from "@/components/search/search-sheets";
import { useLocation } from "@/stores/location-store";
import { useSearchHistory } from "@/stores/search-history-store";
import { focusOnMount } from "@/lib/utils/focus";
import { PINNED_LOCATION } from "@/lib/location/pinned";
import { DishCard } from "@/components/search/dish-card";
import { RestaurantCard } from "@/components/shared/restaurant-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import { categoryLabel } from "@/lib/taxonomy";
import { useLang, useT } from "@/components/providers/lang-provider";

type Tab = "dishes" | "shops";

/** Ceiling on the dish list. Long enough to scroll, short enough to render. */
const DISH_LIMIT = 60;

const SUGGESTIONS = [
  "Paneer",
  "Biryani",
  "Pizza",
  "Cold coffee",
  "Dosa",
] as const;

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
}: Readonly<{
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
}>) {
  const { lang, t } = useLang();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [tab, setTab] = useState<Tab>("dishes");
  const [sort, setSort] = useState<DishSort>("relevance");
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<string | null>(
    initialCategory ?? null,
  );
  const [sheet, setSheet] = useState<null | "filters" | "sort">(null);

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
    [chips, category],
  );

  // Ranking measures from wherever the customer is — the same origin the header
  // names and `ShopDistance` prints, so a row that reads "1.2 km" is a row that
  // was ranked as 1.2 km. Bemetara until they detect a fix or pick an address.
  const origin = useLocation((s) => s.coords) ?? PINNED_LOCATION.coords;
  const ctx = useMemo<RankContext>(
    () => ({ origin, rotationSeed }),
    [origin, rotationSeed],
  );

  const dishes = useMemo(
    () => searchDishes(index, deferredQuery, filters, sort, ctx),
    [index, deferredQuery, filters, sort, ctx],
  );

  const shops = useMemo(
    () => groupByShop(dishes, restaurants, deferredQuery, filters, sort),
    [dishes, restaurants, deferredQuery, filters, sort],
  );

  const toggleChip = (id: string) =>
    setChips((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * Clears the filters and leaves the words alone.
   *
   * It used to clear the query too, which is the opposite of what "Clear
   * filters" says and threw away the one thing the customer typed themselves.
   */
  const clearFilters = () => {
    setChips(new Set());
    setCategory(null);
  };

  const typed = deferredQuery.trim();

  /*
   * Remember what was searched for, once it has stopped moving.
   *
   * There is no submit on this screen — the list updates on every keystroke —
   * so "they meant this one" has to be inferred. Two conditions do it: the
   * words have been still for a beat, and they actually found something.
   * A query that returned nothing is not worth offering back to somebody
   * later, and the store collapses the prefixes typed on the way in.
   */
  const recordSearch = useSearchHistory((s) => s.record);
  const hydrateHistory = useSearchHistory((s) => s.hydrate);
  const history = useSearchHistory((s) => s.history);
  const removeSearch = useSearchHistory((s) => s.remove);
  const clearHistory = useSearchHistory((s) => s.clear);

  useEffect(() => hydrateHistory(), [hydrateHistory]);

  const foundSomething = dishes.length > 0;
  useEffect(() => {
    if (!typed || !foundSomething) return;
    const timer = window.setTimeout(() => recordSearch(typed), 900);
    return () => window.clearTimeout(timer);
  }, [typed, foundSomething, recordSearch]);

  const activeCount = chips.size + (category ? 1 : 0);
  const showSuggestions = !typed && !category && chips.size === 0;
  const shown = dishes.slice(0, DISH_LIMIT);

  const activeCategory = FOOD_CATEGORIES.find((c) => c.id === category) ?? null;
  const activeCategoryLabel = activeCategory
    ? categoryLabel(lang, activeCategory)
    : null;
  // A chip nothing on any menu actually matches is being answered by the shops'
  // cuisine tags instead. Say so — otherwise "Rolls" quietly lists milkshakes.
  const byCuisineOnly = categoryBasis(index, category) === "cuisine";
  const partial = Boolean(typed) && Boolean(shown[0]?.partial);

  // "panir tika" found Paneer Tikka by sound, not by spelling. Say which words
  // the list is answering, so a fuzzy result doesn't read as a wrong one.
  const correction = useMemo(
    () => (typed ? searchCorrection(index, deferredQuery, dishes) : null),
    [typed, index, deferredQuery, dishes],
  );

  // When a category chip is what emptied the screen, the useful thing to say is
  // not "nothing matches" — it is "there are 10 of these, just not under Thali".
  // Only computed when the screen is already empty and a category is on, so the
  // common path does no extra work.
  const withoutCategory = useMemo(() => {
    if (dishes.length || !category || !typed) return 0;
    return searchDishes(
      index,
      deferredQuery,
      { ...filters, category: null },
      sort,
      ctx,
    ).length;
  }, [
    dishes.length,
    category,
    typed,
    index,
    deferredQuery,
    filters,
    sort,
    ctx,
  ]);

  const restaurantsWord = shops.length === 1 ? "restaurant" : "restaurants";

  // The list itself, or why it is empty.
  function results() {
    if (tab === "dishes") {
      return shown.length ? (
        <div className="mt-1 divide-y divide-line">
          {shown.map((hit) => (
            <DishCard key={hit.key} hit={hit} />
          ))}
        </div>
      ) : (
        <NoResults
          query={typed}
          onClear={clearFilters}
          kind="dish"
          categoryLabel={activeCategoryLabel}
          elsewhere={withoutCategory}
          onDropCategory={() => setCategory(null)}
        />
      );
    }
    return shops.length ? (
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
                {t("Serves", "मिलता है:")}{" "}
                <span className="font-semibold text-ink">
                  {shop.dishes
                    .slice(0, 3)
                    .map((d) => d.item.name)
                    .join(", ")}
                </span>
                {shop.dishes.length > 3
                  ? t(
                      ` +${shop.dishes.length - 3} more`,
                      ` +${shop.dishes.length - 3} और`,
                    )
                  : ""}
              </Link>
            ) : null}
          </div>
        ))}
      </div>
    ) : (
      <NoResults query={typed} onClear={clearFilters} kind="restaurant" />
    );
  }

  return (
    <div>
      {/* z-30, matching the restaurant menu's sticky category strip: the dish
          photos below carry z-20 so their ADD pill can overhang the row, and
          sticky chrome has to out-rank them outright. z-20 here merely TIED
          with those photos, and a tie is settled by DOM order — which puts the
          scrolling list on top, so pills painted over the search field. */}
      <div className="app-header sticky top-0 z-30 px-4 pb-3 pt-3">
        <div className="bolt-search">
          <Search className="size-5 shrink-0" />
          <input
            ref={focusOnMount}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t(
              "Search for a dish, cuisine or restaurant",
              "खाना या रेस्टोरेंट खोजें",
            )}
            aria-label={t(
              "Search for a dish, cuisine or restaurant",
              "खाना या रेस्टोरेंट खोजें",
            )}
          />
          {query ? (
            <button
              onClick={() => setQuery("")}
              aria-label={t("Clear", "मिटाएं")}
              className="press grid size-6 shrink-0 place-items-center rounded-full bg-surface text-muted"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>

        {/* A segmented control, not two buttons that happen to touch.
            
            The selected half is carried by a thumb that SLIDES rather than a
            pill that teleports, which is the difference between "a button lit
            up" and "a control moved" — and it makes the relationship legible:
            one object with one indicator.

            Geometry is exact rather than tuned. The track pads 4px, the thumb
            is `50% - 4px`, and it travels exactly its own width — so in
            position two its right edge lands on the track's inner right edge
            to the pixel, at any width, with nothing to re-tune when the labels
            change length. */}
        <div className="relative mt-2.5 flex rounded-full bg-surface-2 p-1 text-[13px] font-bold shadow-[inset_0_1px_2px_rgb(0_0_0/0.07)]">
          <span
            aria-hidden
            style={{
              transform: tab === "shops" ? "translateX(100%)" : "translateX(0)",
            }}
            /* Recessed track, raised thumb: the thing that moves has to read as
               sitting on top of the thing it moves along, or the motion is just
               a coloured rectangle sliding about. The easing overshoots a shade
               and settles — linear over the same duration reads as a slide,
               this reads as a snap. */
            className="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-accent shadow-[var(--glow-accent)] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
          />
          <TabBtn
            on={tab === "dishes"}
            onClick={() => setTab("dishes")}
            icon={<UtensilsCrossed className="size-4" />}
            count={dishes.length}
          >
            {t("Dishes", "व्यंजन")}
          </TabBtn>
          <TabBtn
            on={tab === "shops"}
            onClick={() => setTab("shops")}
            icon={<Store className="size-4" />}
            count={shops.length}
          >
            {t("Restaurants", "रेस्टोरेंट")}
          </TabBtn>
        </div>
      </div>

      <div className="px-4 pt-3">
        {catalogFailed ? (
          <div className="mb-3 flex items-start gap-2.5 rounded-2xl border border-deal/30 bg-deal-soft px-3 py-2.5 text-sm font-medium text-deal">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              {t(
                "We couldn't load the catalog just now. This is a problem on our side — try again in a moment.",
                "अभी सूची नहीं खुल पाई। गड़बड़ी हमारी तरफ़ से है — थोड़ी देर बाद फिर कोशिश करें।",
              )}
            </span>
          </div>
        ) : null}

        {/* What this device searched for before, which beats a fixed guess at
            what a market wants. Only on the untouched screen: once somebody is
            typing, their own words are the subject and their old ones are in
            the way. */}
        {showSuggestions && history.length ? (
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[13px] font-bold uppercase tracking-[0.06em] text-muted">
                {t("Recent", "हाल की खोज")}
              </p>
              <button
                type="button"
                onClick={clearHistory}
                className="press text-[13px] font-bold text-muted underline"
              >
                {t("Clear", "मिटाएं")}
              </button>
            </div>
            <ul className="mt-1 divide-y divide-line">
              {history.map((term) => (
                <li key={term} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setQuery(term)}
                    className="press flex min-w-0 flex-1 items-center gap-2.5 py-2.5 text-left"
                  >
                    <Clock className="size-4 shrink-0 text-muted" />
                    <span className="truncate text-[15px] font-semibold">
                      {term}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeSearch(term)}
                    aria-label={t(`Forget ${term}`, `${term} हटाएं`)}
                    className="press grid size-8 shrink-0 place-items-center rounded-full text-muted"
                  >
                    <X className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* These type a word into the field, which is why they sit against it
            rather than down among the controls that narrow results. They used
            to be capsules two rows below the filters, and two of them
            ("Biryani", "Pizza") were also category chips — the same word,
            identical, doing two different things. A magnifier on each says
            which one this is. */}
        {showSuggestions ? (
          <div className={history.length ? "mt-4" : ""}>
            <p className="text-[13px] font-bold uppercase tracking-[0.06em] text-muted">
              {t("Try searching", "यह खोजें")}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
              {SUGGESTIONS.map((term) => (
                <button
                  key={term}
                  type="button"
                  onClick={() => setQuery(term)}
                  className="press tap-target flex items-center gap-1.5 py-1.5 text-[15px] font-semibold text-ink"
                >
                  <Search className="size-3.5 shrink-0 text-muted" />
                  {term}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* One row of two labelled controls, where four scrolling rows of
            identical capsules used to be. A bordered button with a chevron
            reads as "this opens something"; a filled capsule reads as "this is
            on" — and the old screen used the second shape for both, plus for
            switching tabs and for typing a word. */}
        <div
          className={cn("flex items-center gap-2", showSuggestions && "mt-5")}
        >
          <button
            type="button"
            onClick={() => setSheet("filters")}
            aria-haspopup="dialog"
            className={cn(
              "press flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13px] font-bold",
              activeCount
                ? "border-ink bg-ink text-bg"
                : "border-line bg-surface text-ink",
            )}
          >
            <SlidersHorizontal className="size-4" />
            {t("Filters", "फ़िल्टर")}
            {activeCount ? (
              <span className="grid size-5 place-items-center rounded-full bg-bg text-[11px] text-ink">
                {activeCount}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            onClick={() => setSheet("sort")}
            aria-haspopup="dialog"
            className="press flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-bold text-ink"
          >
            <ArrowUpDown className="size-4 shrink-0" />
            <span className="truncate">{sortLabel(sort, lang)}</span>
            <ChevronDown className="size-4 shrink-0 text-muted" />
          </button>
        </div>

        {/* The only capsules left on this screen, and now they mean exactly one
            thing: this is on, tap the × to take it off. Nothing was on screen
            before to say which filters were active — the two strips scrolled
            sideways and clipped mid-word, so a chip you turned on could simply
            be out of view. */}
        {activeCount ? (
          <div className="no-scrollbar -mx-4 mt-2 flex items-center gap-2 overflow-x-auto px-4">
            {[...chips].map((id) => (
              <Token key={id} onRemove={() => toggleChip(id)}>
                {filterLabel(id, lang)}
              </Token>
            ))}
            {activeCategoryLabel ? (
              <Token onRemove={() => setCategory(null)}>
                {activeCategoryLabel}
              </Token>
            ) : null}
            <button
              type="button"
              onClick={clearFilters}
              className="press shrink-0 whitespace-nowrap px-1 text-[13px] font-bold text-muted underline"
            >
              {t("Clear all", "सब हटाएं")}
            </button>
          </div>
        ) : null}

        {/* Only once the customer has actually narrowed something. "3157
            dishes" above an unfiltered list is a number nobody asked for — and
            it used to be truncated to "3157 dish…" anyway, because a four-way
            sort control was sharing the line with it. */}
        {typed || activeCount ? (
          <p className="mt-4 text-sm font-medium text-muted">
            {tab === "dishes" ? (
              <>
                {t(
                  `${dishes.length.toLocaleString("en-IN")} ${dishes.length === 1 ? "dish" : "dishes"}`,
                  `${dishes.length.toLocaleString("en-IN")} व्यंजन`,
                )}
                {dishes.length > DISH_LIMIT
                  ? t(
                      ` · showing top ${DISH_LIMIT}`,
                      ` · ऊपर के ${DISH_LIMIT} दिख रहे हैं`,
                    )
                  : ""}
              </>
            ) : (
              t(
                `${shops.length} ${restaurantsWord}`,
                `${shops.length} रेस्टोरेंट`,
              )
            )}
          </p>
        ) : null}

        {!typed && tab === "dishes" && shown.length ? (
          <h2 className="mt-4 text-[17px] font-extrabold tracking-tight">
            {activeCategoryLabel ??
              t("Popular dishes near you", "पास के लोकप्रिय व्यंजन")}
          </h2>
        ) : null}

        {byCuisineOnly && activeCategory && activeCategoryLabel ? (
          <p className="mt-2 text-[13px] font-medium leading-snug text-muted">
            {t(
              `No dish near you is listed as ${activeCategory.label.toLowerCase()} yet — showing what these kitchens do serve.`,
              `पास में अभी कोई व्यंजन "${activeCategoryLabel}" में नहीं है — ये रसोई जो बनाती हैं, वह दिखा रहे हैं।`,
            )}
          </p>
        ) : null}

        {correction ? (
          <p className="mt-3 text-[13px] font-medium leading-snug text-muted">
            {t("Showing results for", "इसके नतीजे दिखा रहे हैं:")}{" "}
            <span className="font-bold text-ink">
              &ldquo;{correction}&rdquo;
            </span>
          </p>
        ) : null}

        {partial ? (
          <p className="mt-3 text-[13px] font-medium leading-snug text-muted">
            {t(
              `Nothing is called “${typed}” exactly. These are the closest dishes.`,
              `ठीक “${typed}” नाम का कुछ नहीं मिला। ये सबसे मिलते-जुलते व्यंजन हैं।`,
            )}
          </p>
        ) : null}

        {results()}
      </div>

      {sheet === "filters" ? (
        <SearchFilterSheet
          chips={chips}
          category={category}
          resultCount={tab === "dishes" ? dishes.length : shops.length}
          resultKind={tab === "dishes" ? "dish" : "restaurant"}
          onToggleChip={toggleChip}
          onSetCategory={setCategory}
          onClearAll={clearFilters}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {sheet === "sort" ? (
        <SearchSortSheet
          sort={sort}
          onPick={setSort}
          onClose={() => setSheet(null)}
        />
      ) : null}
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
}: Readonly<{
  query: string;
  onClear: () => void;
  kind: "dish" | "restaurant";
  /** The category chip that is on, when one is. */
  categoryLabel?: string | null;
  /** How many dishes this same query finds with that chip off. */
  elsewhere?: number;
  onDropCategory?: () => void;
}>) {
  // The category is the reason the screen is empty, and we know exactly how many
  // results dropping it would bring back. Saying "no Thali matches EGG BIRYANI,
  // but 10 other dishes do" answers the question the blank screen provokes;
  // "nothing matches" next to a list of chips leaves someone to guess which one
  // to poke. Worth the extra sentence for a first-time smartphone user.
  const blockedByCategory = Boolean(categoryLabel) && elsewhere > 0;
  const t = useT();

  if (blockedByCategory) {
    return (
      <EmptyState
        className="mt-6"
        icon={<Search className="size-7" />}
        title={t(
          `No ${categoryLabel} matches “${query}”`,
          `“${query}” ${categoryLabel} में नहीं मिला`,
        )}
        description={t(
          `But ${elsewhere} other ${
            elsewhere === 1 ? "dish matches" : "dishes match"
          } — they're just not ${categoryLabel}.`,
          `पर ${elsewhere} दूसरे व्यंजन मिले — बस वे ${categoryLabel} में नहीं हैं।`,
        )}
        action={
          <Button onClick={onDropCategory}>
            {t(
              `Show all ${elsewhere} ${elsewhere === 1 ? "result" : "results"}`,
              `सभी ${elsewhere} नतीजे दिखाएं`,
            )}
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      className="mt-6"
      icon={<Search className="size-7" />}
      title={
        query
          ? t(`Nothing called “${query}” yet`, `“${query}” अभी नहीं मिला`)
          : t("Nothing matches — yet", "अभी कुछ नहीं मिला")
      }
      description={
        kind === "dish"
          ? t(
              "No kitchen near you is cooking that right now. Try a shorter word, or clear a filter.",
              "अभी पास में कोई रसोई यह नहीं बना रही। छोटा शब्द लिखकर देखें, या कोई फ़िल्टर हटाएं।",
            )
          : t(
              "No restaurant here fits these filters. Try a wider search or clear a filter.",
              "इन फ़िल्टर से कोई रेस्टोरेंट नहीं मिला। कुछ और खोजें या कोई फ़िल्टर हटाएं।",
            )
      }
      action={
        <Button variant="outline" onClick={onClear}>
          {t("Clear filters", "फ़िल्टर हटाएं")}
        </Button>
      }
    />
  );
}

function TabBtn({
  on,
  onClick,
  icon,
  count,
  children,
}: Readonly<{
  on: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  /** Shown beside the label, quieter than it — it is context, not the name. */
  count: number;
  children: React.ReactNode;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        // `relative z-10` is load-bearing, not decoration: the thumb is
        // absolutely positioned and therefore paints above static siblings, so
        // without this the label and icon sit *behind* the orange pill.
        // Colour changes slower than the thumb moves, so the label settles just
        // after it arrives rather than racing ahead of it.
        "press relative z-10 flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full py-2 transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
        on ? "text-[var(--on-accent)]" : "text-muted",
      )}
    >
      {icon}
      {children}
      {/* Was "Dishes (3,157)" — the count in parentheses at the label's own
          weight, so a four-digit number shouted as loudly as the word it
          qualifies. Same information, one step down in emphasis. */}
      <span className={cn("font-semibold", on && "opacity-90")}>
        {count.toLocaleString("en-IN")}
      </span>
    </button>
  );
}

function Token({
  children,
  onRemove,
}: Readonly<{
  children: React.ReactNode;
  onRemove: () => void;
}>) {
  const t = useT();
  return (
    /* Written out rather than built on `.bolt-chip`: that class is unlayered
       CSS with a `padding` shorthand, so a Tailwind utility in @layer
       utilities cannot trim the right side for the × without an important
       modifier. A token is its own thing anyway — a chip you remove, not a
       chip you toggle. */
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-ink bg-ink py-1 pl-3 pr-1 text-[13px] font-semibold text-bg">
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t(
          `Remove ${String(children)} filter`,
          `${String(children)} फ़िल्टर हटाएं`,
        )}
        className="press grid size-5 place-items-center rounded-full bg-bg/25"
      >
        <X className="size-3.5" strokeWidth={3} />
      </button>
    </span>
  );
}
