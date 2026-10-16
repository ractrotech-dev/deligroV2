"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Banner } from "@/types";
import { bannerHref, bannerIsExternal } from "@/lib/banner-href";
import { PhotoTile } from "@/components/shared/photo-tile";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/components/providers/lang-provider";

const MIN_MS = 3000;
const MAX_MS = 8000;

/** Fire-and-forget analytics ping. Never blocks or throws into the UI. */
function track(
  bannerId: string,
  kind: "impression" | "click",
  placement: string,
) {
  const body = JSON.stringify({ bannerId, kind, placement });
  try {
    if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
      navigator.sendBeacon(
        "/api/banners/track",
        new Blob([body], { type: "application/json" }),
      );
      return;
    }
    void fetch("/api/banners/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    });
  } catch {
    // analytics is best-effort — a blocked beacon must not surface to the user
  }
}

/**
 * The home promotional carousel. Renders whatever campaigns the backend served
 * for its placement — it hardcodes nothing. Auto-advances (per-banner cadence),
 * supports native swipe, shows pagination dots and a "Sponsored" badge on paid
 * slots, and logs an impression per slide plus a click on the CTA.
 *
 * `analytics={false}` renders the same slide without logging anything. The admin
 * previews are the reason: they mount this component precisely so what an
 * operator sees cannot drift from what a customer sees, but every mount was
 * posting a real impression — so opening the edit screen inflated the campaign's
 * own "Shown" figure, and the CTR shown on the campaigns page was measured
 * partly against admins looking at it.
 */
export function PromoBannerCarousel({
  banners,
  placement = "home_hero",
  analytics = true,
}: Readonly<{
  banners: Banner[];
  placement?: string;
  /** Set false for admin previews — renders identically, records nothing. */
  analytics?: boolean;
}>) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  // Suspends auto-advance while the user is touching or hovering the carousel.
  const paused = useRef(false);
  // One impression per banner per mount.
  const impressed = useRef<Set<string>>(new Set());

  const count = banners.length;

  const logImpression = useCallback(
    (i: number) => {
      if (!analytics) return;
      const b = banners[i];
      if (!b || impressed.current.has(b.id)) return;
      impressed.current.add(b.id);
      track(b.id, "impression", placement);
    },
    [banners, placement, analytics],
  );

  // Derive the active index from scroll position — keeps dots in sync with a
  // manual swipe and with programmatic auto-advance alike.
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    setIndex((prev) => (prev === i ? prev : i));
  }, []);

  const goTo = useCallback((i: number) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  }, []);

  // First slide's impression fires on mount.
  useEffect(() => {
    logImpression(0);
  }, [logImpression]);

  // Log the impression whenever the active slide settles on a new banner.
  useEffect(() => {
    logImpression(index);
  }, [index, logImpression]);

  // Auto-advance. Cadence follows the *current* banner, clamped to 3–8s. Pauses
  // when the tab is hidden or the user is interacting; loops back to the start.
  useEffect(() => {
    if (count <= 1) return;
    const current = banners[index];
    const ms = Math.min(MAX_MS, Math.max(MIN_MS, current?.autoSlideMs ?? 4500));
    const id = window.setInterval(() => {
      if (paused.current || document.hidden) return;
      const next = (index + 1) % count;
      goTo(next);
    }, ms);
    return () => window.clearInterval(id);
  }, [index, count, banners, goTo]);

  if (count === 0) return null;

  const hold = () => (paused.current = true);
  const release = () => (paused.current = false);

  return (
    <div className="px-4">
      <div
        className="relative"
        onMouseEnter={hold}
        onMouseLeave={release}
        onTouchStart={hold}
        onTouchEnd={release}
      >
        <div
          ref={scroller}
          onScroll={onScroll}
          className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto scroll-smooth rounded-2xl"
          style={{ scrollbarWidth: "none" }}
        >
          {banners.map((b, i) => (
            <BannerSlide
              key={b.id}
              banner={b}
              // Only the first slide is guaranteed to be in the initial
              // viewport — later ones are lazy, same as everything else.
              priority={i === 0}
              onCta={() => {
                if (analytics) track(b.id, "click", placement);
              }}
            />
          ))}
        </div>

        {count > 1 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
            {banners.map((b, i) => (
              <button
                key={b.id}
                type="button"
                aria-label={t(
                  `Go to slide ${i + 1}`,
                  `स्लाइड ${i + 1} पर जाएं`,
                )}
                onClick={() => goTo(i)}
                className={cn(
                  "pointer-events-auto h-1.5 rounded-full bg-white/60 transition-all duration-300",
                  i === index ? "w-5 bg-white" : "w-1.5",
                )}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BannerSlide({
  banner,
  onCta,
  priority = false,
}: Readonly<{
  banner: Banner;
  onCta: () => void;
  priority?: boolean;
}>) {
  const href = bannerHref(banner);
  const external = bannerIsExternal(banner);
  const sponsored = banner.kind === "sponsored";
  const t = useT();

  return (
    <div className="w-full shrink-0 snap-start snap-always">
      <Link
        href={href}
        onClick={onCta}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className="press relative flex h-40 items-stretch overflow-hidden rounded-2xl"
      >
        {/* Full-bleed art with the gradient tint underneath while it loads. */}
        <PhotoTile
          tint={banner.tint}
          src={banner.mobileImageUrl ?? banner.imageUrl}
          alt={banner.headline}
          className="absolute inset-0 h-full w-full"
          sizes="100vw"
          priority={priority}
        />
        {/* Scrim so text stays legible over any photo. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(90deg, rgba(6,8,10,0.82) 0%, rgba(6,8,10,0.5) 45%, rgba(6,8,10,0.08) 100%)",
          }}
        />

        {sponsored ? (
          <span className="absolute right-3 top-3 rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.06em] text-white/90 backdrop-blur-sm">
            {t("Sponsored", "प्रायोजित")}
            {banner.sponsorName ? ` · ${banner.sponsorName}` : ""}
          </span>
        ) : null}

        <div className="relative z-10 flex max-w-[76%] flex-col justify-center gap-1.5 p-5">
          {banner.glyph ? (
            <span className="text-2xl leading-none drop-shadow-sm">
              {banner.glyph}
            </span>
          ) : null}
          <p className="text-[18px] font-extrabold leading-tight tracking-tight text-white">
            {banner.headline}
          </p>
          <p className="line-clamp-2 text-[13px] font-medium leading-snug text-white/80">
            {banner.description}
          </p>
          <span className="press mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-white px-3.5 py-1.5 text-[13px] font-bold text-[#0e1417] shadow-sm">
            {banner.ctaLabel}
            <ArrowRight className="size-3.5" />
          </span>
        </div>
      </Link>
    </div>
  );
}
