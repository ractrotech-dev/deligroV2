import type { Metadata } from "next";
import { Suspense } from "react";
import { SearchView } from "@/components/search/search-view";
import { listRestaurantsResult } from "@/lib/catalog";
import { dailyRotationSeed } from "@/lib/search/rotation";
import { slimCatalogForSearch } from "@/lib/search/slim-catalog";

// Canonical drops `?q=` / `?category=`, so every query folds into one URL.
export const metadata: Metadata = {
  title: "Search",
  alternates: { canonical: "/search" },
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; q?: string }>;
}) {
  const [{ category, q }, catalog] = await Promise.all([
    searchParams,
    listRestaurantsResult(),
  ]);

  return (
    <Suspense>
      <SearchView
        initialCategory={category}
        initialQuery={q}
        restaurants={slimCatalogForSearch(catalog.restaurants)}
        // A failed catalog read must not render as "nothing matches your
        // search" — see HomePage/StoresPage, which already say which one it is.
        catalogFailed={!catalog.ok}
        rotationSeed={dailyRotationSeed()}
      />
    </Suspense>
  );
}
