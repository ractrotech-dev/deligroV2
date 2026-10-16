import type { Metadata } from "next";
import Link from "next/link";
import { Store, TriangleAlert } from "lucide-react";
import { HomeHeader } from "@/components/home/home-header";
import { RestaurantCard } from "@/components/shared/restaurant-card";
import { EmptyState } from "@/components/shared/empty-state";
import { StoreCategoryStrip } from "@/components/stores/store-category-strip";
import { PickDropHero } from "@/components/stores/pick-drop-hero";
import { GroceryListHero } from "@/components/stores/grocery-list-hero";
import { listRestaurantsResult } from "@/lib/catalog";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { listAddresses } from "@/lib/data-access/addresses";
import { getSettings } from "@/lib/settings";
import { enabledStoreCategories } from "@/lib/store-categories";
import { ADDRESSES } from "@/lib/data";
import { categoryLabel } from "@/lib/taxonomy";
import { getLang } from "@/lib/i18n/server";
import { translator, type T } from "@/lib/i18n/lang";
import type { Restaurant } from "@/types";

// Canonical drops `?category=`, so filtered views fold into the one stores URL.
export const metadata: Metadata = {
  title: "Stores",
  alternates: { canonical: "/stores" },
};

export default async function StoresPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ category?: string }>;
}>) {
  const [{ category }, catalog, settings, addrs, lang] = await Promise.all([
    searchParams,
    // RestaurantCard (the only thing this page renders restaurants through)
    // never reads menu data — see listRestaurantsFromDb's doc comment.
    listRestaurantsResult({ withMenu: false }),
    getSettings(),
    isSupabaseConfigured
      ? listAddresses().catch(() => [])
      : Promise.resolve(ADDRESSES),
    getLang(),
  ]);
  const { restaurants } = catalog;
  const t = translator(lang);

  // Which storefront types the admin has switched on. The Settings toggles used
  // to be stored, validated, displayed — and read by nothing: switching
  // Groceries off to handle a supplier outage left the category, the hero and
  // the WhatsApp CTA fully live to customers, while the Settings page confirmed
  // the save.
  const categories = enabledStoreCategories(settings);

  const def = addrs.find((a) => a.isDefault) ?? addrs[0];
  // Demo-mode addresses carry no pin, so the coordinates are optional here.
  const pin = def as { lat?: number | null; lng?: number | null } | undefined;
  const savedAddress = def
    ? {
        label: def.label,
        line: def.line,
        lat: pin?.lat ?? null,
        lng: pin?.lng ?? null,
      }
    : null;

  // An unknown ?category= reads as "no filter" rather than "nothing matches" —
  // a stale link shouldn't land the user on an empty tab. A switched-off
  // category is unknown by the same rule, so a bookmarked /stores?category=
  // groceries link stops working the moment an admin turns it off, rather than
  // reaching a hero the platform is no longer serving.
  const active = categories.find((c) => c.id === category) ?? null;
  const activeLabel = active ? categoryLabel(lang, active) : null;

  /** Shops matching one category, by the rule the filter below uses. */
  const matching = (c: (typeof categories)[number]) =>
    restaurants.filter((r) =>
      r.cuisines.some((x) =>
        c.tags.some((t) => t.toLowerCase() === x.toLowerCase()),
      ),
    );

  /*
   * What is actually behind each tile.
   *
   * The taxonomy was written ahead of supply and it shows: of the six
   * storefront types, Dairy, Raw Meat and Chowpaty match no shop at all, so a
   * third of the strip is a tap into "we haven't onboarded one near you". The
   * counts let the strip mute those and let this page sort them last, rather
   * than leaving a customer to discover the dead ends one at a time.
   *
   * Groceries and Pick & Drop legitimately match nothing — they open their own
   * screens instead of a filtered list — so they are exempt.
   */
  const OWN_SCREEN = new Set(["groceries", "pick-drop"]);
  const counts = new Map(
    categories.map((c) => [
      c.id,
      { shops: matching(c).length, hasOwnScreen: OWN_SCREEN.has(c.id) },
    ]),
  );
  const ordered = [...categories].sort((a, b) => {
    const dead = (c: (typeof categories)[number]) =>
      counts.get(c.id)!.shops === 0 && !OWN_SCREEN.has(c.id) ? 1 : 0;
    return dead(a) - dead(b);
  });

  const inCategory = active ? matching(active) : restaurants;

  /*
   * Ordering, twice over, and neither is what it used to be.
   *
   * The shelf was sorted by `rating` descending. One shop out of fifty has ever
   * been rated, so for the other forty-nine that expression compares 0 to 0 and
   * the "top rated, open now" shelf was whatever order the database happened to
   * return. Soonest-arriving is a number we actually hold for every shop.
   *
   * The full list was sorted by `etaMin` alone, which interleaves shut kitchens
   * among open ones — and a closed shop's delivery estimate is a claim about a
   * kitchen that is not cooking. Open first, then soonest within each half.
   */
  const bySoonest = (a: { etaMin: number }, b: { etaMin: number }) =>
    a.etaMin - b.etaMin;
  const openNow = inCategory.filter((r) => r.open).sort(bySoonest);
  const closed = inCategory.filter((r) => !r.open).sort(bySoonest);
  const all = [...openNow, ...closed];
  const inActive = active ? `in ${active.label.toLowerCase()} ` : "";
  const pickDrop = active?.id === "pick-drop";

  return (
    <>
      <HomeHeader savedAddress={savedAddress} />

      <div className="space-y-7 pt-3">
        <section className="space-y-3">
          <h2 className="px-4 text-heading">{t("Categories", "श्रेणियाँ")}</h2>
          <StoreCategoryStrip
            active={active?.id}
            categories={ordered}
            counts={counts}
          />
        </section>

        {!catalog.ok ? (
          <div className="mx-4 flex items-start gap-2.5 rounded-2xl border border-deal/30 bg-deal-soft px-3 py-2.5 text-sm font-medium text-deal">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              {t(
                "We couldn't load stores just now. This is a problem on our side — try again in a moment.",
                "अभी दुकानें नहीं दिख पाईं। गड़बड़ी हमारी तरफ़ से है — थोड़ी देर बाद फिर कोशिश करें।",
              )}
            </span>
          </div>
        ) : null}

        {active?.id === "groceries" ? (
          // The number is the admin's, not a constant: a change of business
          // number or an ops handover used to leave grocery orders arriving at
          // a WhatsApp nobody was watching, with no way to redirect them.
          <GroceryListHero
            savedAddress={savedAddress}
            whatsappNumber={settings.supportWhatsapp}
          />
        ) : null}

        {pickDrop ? <PickDropHero /> : null}
        {!pickDrop && all.length === 0 ? (
          <NoStoresYet active={active} activeLabel={activeLabel} t={t} />
        ) : null}
        {!pickDrop && all.length > 0 ? (
          <StoreLists
            openNow={openNow}
            closed={closed}
            activeLabel={activeLabel}
            inActive={inActive}
            t={t}
          />
        ) : null}
      </div>
    </>
  );
}

