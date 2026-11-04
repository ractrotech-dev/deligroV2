import Link from "next/link";
import { Heart, Compass } from "lucide-react";
import { ProfileSubpage } from "@/components/profile/profile-subpage";
import { RestaurantCard } from "@/components/shared/restaurant-card";
import { requireUser } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { listFavoriteRestaurantsFromDb } from "@/lib/data-access/restaurants";
import type { Restaurant } from "@/types";
import { getT } from "@/lib/i18n/server";
import { customerFeatureOn } from "@/lib/features/guards.server";
import { FeatureOffNotice } from "@/components/features/features-provider";

// Per-request: reads the auth cookie to show this user's own saved restaurants.
export const dynamic = "force-dynamic";

export default async function FavoritesPage() {
  await requireUser();
  const t = await getT();

  if (!(await customerFeatureOn("customer.favorites"))) {
    return (
      <ProfileSubpage title={t("Favourites", "पसंदीदा")}>
        <FeatureOffNotice title={t("Favourites", "पसंदीदा")} />
      </ProfileSubpage>
    );
  }

  const favorites: Restaurant[] = isSupabaseConfigured
    ? await listFavoriteRestaurantsFromDb()
    : [];

  return (
    <ProfileSubpage title={t("Favourites", "पसंदीदा")}>
      {favorites.length === 0 ? (
        <div className="card p-6 text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-deal-soft text-deal">
            <Heart className="size-7" />
          </span>
          <p className="mt-4 text-[15px] font-bold">
            {t("No favourites yet", "अभी कोई पसंदीदा नहीं")}
          </p>
          <p className="mt-1 text-sm text-muted">
            {t(
              "Tap the heart on any restaurant to save it here.",
              "किसी भी रेस्टोरेंट पर दिल का निशान दबाएं, वह यहाँ सेव हो जाएगा।",
            )}
          </p>
          <Link
            href="/"
            className="press mt-4 inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-bold text-[var(--on-accent)]"
          >
            <Compass className="size-4" />{" "}
            {t("Explore restaurants", "रेस्टोरेंट देखें")}
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-5">
          {favorites.map((r) => (
            <RestaurantCard key={r.slug} restaurant={r} />
          ))}
        </div>
      )}
    </ProfileSubpage>
  );
}
