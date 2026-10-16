"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Heart, Loader2, Search, Share } from "lucide-react";
import { useMenuSearch } from "@/stores/menu-search-store";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/components/providers/lang-provider";

/**
 * The three circular controls on the restaurant hero. They were decorative
 * spans; each now does the thing its icon promises.
 *
 * Favourite is optimistic — the heart fills on tap and rolls back if the write
 * fails, because a heart that waits on a round trip feels broken. Signed-out
 * visitors are sent to log in instead: a favourite has to belong to someone.
 */
export function RestaurantActions({
  slug,
  name,
  tagline,
  initialFavorite,
  signedIn,
}: Readonly<{
  slug: string;
  name: string;
  tagline: string;
  initialFavorite: boolean;
  signedIn: boolean;
}>) {
  const router = useRouter();
  const t = useT();
  const [favorite, setFavorite] = useState(initialFavorite);
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchOpen = useMenuSearch((s) => s.open);
  const toggleSearch = useMenuSearch((s) => s.toggle);

  // No effect syncing `favorite` back to `initialFavorite`: the page keys this
  // component by slug, so navigating to another restaurant remounts it with that
  // restaurant's answer rather than carrying the last heart over.

  useEffect(() => {
    if (!shared && !error) return;
    const timer = setTimeout(() => {
      setShared(false);
      setError(null);
    }, 2200);
    return () => clearTimeout(timer);
  }, [shared, error]);

  async function toggleFavorite() {
    if (!signedIn) {
      router.push(`/login?next=/restaurant/${slug}`);
      return;
    }

    const next = !favorite;
    setFavorite(next); // optimistic
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/favorites", {
        method: next ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) {
        setFavorite(!next); // roll back
        setError(
          res.status === 401
            ? t(
                "Sign in to save favourites.",
                "पसंदीदा सेव करने के लिए लॉग इन करें।",
              )
            : t("Couldn't save that.", "सेव नहीं हो पाया।"),
        );
        return;
      }
      router.refresh(); // keep the Profile tab's count honest
    } catch {
      setFavorite(!next);
      setError(t("Couldn't save that.", "सेव नहीं हो पाया।"));
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    const url = typeof window === "undefined" ? "" : window.location.href;
    const payload = { title: name, text: tagline || `${name} on Deligro`, url };

    // The native sheet on phones; clipboard is the desktop/unsupported fallback.
    if (navigator.share) {
      try {
        await navigator.share(payload);
        return;
      } catch {
        return; // user dismissed the sheet — not an error worth reporting
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setShared(true);
    } catch {
      setError(t("Couldn't copy the link.", "लिंक कॉपी नहीं हो पाया।"));
    }
  }

  return (
    <div className="absolute right-4 top-[calc(var(--status-h)+1rem)] flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={toggleFavorite}
          disabled={busy}
          aria-pressed={favorite}
          aria-label={
            favorite
              ? t(
                  `Remove ${name} from favourites`,
                  `${name} को पसंदीदा से हटाएं`,
                )
              : t(
                  `Save ${name} to favourites`,
                  `${name} को पसंदीदा में सेव करें`,
                )
          }
          className="press grid size-10 place-items-center rounded-full bg-surface text-ink shadow-[var(--shadow-md)]"
        >
          {busy ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Heart
              className={cn("size-5", favorite && "fill-deal text-deal")}
            />
          )}
        </button>

        <button
          type="button"
          onClick={share}
          aria-label={t(`Share ${name}`, `${name} शेयर करें`)}
          className="press grid size-10 place-items-center rounded-full bg-surface text-ink shadow-[var(--shadow-md)]"
        >
          {shared ? (
            <Check className="size-5 text-green" />
          ) : (
            <Share className="size-5" />
          )}
        </button>

        <button
          type="button"
          onClick={toggleSearch}
          aria-pressed={searchOpen}
          aria-label={t("Search this menu", "इस मेन्यू में खोजें")}
          className={cn(
            "press grid size-10 place-items-center rounded-full shadow-[var(--shadow-md)]",
            searchOpen ? "bg-ink text-bg" : "bg-surface text-ink",
          )}
        >
          <Search className="size-5" />
        </button>
      </div>

      {shared || error ? (
        <span
          role="status"
          className="rounded-full bg-ink/85 px-3 py-1 text-[12px] font-semibold text-bg"
        >
          {error ?? t("Link copied", "लिंक कॉपी हो गया")}
        </span>
      ) : null}
    </div>
  );
}
