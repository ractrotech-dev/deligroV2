"use client";

import { Star } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { formatCount, formatRating, isRated } from "@/lib/utils/format";
import { useT } from "@/components/providers/lang-provider";

export function RatingPill({
  rating,
  count,
  className,
  variant = "inline",
}: Readonly<{
  rating: number;
  count?: number;
  className?: string;
  /** "inline" = green text (in listings); "chip" = solid dark capsule for photo overlays (Bolt style). */
  variant?: "inline" | "chip";
}>) {
  const t = useT();
  // Unreviewed is its own answer. Without this the pill renders "★ 0.0" for
  // every shop nobody has rated — see `isRated`. `count` is optional here, so
  // a caller that passes none is taken at its word that the rating is real.
  if (count != null && !isRated(rating, count)) {
    return (
      <span
        className={cn(
          variant === "chip"
            ? "rating-chip"
            : "inline-flex items-center text-data font-bold text-muted",
          className,
        )}
      >
        {t("New", "नया")}
      </span>
    );
  }

  if (variant === "chip") {
    return (
      <span className={cn("rating-chip", className)}>
        <Star className="size-3.5 fill-pop text-pop" />
        {formatRating(rating)}
        {count != null ? (
          <span className="font-medium opacity-70">({formatCount(count)})</span>
        ) : null}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-data font-bold text-accent-ink",
        className,
      )}
    >
      <Star className="size-3.5 fill-accent text-accent" />
      {formatRating(rating)}
      {count != null ? (
        <span className="text-muted font-normal">({formatCount(count)})</span>
      ) : null}
    </span>
  );
}
