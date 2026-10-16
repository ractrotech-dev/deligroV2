"use client";

import { Check, X } from "lucide-react";
import { FOOD_CATEGORIES, type DishSort } from "@/lib/search/dishes";
import { formatINR } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { pick, type Bi, type Lang } from "@/lib/i18n/lang";
import { categoryLabel } from "@/lib/taxonomy";
import { useLang, useT } from "@/components/providers/lang-provider";

/**
 * Where the search controls went.
 *
 * The screen used to stack four horizontally-scrolling rows of identical
 * capsules — six quick filters, sixteen categories, five search suggestions and
 * four sort options — thirty-three controls between the search field and the
 * first dish, every one of them the same shape while doing five different jobs.
 * "Biryani" appeared twice, two rows apart: once as a filter and once as a word
 * to type, with nothing on screen saying which was which.
 *
 * Two things fix that and both are in here. The filters move behind one labelled
 * button, and inside they are **grouped under headings** — which is the part
 * that was actually missing. A diet chip and a delivery-time chip sat side by
 * side looking identical because nothing ever said they measured different
 * things.
 *
 * Edits apply live to the screen behind the sheet, so there is no draft state,
 * no Apply, and no question about whether a tap counted.
 */

/**
 * The cap behind the "Under ₹200" filter, in whole rupees. It lives beside the
 * label that quotes it, so the number on the button and the number the query
 * uses cannot drift apart.
 */
export const BUDGET_PRICE = 200;

/** The groups, in the order somebody narrows a food search. */
const FILTER_GROUPS: {
  heading: Bi;
  options: { id: string; label: Bi }[];
}[] = [
  {
    heading: { en: "Dietary", hi: "खान-पान" },
    options: [{ id: "veg", label: { en: "Pure Veg", hi: "शुद्ध शाकाहारी" } }],
  },
  {
    heading: { en: "Price & speed", hi: "दाम और समय" },
    options: [
      {
        id: "cheap",
        label: {
          en: `Under ${formatINR(BUDGET_PRICE)}`,
          hi: `${formatINR(BUDGET_PRICE)} से कम`,
        },
      },
      { id: "fast", label: { en: "Under 25 min", hi: "25 मिनट से कम" } },
    ],
  },
  {
    heading: { en: "Worth a look", hi: "ज़रूर देखें" },
    options: [
      {
        id: "popular",
        label: { en: "Bestsellers", hi: "सबसे ज़्यादा बिकने वाले" },
      },
      { id: "rating", label: { en: "Rating 4.5+", hi: "रेटिंग 4.5+" } },
      { id: "offers", label: { en: "Offers", hi: "ऑफ़र" } },
    ],
  },
];

/** Label for an id, for the removable tokens on the screen behind. */
export function filterLabel(id: string, lang: Lang): string {
  for (const g of FILTER_GROUPS) {
    const hit = g.options.find((o) => o.id === id);
    if (hit) return pick(lang, hit.label);
  }
  return id;
}

const SORTS: { id: DishSort; label: Bi; hint: Bi }[] = [
  {
    id: "relevance",
    label: { en: "Best match", hi: "सबसे सही" },
    hint: { en: "What fits your search", hi: "आपकी खोज से सबसे मेल खाते" },
  },
  {
    id: "price",
    label: { en: "Price", hi: "दाम" },
    hint: { en: "Cheapest first", hi: "सबसे सस्ते पहले" },
  },
  {
    id: "eta",
    label: { en: "Fastest", hi: "सबसे जल्दी" },
    hint: { en: "Shortest delivery time", hi: "सबसे कम डिलीवरी समय" },
  },
  {
    id: "rating",
    label: { en: "Top rated", hi: "सबसे अच्छी रेटिंग" },
    hint: { en: "Best-reviewed kitchens", hi: "सबसे अच्छे रिव्यू वाली रसोई" },
  },
];

export function sortLabel(sort: DishSort, lang: Lang): string {
  const hit = SORTS.find((s) => s.id === sort);
  return hit ? pick(lang, hit.label) : pick(lang, SORTS[0].label);
}