function NoStoresYet({
  active,
  activeLabel,
  t,
}: Readonly<{
  active: { label: string } | null;
  activeLabel: string | null;
  t: T;
}>) {
  return (
    <EmptyState
      icon={<Store className="size-7" />}
      title={t(
        `No ${active?.label.toLowerCase() ?? "stores"} yet`,
        activeLabel
          ? `अभी कोई ${activeLabel} दुकान नहीं`
          : "अभी कोई दुकान नहीं",
      )}
      description={t(
        `We haven't onboarded a ${
          active?.label.toLowerCase() ?? "store"
        } near you. Browse everything else in the meantime.`,
        activeLabel
          ? `आपके पास अभी कोई ${activeLabel} दुकान नहीं जुड़ी है। तब तक बाकी सब देखें।`
          : "आपके पास अभी कोई दुकान नहीं जुड़ी है। थोड़ी देर बाद फिर देखें।",
      )}
      action={
        <Link
          href="/stores"
          className="press rounded-full bg-accent px-5 py-2.5 text-sm font-bold text-[var(--on-accent)] shadow-[var(--glow-accent)]"
        >
          {t("Show all stores", "सभी दुकानें देखें")}
        </Link>
      }
    />
  );
}

function StoreLists({
  openNow,
  closed,
  activeLabel,
  inActive,
  t,
}: Readonly<{
  openNow: Restaurant[];
  closed: Restaurant[];
  activeLabel: string | null;
  inActive: string;
  t: T;
}>) {
  return (
    /*
     * One list, split by the only question that decides whether a shop is
     * useful right now.
     *
     * This used to be a shelf of 72px avatars ("Open now", sorted by a
     * rating nobody has) followed by every shop again as a full card. Now
     * that the list itself leads with the open ones, the shelf was the
     * same eleven shops twice in a row — once as truncated names under
     * thumbnails, once as cards carrying the fee, the ETA and the
     * distance. The cards win; the shelf was costing a screenful to say
     * less.
     */
    <>
      {openNow.length ? (
        <section className="space-y-3">
          <h2 className="flex items-baseline gap-2 px-4 text-heading">
            {activeLabel ?? t("Open now", "अभी खुले हैं")}
            <span className="text-[13px] font-semibold text-muted">
              {openNow.length}
            </span>
          </h2>
          <div className="space-y-5 px-4">
            {openNow.map((r) => (
              <RestaurantCard key={r.slug} restaurant={r} />
            ))}
          </div>
        </section>
      ) : (
        /* Every shop in view is shut. Said once, at the top, rather than
           left for somebody to infer from a column of grey badges. */
        <p className="mx-4 rounded-2xl bg-surface-2 px-4 py-3 text-[13px] leading-snug text-muted">
          {t(
            `Nothing ${inActive}is open right now. The kitchens below are closed — you can still look at their menus.`,
            activeLabel
              ? `अभी ${activeLabel} में कुछ भी खुला नहीं है। नीचे की दुकानें बंद हैं — आप फिर भी उनका मेन्यू देख सकते हैं।`
              : "अभी कुछ भी खुला नहीं है। नीचे की दुकानें बंद हैं — आप फिर भी उनका मेन्यू देख सकते हैं।",
          )}
        </p>
      )}

      {closed.length ? (
        <section className="space-y-3">
          <h2 className="flex items-baseline gap-2 px-4 text-heading text-muted">
            {t("Closed right now", "अभी बंद हैं")}
            <span className="text-[13px] font-semibold">
              {closed.length}
            </span>
          </h2>
          <div className="space-y-5 px-4">
            {closed.map((r) => (
              <RestaurantCard key={r.slug} restaurant={r} />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