/** The sheet chrome both of these share. `fixed`, so it covers the phone. */
function Sheet({
  label,
  title,
  onClose,
  children,
  footer,
}: Readonly<{
  label: string;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}>) {
  const t = useT();
  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label={t("Close", "बंद करें")}
        onClick={onClose}
        className="animate-fade-in absolute inset-0 bg-ink/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="bolt-sheet animate-sheet-in absolute inset-x-0 bottom-0 flex max-h-[86%] flex-col overflow-hidden"
      >
        <div className="bolt-sheet-handle" />
        <div className="flex items-center justify-between px-5 pb-2 pt-3">
          <h2 className="text-heading">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close", "बंद करें")}
            className="press grid size-9 place-items-center rounded-full bg-surface-2 text-muted"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-5">
          {children}
        </div>
        {footer ? (
          <div className="border-t border-line px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SearchFilterSheet({
  chips,
  category,
  resultCount,
  resultKind,
  onToggleChip,
  onSetCategory,
  onClearAll,
  onClose,
}: Readonly<{
  chips: Set<string>;
  category: string | null;
  resultCount: number;
  /** Whichever tab is open behind the sheet. */
  resultKind: "dish" | "restaurant";
  onToggleChip: (id: string) => void;
  onSetCategory: (id: string | null) => void;
  onClearAll: () => void;
  onClose: () => void;
}>) {
  const { lang, t } = useLang();
  const active = chips.size + (category ? 1 : 0);
  const one = resultCount === 1;
  const showLabel =
    resultKind === "dish"
      ? t(
          `Show ${resultCount} ${one ? "dish" : "dishes"}`,
          `${resultCount} व्यंजन दिखाएं`,
        )
      : t(
          `Show ${resultCount} ${one ? "restaurant" : "restaurants"}`,
          `${resultCount} रेस्टोरेंट दिखाएं`,
        );

  return (
    <Sheet
      label={t("Filter results", "नतीजे छांटें")}
      title={t("Filters", "फ़िल्टर")}
      onClose={onClose}
      footer={
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClearAll}
            disabled={active === 0}
            className="press shrink-0 rounded-full border border-line bg-surface px-4 py-3 text-sm font-bold text-ink disabled:opacity-40"
          >
            {t("Clear all", "सब हटाएं")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="press flex-1 rounded-full bg-accent py-3 text-sm font-bold text-[var(--on-accent)] shadow-[var(--glow-accent)]"
          >
            {/* The count is live, because the list behind this sheet is too.
                It answers "will this leave me anything?" before the sheet is
                even closed. */}
            {showLabel}
          </button>
        </div>
      }
    >
      {FILTER_GROUPS.map((group) => (
        <section key={group.heading.en} className="border-b border-line py-3.5">
          <h3 className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">
            {pick(lang, group.heading)}
          </h3>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {group.options.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => onToggleChip(o.id)}
                aria-pressed={chips.has(o.id)}
                className={cn(
                  "press bolt-chip",
                  chips.has(o.id) && "bolt-chip-on",
                )}
              >
                {pick(lang, o.label)}
              </button>
            ))}
          </div>
        </section>
      ))}

      <section className="py-3.5">
        <h3 className="flex items-baseline gap-2 text-[12px] font-bold uppercase tracking-[0.08em] text-muted">
          {t("Category", "श्रेणी")}
          {/* Said out loud, because the shape does not say it: every other
              control in this sheet is a toggle and this one is a choice. */}
          <span className="font-medium normal-case tracking-normal">
            {t("pick one", "कोई एक चुनें")}
          </span>
        </h3>
        <div className="mt-2.5 flex flex-wrap gap-2 pb-2">
          {FOOD_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSetCategory(category === c.id ? null : c.id)}
              aria-pressed={category === c.id}
              className={cn(
                "press bolt-chip",
                category === c.id && "bolt-chip-on",
              )}
            >
              {categoryLabel(lang, c)}
            </button>
          ))}
        </div>
      </section>
    </Sheet>
  );
}

export function SearchSortSheet({
  sort,
  onPick,
  onClose,
}: Readonly<{
  sort: DishSort;
  onPick: (sort: DishSort) => void;
  onClose: () => void;
}>) {
  const { lang, t } = useLang();
  return (
    <Sheet
      label={t("Sort results", "नतीजों का क्रम")}
      title={t("Sort by", "क्रम चुनें")}
      onClose={onClose}
    >
      <ul className="divide-y divide-line pb-3">
        {SORTS.map((s) => {
          const on = s.id === sort;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(s.id);
                  onClose();
                }}
                aria-pressed={on}
                className="press flex w-full items-center gap-3 py-3.5 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block text-[15px]",
                      on ? "font-extrabold" : "font-semibold",
                    )}
                  >
                    {pick(lang, s.label)}
                  </span>
                  <span className="mt-0.5 block text-[13px] text-muted">
                    {pick(lang, s.hint)}
                  </span>
                </span>
                {on ? (
                  <Check
                    className="size-5 shrink-0 text-accent"
                    strokeWidth={3}
                  />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
